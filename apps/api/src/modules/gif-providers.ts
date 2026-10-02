/**
 * Proveedores de GIFs y memes (docs/GIFS.md): armar la petición y normalizar la respuesta de cada uno.
 * Funciones puras (sin red, base ni configuración) para probarlas con respuestas simuladas.
 *
 * - KLIPY: normalización heredada, deshabilitada en el servicio activo.
 * - Openverse (sin clave): GIFs animados con licencia CC de Wikimedia Commons; catálogo pequeño, exige atribución.
 * - memegen.link /templates (sin clave, software libre MIT): ~200 plantillas de memes; el texto se dibuja en el cliente.
 *
 * `mint(url, kind, attribution)` convierte cada URL del proveedor en una URL de nuestro dominio (token cifrado);
 * los ítems cuyo archivo no está en un host permitido se descartan aquí mismo.
 */
import type { GifItemDTO, GifProvider } from '@tiecoms/contracts';

export type MediaKind = 'p' | 'f'; // p = vista previa de la cuadrícula; f = archivo para enviar / plantilla
export type Mint = (provider: GifProvider, url: string, kind: MediaKind, attribution: string | null, title: string, provenance?: import('@tiecoms/contracts').AttachmentProvenanceDTO) => string;

export const KLIPY_API = 'https://api.klipy.com/v2';
export const OPENVERSE_API = 'https://api.openverse.org/v1/images/';
export const MEMEGEN_API = 'https://api.memegen.link/templates/';
export const PAGE_SIZE = 24;
/** Openverse sin credenciales no deja pedir más de 20 por página. */
export const OPENVERSE_PAGE = 20;
/** Búsqueda fija para «Tendencias» en Openverse (no tiene tendencias): los stickers animados oficiales de Wikimedia. */
export const OPENVERSE_TRENDING_QUERY = 'giphy stickers';
/** Contenido apto para el trabajo: KLIPY/Tenor contentfilter=medium (≈ PG-13 sin desnudos). Openverse: mature=false. */
export const KLIPY_CONTENT_FILTER = 'medium';

// ---------- Hosts permitidos (anti-SSRF: el proxy solo baja archivos de aquí) ----------
const MEDIA_HOSTS: Record<GifProvider, (host: string, path: string) => boolean> = {
  klipy: (h) => h === 'klipy.com' || h.endsWith('.klipy.com'),
  openverse: (h, p) => h === 'upload.wikimedia.org' && p.startsWith('/wikipedia/commons/'),
  memegen: (h, p) => h === 'api.memegen.link' && p.startsWith('/images/'),
};
/** Solo https, puerto por defecto, sin credenciales y en un host del proveedor. */
export function isAllowedMediaUrl(provider: GifProvider, raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) return false;
  const check = MEDIA_HOSTS[provider];
  return !!check && check(u.hostname.toLowerCase(), u.pathname);
}

// ---------- KLIPY ----------
/** es → es_CO, en → en_US (KLIPY pide idioma_PAÍS). */
export const klipyLocale = (lang?: 'es' | 'en') => (lang === 'en' ? 'en_US' : 'es_CO');

export function klipyUrl(kind: 'search' | 'trending', key: string, opts: { q?: string; lang?: 'es' | 'en'; cursor?: string; customerId: string }) {
  const p = new URLSearchParams({
    key, client_key: 'chaggu', limit: String(PAGE_SIZE), locale: klipyLocale(opts.lang), contentfilter: KLIPY_CONTENT_FILTER,
    media_filter: 'tinygif,nanogif,mediumgif,gif', customer_id: opts.customerId,
  });
  if (kind === 'search' && opts.q) p.set('q', opts.q);
  if (opts.cursor) p.set('pos', opts.cursor);
  return `${KLIPY_API}/${kind === 'search' ? 'search' : 'featured'}?${p}`;
}

interface KlipyMedia { url?: string; dims?: [number, number]; size?: number }
/** Por encima de esto se prefiere mediumgif al gif completo al enviar. */
const KLIPY_FULL_MAX = 6 * 1024 * 1024;

