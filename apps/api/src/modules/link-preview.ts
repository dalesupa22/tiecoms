/**
 * Vista previa de enlaces: el worker lee la página (título, descripción, sitio,
 * imagen) y guarda la miniatura en S3, así los clientes no cargan nada de
 * terceros (ni les filtran su IP). Pensado contra SSRF: solo http/https a los
 * puertos 80/443, nunca a IPs privadas, locales o de metadatos, validado en cada
 * conexión (también tras redirecciones), con tiempo y tamaño máximos.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LinkKind, LinkPreviewDTO, LinkProvider } from '@tiecoms/contracts';
import { pool, tx } from '../db.ts';
import { objectKey, putObject, storageEnabled } from '../storage.ts';
import { appendEvent, toMessageDTO } from './messages.ts';
import { classifyUrl, extractUrls } from './links.ts';

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/i;
// YouTube pone og:type y la duración pasados los 700 KB del HTML.
const HTML_MAX = 1024 * 1024;
const IMAGE_MAX = 2 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const CACHE_HOURS = 24;
const UA = 'Mozilla/5.0 (compatible; TieComsBot/1.0; +https://www.tiecoms.com)';
/** Redes que solo sirven etiquetas og: a los rastreadores de vistas previas conocidos. */
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const MAX_PREVIEWS = 3;

/** Primer enlace del texto, sin la puntuación que suele ir pegada al final. */
export function firstUrl(text: string): string | null {
  const m = text.match(URL_RE);
  if (!m) return null;
  let u = m[0].replace(/[.,;:!?¿¡)\]}»”’]+$/u, '');
  // Paréntesis balanceados (p. ej. Wikipedia).
  if ((u.match(/\(/g)?.length ?? 0) > (u.match(/\)/g)?.length ?? 0) && m[0].startsWith(u + ')')) u += ')';
  try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : null; } catch { return null; }
}

// ---------- Red ----------
export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false; // enlace local y metadatos de la nube
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return false;
    if (v.startsWith('::ffff:')) return isPublicIp(v.slice(7));
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff')) return false;
    return true;
  }
  return false;
}

/** DNS que solo devuelve direcciones públicas: se usa en cada conexión, así un cambio de DNS no cuela una IP interna. */
const safeLookup: net.LookupFunction = (hostname, options, cb) => {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (cb as any)(err);
    const ok = (addresses as { address: string; family: number }[]).filter((a) => isPublicIp(a.address));
    if (!ok.length) return (cb as any)(Object.assign(new Error('Dirección no permitida'), { code: 'EBLOCKED' }));
    if ((options as any).all) return (cb as any)(null, ok);
    (cb as any)(null, ok[0]!.address, ok[0]!.family);
  });
};

interface Got { url: string; status: number; type: string; body: Buffer }

function getOnce(target: URL, accept: string, max: number, ua = UA): Promise<Got & { location?: string }> {
  return new Promise((resolve, reject) => {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return reject(new Error('Protocolo no permitido'));
    if (target.port && !['80', '443'].includes(target.port)) return reject(new Error('Puerto no permitido'));
    if (target.username || target.password) return reject(new Error('URL con credenciales'));
    if (net.isIP(target.hostname.replace(/^\[|\]$/g, '')) && !isPublicIp(target.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('Dirección no permitida'));
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.get(target, {
      lookup: safeLookup, timeout: TIMEOUT_MS,
      headers: { 'user-agent': ua, accept, 'accept-language': 'es,en;q=0.8', 'accept-encoding': 'identity' },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return resolve({ url: target.toString(), status, type: '', body: Buffer.alloc(0), location: res.headers.location }); }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > max) { chunks.push(c.subarray(0, Math.max(0, max - (size - c.length)))); res.destroy(); return; }
        chunks.push(c);
      });
      const done = () => resolve({ url: target.toString(), status, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) });
      res.on('end', done);
      res.on('close', done);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo agotado')));
    req.on('error', reject);
  });
}

async function safeGet(url: string, accept: string, max: number, ua = UA): Promise<Got> {
  let target = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    const r = await getOnce(target, accept, max, ua);
    if (!r.location) return r;
    target = new URL(r.location, target);
  }
  throw new Error('Demasiadas redirecciones');
}

// ---------- HTML ----------
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+|#39);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
  .replace(/\s+/g, ' ').trim();

export function parseMeta(html: string) {
  const head = html.slice(0, 1_000_000);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (n: string) => tag.match(new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    const key = (attr('property') ?? attr('name') ?? attr('itemprop'))?.slice(2).find(Boolean)?.toLowerCase();
    const val = attr('content')?.slice(2).find((x) => x !== undefined);
    if (key && val && !meta.has(key)) meta.set(key, decode(val));
  }
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v && v.length) ?? null;
  return {
    title: pick('og:title', 'twitter:title') ?? (title ? decode(title) : null),
    description: pick('og:description', 'twitter:description', 'description'),
    siteName: pick('og:site_name', 'application-name', 'twitter:site'),
    image: pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image'),
    type: pick('og:type'),
    author: pick('article:author', 'author', 'twitter:creator'),
    duration: pick('video:duration', 'og:video:duration', 'duration', 'music:duration') ?? head.match(/"lengthSeconds":"(\d+)"/)?.[1] ?? null,
  };
}

/** «PT4M13S», «253» → segundos. */
export function parseDuration(v: string | null | undefined): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v)) { const n = Number(v); return n > 0 && n < 86_400 * 2 ? n : null; }
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(v.trim());
  if (!m || !m.slice(1).some(Boolean)) return null;
  const s = Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Math.round(Number(m[4] ?? 0));
  return s > 0 ? s : null;
}

/** og:type → tipo, cuando el dominio no lo dice. */
function kindFromOg(type: string | null): LinkKind | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t.startsWith('video')) return 'video';
  if (t.startsWith('music')) return 'audio';
  if (t === 'article' || t.startsWith('article')) return 'article';
  return null;
}

// ---------- oEmbed de las plataformas ----------
interface OEmbed { title: string | null; author: string | null; thumbnail: string | null; description: string | null }

/** Endpoint oEmbed público por plataforma (Instagram exige un token de app de Meta: META_OEMBED_TOKEN). */
export function oembedEndpoint(provider: LinkProvider | null, url: string): string | null {
  const q = encodeURIComponent(url);
  switch (provider) {
    case 'youtube': return `https://www.youtube.com/oembed?format=json&url=${q}`;
    case 'tiktok': return `https://www.tiktok.com/oembed?url=${q}`;
    case 'vimeo': return `https://vimeo.com/api/oembed.json?url=${q}`;
    case 'spotify': return `https://open.spotify.com/oembed?url=${q}`;
    case 'x': return `https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${q}`;
    case 'instagram': return process.env.META_OEMBED_TOKEN ? `https://graph.facebook.com/v21.0/instagram_oembed?omitscript=true&url=${q}&access_token=${encodeURIComponent(process.env.META_OEMBED_TOKEN)}` : null;
    default: return null;
  }
}

async function oembed(provider: LinkProvider | null, url: string): Promise<OEmbed | null> {
  const endpoint = oembedEndpoint(provider, url);
  if (!endpoint) return null;
  try {
    const r = await safeGet(endpoint, 'application/json', 256 * 1024);
    if (r.status >= 400) return null;
    const j: any = JSON.parse(r.body.toString('utf8'));
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? decode(v) : null);
    // X solo trae el HTML del tuit: el texto va como descripción.
    const tweet = provider === 'x' && typeof j.html === 'string' ? decode(String(j.html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '').replace(/<[^>]+>/g, ' ')) : null;
    return { title: str(j.title), author: str(j.author_name), thumbnail: str(j.thumbnail_url), description: tweet || null };
  } catch (e: any) { console.log(`[preview] oembed ${provider}: ${e?.message}`); return null; }
}