export function normalizeKlipy(json: any, mint: Mint): { items: GifItemDTO[]; next: string | null } {
  const items: GifItemDTO[] = [];
  for (const r of Array.isArray(json?.results) ? json.results : []) {
    const f = (r?.media_formats ?? {}) as Record<string, KlipyMedia>;
    const preview = [f.tinygif, f.nanogif, f.mediumgif, f.gif].find((m) => m?.url && isAllowedMediaUrl('klipy', m.url));
    const full = [f.gif && (f.gif.size ?? 0) <= KLIPY_FULL_MAX ? f.gif : undefined, f.mediumgif, f.gif, f.tinygif].find((m) => m?.url && isAllowedMediaUrl('klipy', m.url));
    if (!preview?.url || !full?.url) continue;
    const [w, h] = dims(full.dims) ?? dims(preview.dims) ?? [0, 0];
    if (!w || !h) continue;
    const title = cleanTitle(r.title || r.content_description || 'GIF');
    const attribution = 'GIF vía KLIPY';
    items.push({
      id: `klipy:${String(r.id ?? '').slice(0, 64)}`, provider: 'klipy', title,
      previewUrl: mint('klipy', preview.url, 'p', null, title), url: mint('klipy', full.url, 'f', attribution, title, { version: 1, provider: 'klipy', title, attribution, sourceUrl: null }),
      width: w, height: h, attribution, sourceUrl: typeof r.itemurl === 'string' && isAllowedMediaUrl('klipy', r.itemurl) ? r.itemurl : null,
    });
  }
  const next = typeof json?.next === 'string' && json.next && json.next !== '0' && items.length ? json.next.slice(0, 200) : null;
  return { items, next };
}

// ---------- Openverse (Wikimedia Commons) ----------
export function openverseUrl(opts: { q: string; page: number }) {
  const p = new URLSearchParams({
    q: opts.q, extension: 'gif', source: 'wikimedia', license: 'by,by-sa,cc0,pdm', mature: 'false',
    page_size: String(OPENVERSE_PAGE), page: String(opts.page),
  });
  return `${OPENVERSE_API}?${p}`;
}