/** HTML de una página (para el resumen con IA). null si no es HTML. */
export async function fetchPage(url: string): Promise<string | null> {
  const page = await safeGet(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', HTML_MAX);
  if (page.status >= 400 || !(/html|xml/.test(page.type) || !page.type)) return null;
  return charsetOf(page.type, page.body).decode(page.body);
}

function charsetOf(type: string, body: Buffer) {
  const fromHeader = type.match(/charset=([\w-]+)/i)?.[1];
  const fromMeta = body.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  const cs = (fromHeader ?? fromMeta ?? 'utf-8').toLowerCase();
  try { return new TextDecoder(cs); } catch { return new TextDecoder('utf-8'); }
}

function sniffImage(b: Buffer): { type: string; ext: string } | null {
  if (b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return { type: 'image/png', ext: 'png' };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (b.length > 6 && b.toString('ascii', 0, 3) === 'GIF') return { type: 'image/gif', ext: 'gif' };
  return null;
}

const clip = (s: string | null, n: number) => (s ? (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s) : null);

async function storeImage(imageUrl: string, base: string, reuse?: Got): Promise<string | null> {
  if (!storageEnabled()) return null;
  try {
    const imgUrl = new URL(imageUrl, base).toString();
    const img = reuse ?? await safeGet(imgUrl, 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8', IMAGE_MAX);
    const kind = img.status < 400 && img.body.length < IMAGE_MAX ? sniffImage(img.body) : null;
    if (!kind) return null;
    const id = randomUUID();
    const key = objectKey(`previews/${id}.${kind.ext}`);
    await putObject(key, img.body, kind.type);
    await pool.query("INSERT INTO files (id, owner_id, purpose, s3_key, content_type, size_bytes) VALUES ($1, NULL, 'preview', $2, $3, $4)", [id, key, kind.type, img.body.length]);
    return `/api/v1/previews/${id}`;
  } catch (e: any) { console.log(`[preview] sin imagen para ${new URL(base).hostname}: ${e?.message}`); return null; }
}

/**
 * Lee la página (y el oEmbed de la plataforma si lo hay) y arma la vista previa (null si no hay nada que mostrar).
 * TikTok e Instagram suelen bloquear a los bots: el oEmbed oficial y el agente de vistas previas de Facebook
 * son lo que sí responden.
 */
export async function buildPreview(url: string): Promise<LinkPreviewDTO | null> {
  const cls = classifyUrl(url);
  const oe = await oembed(cls.provider, url);
  let finalUrl = url;
  let meta: ReturnType<typeof parseMeta> = { title: null, description: null, siteName: null, image: null, type: null, author: null, duration: null };
  let imagePage: Got | undefined;
  // TikTok con oEmbed ya trae todo (su página es una app de JavaScript).
  if (!(cls.provider === 'tiktok' && oe?.title)) {
    try {
      const ua = ['instagram', 'facebook', 'tiktok', 'x', 'linkedin'].includes(cls.provider ?? '') ? CRAWLER_UA : UA;
      const page = await safeGet(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', HTML_MAX, ua);
      finalUrl = page.url;
      if (page.status < 400) {
        if (/^image\//.test(page.type)) { meta = { ...meta, siteName: cls.host, image: finalUrl }; imagePage = page; }
        else if (/html|xml/.test(page.type) || !page.type) meta = parseMeta(charsetOf(page.type, page.body).decode(page.body));
        else if (!oe) return null;
      } else if (!oe) return null;
    } catch (e) { if (!oe) throw e; }
  }
  const host = new URL(finalUrl).hostname.replace(/^www\./, '');
  const image = oe?.thumbnail ?? meta.image;
  const imageUrl = image ? await storeImage(image, finalUrl, imagePage) : null;
  // Una red que no sirve la publicación devuelve su propio nombre como título: eso no es una vista previa.
  const generic = !oe?.title && cls.provider && meta.title && /^(instagram|tiktok|x|twitter|facebook|linkedin|youtube)$/i.test(meta.title.trim()) && !meta.description;
  const title = clip(oe?.title ?? (generic ? null : meta.title), 200);
  const description = clip(oe?.description ?? meta.description, 300);
  if (!title && !description && !imageUrl) return null;
  const kind: LinkKind = cls.kind !== 'link' ? cls.kind : kindFromOg(meta.type) ?? (imagePage ? 'image' : 'link');
  const author = clip(oe?.author ?? (meta.author && !/^https?:/.test(meta.author) ? meta.author : null), 80);
  return {
    url: finalUrl, title, description, siteName: clip(meta.siteName, 80) ?? host, imageUrl,
    kind, provider: cls.provider, author, durationSec: parseDuration(meta.duration),
  };
}

const hashUrl = (u: string) => createHash('sha256').update(u).digest();

/** Vista previa de una URL, desde la caché de 24 h o leyendo la página. */
async function previewFor(url: string): Promise<LinkPreviewDTO | null> {
  const cached = await pool.query(`SELECT status, data FROM link_previews WHERE url_hash = $1 AND fetched_at > now() - make_interval(hours => $2)`, [hashUrl(url), CACHE_HOURS]);
  if (cached.rows[0]) return cached.rows[0].status === 'ok' ? cached.rows[0].data : null;
  let status: 'ok' | 'empty' | 'failed' = 'empty';
  let data: LinkPreviewDTO | null = null;
  try { data = await buildPreview(url); status = data ? 'ok' : 'empty'; } catch (e: any) { status = 'failed'; console.log(`[preview] ${new URL(url).hostname}: ${e?.message}`); }
  await pool.query(
    `INSERT INTO link_previews (url_hash, url, status, data) VALUES ($1,$2,$3,$4)
     ON CONFLICT (url_hash) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, fetched_at = now()`,
    [hashUrl(url), url, status, data ? JSON.stringify(data) : null],
  );
  return data;
}

/** Job del worker: vistas previas de los primeros 3 enlaces del mensaje; avisa a la conversación y completa la biblioteca. */
export async function previewMessage(messageId: string) {
  const { rows } = await pool.query("SELECT id, body, kind, deleted_at FROM messages WHERE id = $1", [messageId]);
  const m = rows[0];
  if (!m || m.kind !== 'text' || m.deleted_at) return;
  const urls = extractUrls(m.body, MAX_PREVIEWS);
  const found: (LinkPreviewDTO | null)[] = [];
  for (const url of urls) found.push(await previewFor(url));
  await tx(async (c) => {
    // El texto pudo cambiar mientras se leía la página: solo se guarda si siguen siendo los mismos enlaces.
    const cur = await c.query('SELECT * FROM messages WHERE id = $1 FOR UPDATE', [messageId]);
    const row = cur.rows[0];
    if (!row || row.deleted_at || JSON.stringify(extractUrls(row.body, MAX_PREVIEWS)) !== JSON.stringify(urls)) return;
    const ids = new Map<number, string>();
    for (const [i, url] of urls.entries()) {
      const u = await c.query('UPDATE message_links SET preview = $3 WHERE message_id = $1 AND url = $2 AND position = $4 RETURNING id', [messageId, url, found[i] ? JSON.stringify(found[i]) : null, i]);
      if (u.rows[0]) ids.set(i, u.rows[0].id);
    }
    // En el mensaje, cada vista previa lleva su id de la biblioteca (para «Ver después» y el resumen desde la tarjeta).
    const withId = found.map((p, i) => (p ? { ...p, ...(ids.has(i) ? { linkId: ids.get(i) } : {}) } : null));
    const first = withId[0] ?? null;
    const list = withId.filter(Boolean) as LinkPreviewDTO[];
    if (JSON.stringify(row.link_preview ?? null) === JSON.stringify(first) && JSON.stringify(row.link_previews ?? []) === JSON.stringify(list)) return;
    const up = await c.query('UPDATE messages SET link_preview = $2, link_previews = $3 WHERE id = $1 RETURNING *', [messageId, first ? JSON.stringify(first) : null, list.length ? JSON.stringify(list) : null]);
    await appendEvent(c, row.conversation_id, { type: 'message.updated', conversationId: row.conversation_id, message: toMessageDTO(up.rows[0]) }, messageId);
  });
}

export async function readPreviewImage(fileId: string) {
  const { rows } = await pool.query("SELECT s3_key FROM files WHERE id = $1 AND purpose = 'preview' AND deleted_at IS NULL", [fileId]);
  return rows[0]?.s3_key as string | undefined;
}