/** Miniatura de Wikimedia (animada para GIFs). Anchos estándar: los demás los limita Wikimedia. */
export function wikimediaThumb(url: string, width: number, original: number): string {
  if (!original || original <= width) return url;
  const m = /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/([0-9a-f])\/([0-9a-f]{2})\/([^/?#]+)$/.exec(url);
  if (!m) return url;
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${m[1]}/${m[2]}/${m[3]}/${width}px-${m[3]}`;
}

export function licenseLabel(license: string, version?: string | null): string {
  const l = String(license || '').toLowerCase();
  if (l === 'cc0') return 'CC0';
  if (l === 'pdm') return 'Dominio público';
  return `CC ${l.toUpperCase()}${version ? ` ${version}` : ''}`;
}

/** Wikimedia pone «File:…gif» o «Nombre - Autor - Wikimedia Giphy stickers 2019»; se deja un título corto. */
export function cleanTitle(raw: string): string {
  return String(raw).replace(/^File:/i, '').replace(/\s+-\s+[^-]+-\s+Wikimedia Giphy stickers \d{4}.*$/i, '').replace(/\.(gif|webp|png|jpe?g)$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'GIF';
}

function cleanCreator(raw: unknown): string | null {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  // «No machine-readable author provided. Fulano assumed (based on copyright claims).»
  const assumed = /^No machine-readable author provided\.\s*(.+?) assumed/i.exec(s);
  return (assumed ? assumed[1]! : s).slice(0, 60) || null;
}

/** Enlaces de procedencia públicos. Nunca se descargan ni reciben credenciales. */
function provenanceUrl(raw: unknown, host?: string): string | null {
  if (typeof raw !== 'string' || raw.length > 1200 || /[\s<>]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || (host && u.hostname !== host)) return null;
    if (!u.hostname.includes('.') || /^[\d.]+$/.test(u.hostname) || u.hostname.startsWith('[')) return null;
    return u.toString();
  } catch { return null; }
}
function licenseUrl(license: string, version: unknown): string | null {
  if (license === 'cc0') return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (license === 'pdm') return 'https://creativecommons.org/publicdomain/mark/1.0/';
  if (['1.0', '2.0', '2.5', '3.0', '4.0'].includes(String(version))) return `https://creativecommons.org/licenses/${license}/${version}/`;
  return null;
}

/** Wikimedia no genera miniaturas animadas de GIFs muy grandes (responde 404) y las que genera pesan demasiado. */
const OPENVERSE_MAX_BYTES = 8 * 1024 * 1024;
const OPENVERSE_PREVIEW_W = 250;
const OPENVERSE_SEND_W = 500;

export function normalizeOpenverse(json: any, mint: Mint, page: number): { items: GifItemDTO[]; next: string | null } {
  const items: GifItemDTO[] = [];
  for (const r of Array.isArray(json?.results) ? json.results : []) {
    const url = String(r?.url ?? '');
    if (!isAllowedMediaUrl('openverse', url) || !/\.gif$/i.test(url)) continue;
    if (r.mature) continue;
    if (!['by', 'by-sa', 'cc0', 'pdm'].includes(String(r.license))) continue;
    if (r.filesize && Number(r.filesize) > OPENVERSE_MAX_BYTES) continue;
    const w = Number(r.width) || 0, h = Number(r.height) || 0;
    if (!w || !h) continue;
    const title = cleanTitle(r.title || 'GIF');
    const creator = cleanCreator(r.creator);
    const sourceUrl = provenanceUrl(r.foreign_landing_url, 'commons.wikimedia.org') ?? url;
    const licenseLink = licenseUrl(r.license, r.license_version);
    const attribution = [`GIF: «${title}»`, creator, licenseLabel(r.license, r.license_version), 'Wikimedia Commons (vía Openverse)', `Fuente: ${sourceUrl}`, licenseLink ? `Licencia: ${licenseLink}` : null].filter(Boolean).join(' · ');
    const sendW = Math.min(w, OPENVERSE_SEND_W);
    items.push({
      id: `openverse:${String(r.id ?? '').slice(0, 64)}`, provider: 'openverse', title,
      previewUrl: mint('openverse', wikimediaThumb(url, OPENVERSE_PREVIEW_W, w), 'p', null, title),
      url: mint('openverse', wikimediaThumb(url, OPENVERSE_SEND_W, w), 'f', attribution, title, { version: 1, provider: 'openverse', title, attribution, sourceUrl, author: creator, license: licenseLabel(r.license, r.license_version), licenseUrl: licenseLink }),
      width: sendW, height: Math.round((h * sendW) / w), attribution,
      sourceUrl,
    });
  }
  const pageCount = Number(json?.page_count) || 0;
  return { items, next: page < pageCount && (json?.results?.length ?? 0) >= OPENVERSE_PAGE ? String(page + 1) : null };
}

// ---------- memegen.link (plantillas de memes) ----------
/** memegen no da el tamaño de cada plantilla: se usa un cuadro neutro (la imagen real se mide al abrir el editor). */
const MEMEGEN_BOX = 400;
export function normalizeMemegen(json: any, mint: Mint): GifItemDTO[] {
  const out: GifItemDTO[] = [];
  const seen = new Set<string>();
  for (const m of Array.isArray(json) ? json : []) {
    const url = String(m?.blank ?? '');
    const ok = /^https:\/\/api\.memegen\.link\/images\/([a-z0-9_-]{1,40})\.(jpg|jpeg|png)$/i.exec(url);
    if (!ok || !isAllowedMediaUrl('memegen', url)) continue;
    // Algunas variantes del catálogo comparten la misma imagen base. Todos los
    // clientes usan este ID para sus tarjetas: mantenerlo único evita que una
    // tarjeta anterior sobreviva al cambiar el filtro.
    const id = `memegen:${ok[1]!.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const title = String(m.name ?? 'Meme').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Meme';
    const lines = Math.min(6, Math.max(1, Number(m.lines) || 2));
    const sourceUrl = provenanceUrl(m.source);
    const attribution = `Meme: «${title}» · Plantilla vía memegen.link${sourceUrl ? ` · Fuente: ${sourceUrl}` : ''} · Texto añadido en Chaggu`;
    // memegen redimensiona con ?width= (la vista previa pesa unos 10 KB; la plantilla para el editor, ≤ 800 px).
    out.push({
      id, provider: 'memegen', title,
      previewUrl: mint('memegen', `${url}?width=300`, 'p', null, title), url: mint('memegen', `${url}?width=800`, 'f', attribution, title, { version: 1, provider: 'memegen', title, attribution, sourceUrl }),
      width: MEMEGEN_BOX, height: MEMEGEN_BOX, attribution, sourceUrl, boxCount: lines,
    });
  }
  return out;
}

function dims(d: unknown): [number, number] | null {
  if (!Array.isArray(d) || d.length < 2) return null;
  const w = Math.round(Number(d[0])), h = Math.round(Number(d[1]));
  return w > 0 && h > 0 && w <= 8192 && h <= 8192 ? [w, h] : null;
}

/** Nombre de archivo del adjunto a partir del título. */
export function gifFileName(title: string, ext: string) {
  const base = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${base || 'gif'}.${ext}`;
}
