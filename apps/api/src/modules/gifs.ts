/**
 * GIFs y memes (docs/GIFS.md): búsqueda y tendencias (KLIPY con clave, u Openverse sin clave), plantillas de
 * memes (Imgflip) y un proxy de imágenes para que los clientes nunca hablen con el proveedor.
 *
 * - Las URLs de imagen que ven los clientes son /api/v1/gifs/media?t=<token>: el token va cifrado y autenticado
 *   (AES-256-GCM con una llave derivada de JWT_SECRET), así nadie puede pedirle al proxy otra URL, y la URL del
 *   proveedor (que podría llevar la clave) no sale del servidor.
 * - El proxy solo baja archivos https de los hosts del proveedor (también tras redirecciones), por el DNS que
 *   rechaza IPs privadas (link-preview.ts › safeLookup), con tope de tamaño y solo imágenes GIF/WebP/PNG/JPEG.
 * - Caché en memoria LRU acotada: respuestas JSON normalizadas y bytes de imagen.
 * - Enviar: el servidor baja el GIF y lo guarda como adjunto de imagen normal en S3 (attachments.upload),
 *   así lo ven todas las apps sin cambios y sigue ahí aunque el proveedor lo borre.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GifSearchQuery, GifTrendingQuery, SendGifInput, type GifListDTO, type GifProvider, type SendGifResult } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { config } from '../config.ts';
import { pool } from '../db.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { ByteLru } from '../lru.ts';
import { sniffImage, upload } from './attachments.ts';
import { getOnce } from './link-preview.ts';
import {
  IMGFLIP_API, OPENVERSE_TRENDING_QUERY, gifFileName, isAllowedMediaUrl, klipyUrl, normalizeImgflip, normalizeKlipy, normalizeOpenverse, openverseUrl,
  type MediaKind, type Mint,
} from './gif-providers.ts';

const UA = 'Chaggu/1.0 (+https://www.chaggu.com; GIF picker)';
/** Vista previa ≤ 4 MB; para enviar ≤ 10 MB (un adjunto admite 25 MB, pero un GIF más grande no tiene sentido en un chat). */
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
export const MAX_GIF_BYTES = 10 * 1024 * 1024;
const JSON_MAX = 2 * 1024 * 1024;
const MEDIA_TYPES = new Set(['image/gif', 'image/webp', 'image/png', 'image/jpeg']);

const klipyKey = () => (process.env.KLIPY_API_KEY ?? '').trim();
/** Proveedor de GIFs activo: KLIPY si hay clave; si no, Openverse (sin clave). GIFS_PROVIDER=off lo apaga. */
export function gifProvider(): GifProvider | null {
  const want = (process.env.GIFS_PROVIDER ?? '').trim().toLowerCase();
  if (want === 'off') return null;
  if (want === 'openverse') return 'openverse';
  return klipyKey() ? 'klipy' : 'openverse';
}
export const memesEnabled = () => (process.env.MEMES_PROVIDER ?? '').trim().toLowerCase() !== 'off';

// ---------- Red (reemplazable en pruebas) ----------
export interface Fetched { status: number; type: string; body: Buffer }
/** GET con tope de bytes. isAllowed decide cada salto (redirecciones incluidas). Rechaza si el cuerpo pasa de max. */
export type Upstream = (url: string, accept: string, max: number, isAllowed: (u: string) => boolean) => Promise<Fetched>;

type Hop = (target: URL, accept: string, max: number, ua: string) => Promise<{ status: number; type: string; body: Buffer; location?: string }>;
/** Sigue hasta 3 redirecciones validando cada salto con isAllowed; getOnce corta el cuerpo en max + 1 bytes. */
export async function fetchAllowed(hop: Hop, url: string, accept: string, max: number, isAllowed: (u: string) => boolean): Promise<Fetched> {
  let target = new URL(url);
  for (let n = 0; n < 4; n++) {
    if (!isAllowed(target.toString())) throw new ApiError(502, 'gifs_blocked', 'Host no permitido');
    const r = await hop(target, accept, max + 1, UA);
    if (!r.location) {
      if (r.body.length > max) throw new ApiError(413, 'too_large', 'El GIF es demasiado grande');
      return { status: r.status, type: r.type, body: r.body };
    }
    target = new URL(r.location, target);
  }
  throw new ApiError(502, 'gifs_unavailable', 'Demasiadas redirecciones');
}
const realUpstream: Upstream = (url, accept, max, isAllowed) => fetchAllowed(getOnce, url, accept, max, isAllowed);
let upstream: Upstream = realUpstream;
/** Solo pruebas: respuestas simuladas del proveedor. */
export function setUpstreamForTests(fn: Upstream | null) { upstream = fn ?? realUpstream; }

const API_HOSTS = new Set(['api.klipy.com', 'api.openverse.org', 'api.imgflip.com']);
const isApiUrl = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' && !x.port && API_HOSTS.has(x.hostname); } catch { return false; } };

async function getJson(url: string): Promise<any> {
  let r: Fetched;
  try { r = await upstream(url, 'application/json', JSON_MAX, isApiUrl); } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(502, 'gifs_unavailable', 'El servicio de GIFs no responde');
  }
  if (r.status === 429) throw new ApiError(503, 'gifs_busy', 'El catálogo de GIFs está saturado, intenta en un momento');
  if (r.status < 200 || r.status >= 300) throw new ApiError(502, 'gifs_unavailable', 'El servicio de GIFs no responde');
  try { return JSON.parse(r.body.toString('utf8')); } catch { throw new ApiError(502, 'gifs_unavailable', 'Respuesta inválida del servicio de GIFs'); }
}

// ---------- Tokens de media ----------
interface MediaToken { u: string; p: GifProvider; k: MediaKind; a?: string | null; t?: string }
const tokenKey = () => createHash('sha256').update(`chaggu-gifs:${config.jwtSecret}`).digest();
/** IV derivado del contenido: la misma imagen da siempre el mismo token (el navegador la reutiliza de su caché). */
export function sealMedia(t: MediaToken): string {
  const plain = JSON.stringify(t);
  const iv = createHmac('sha256', tokenKey()).update(plain).digest().subarray(0, 12);
  const c = createCipheriv('aes-256-gcm', tokenKey(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}
export function openMedia(token: string): MediaToken | null {
  try {
    if (!/^[\w-]{40,3000}$/.test(token)) return null;
    const raw = Buffer.from(token, 'base64url');
    const d = createDecipheriv('aes-256-gcm', tokenKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const t = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')) as MediaToken;
    if (typeof t?.u !== 'string' || !['klipy', 'openverse', 'imgflip'].includes(t.p) || (t.k !== 'p' && t.k !== 'f')) return null;
    return t;
  } catch { return null; }
}
/** En la query (no en la ruta): Fastify limita los parámetros de ruta a 100 caracteres. */
const MEDIA_PREFIX = '/api/v1/gifs/media?t=';
const mint: Mint = (p, u, k, a, title) => `${MEDIA_PREFIX}${sealMedia({ u, p, k, ...(a ? { a } : {}), ...(k === 'f' ? { t: title } : {}) })}`;

// ---------- Cachés ----------
/** Respuestas normalizadas (JSON serializado). Búsquedas 10 min; tendencias 1 h; plantillas 6 h. */
const searchCache = new ByteLru<{ body: Buffer }>(400, 8 * 1024 * 1024, 10 * 60_000);
const trendingCache = new ByteLru<{ body: Buffer }>(40, 4 * 1024 * 1024, 60 * 60_000);
const templatesCache = new ByteLru<{ body: Buffer }>(4, 2 * 1024 * 1024, 6 * 60 * 60_000);
/** Bytes de imagen (vistas previas y GIFs enviados): 64 MB, 6 h. Lo que pase de ~21 MB no se guarda (ByteLru). */
export const mediaCache = new ByteLru<{ body: Buffer; contentType: string }>(600, 64 * 1024 * 1024, 6 * 60 * 60_000);
export function clearGifCachesForTests() {
  for (const c of [searchCache, trendingCache, templatesCache, mediaCache] as any[]) { c.map.clear(); c.bytes = 0; }
}

async function cachedList(cache: ByteLru<{ body: Buffer }>, key: string, load: () => Promise<GifListDTO>): Promise<GifListDTO> {
  const v = await cache.through(key, async () => ({ body: Buffer.from(JSON.stringify(await load())) }));
  return JSON.parse(v.body.toString('utf8')) as GifListDTO;
}

const KLIPY_POWERED = { label: 'Powered by KLIPY', url: 'https://klipy.com' };
const OPENVERSE_POWERED = { label: 'Wikimedia Commons · Openverse', url: 'https://openverse.org' };
/** KLIPY pide un id de usuario estable; se manda un hash (nunca el id real). */
const customerId = (userId: string) => createHash('sha256').update(`klipy:${config.jwtSecret}:${userId}`).digest('hex').slice(0, 24);
const pageOf = (cursor?: string) => { const n = Number(cursor ?? 1); return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 1; };

function requireProvider(): GifProvider {
  const p = gifProvider();
  if (!p) throw new ApiError(503, 'gifs_off', 'Los GIFs no están disponibles');
  return p;
}

export async function search(userId: string, q: z.infer<typeof GifSearchQuery>): Promise<GifListDTO> {
  const p = requireProvider();
  const query = q.q.replace(/\s+/g, ' ').trim().toLowerCase();
  if (p === 'klipy') {
    return cachedList(searchCache, `k:${q.lang ?? 'es'}:${query}:${q.cursor ?? ''}`, async () => {
      const r = normalizeKlipy(await getJson(klipyUrl('search', klipyKey(), { q: query, lang: q.lang, cursor: q.cursor, customerId: customerId(userId) })), mint);
      return { provider: 'klipy', ...r, poweredBy: KLIPY_POWERED };
    });
  }
  const page = pageOf(q.cursor);
  return cachedList(searchCache, `o:${query}:${page}`, async () => {
    const r = normalizeOpenverse(await getJson(openverseUrl({ q: query, page })), mint, page);
    return { provider: 'openverse', ...r, poweredBy: OPENVERSE_POWERED };
  });
}

export async function trending(userId: string, q: z.infer<typeof GifTrendingQuery>): Promise<GifListDTO> {
  const p = requireProvider();
  if (p === 'klipy') {
    // Las tendencias son iguales para todos: el customer_id es de la instancia, no del usuario (así se cachean).
    return cachedList(trendingCache, `k:${q.lang ?? 'es'}:${q.cursor ?? ''}`, async () => {
      const r = normalizeKlipy(await getJson(klipyUrl('trending', klipyKey(), { lang: q.lang, cursor: q.cursor, customerId: customerId('trending') })), mint);
      return { provider: 'klipy', ...r, poweredBy: KLIPY_POWERED };
    });
  }
  void userId;
  const page = pageOf(q.cursor);
  return cachedList(trendingCache, `o:${page}`, async () => {
    const r = normalizeOpenverse(await getJson(openverseUrl({ q: OPENVERSE_TRENDING_QUERY, page })), mint, page);
    return { provider: 'openverse', ...r, poweredBy: OPENVERSE_POWERED };
  });
}

export async function memeTemplates(): Promise<GifListDTO> {
  if (!memesEnabled()) throw new ApiError(503, 'memes_off', 'Los memes no están disponibles');
  return cachedList(templatesCache, 'imgflip', async () => {
    const json = await getJson(IMGFLIP_API);
    if (json?.success === false) throw new ApiError(502, 'gifs_unavailable', 'Imgflip no respondió');
    return { provider: 'imgflip', items: normalizeImgflip(json, mint), next: null, poweredBy: { label: 'Imgflip', url: 'https://imgflip.com' } };
  });
}

// ---------- Proxy de imágenes ----------
/** Pocas descargas a la vez por proveedor (Wikimedia responde 429 si se le piden 20 miniaturas nuevas juntas). */
const MEDIA_CONCURRENCY = 4;
const slots = new Map<GifProvider, { busy: number; queue: (() => void)[] }>();
async function withSlot<T>(p: GifProvider, fn: () => Promise<T>): Promise<T> {
  const s = slots.get(p) ?? slots.set(p, { busy: 0, queue: [] }).get(p)!;
  if (s.busy >= MEDIA_CONCURRENCY) await new Promise<void>((r) => s.queue.push(r));
  s.busy++;
  try { return await fn(); } finally { s.busy--; s.queue.shift()?.(); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readMedia(t: MediaToken): Promise<{ body: Buffer; contentType: string }> {
  if (!isAllowedMediaUrl(t.p, t.u)) throw notFound('Imagen');
  const max = t.k === 'p' ? MAX_PREVIEW_BYTES : MAX_GIF_BYTES;
  return mediaCache.through(`${t.k}:${t.u}`, () => withSlot(t.p, async () => {
    let r: Fetched | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { r = await upstream(t.u, 'image/gif,image/webp,image/*;q=0.8', max, (u) => isAllowedMediaUrl(t.p, u)); } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(502, 'gifs_unavailable', 'No se pudo traer la imagen');
      }
      // Saturado: un reintento corto (la miniatura suele quedar lista en el segundo intento).
      if ((r.status === 429 || r.status === 503) && attempt < 2) { await wait(800 * (attempt + 1)); continue; }
      break;
    }
    if (!r) throw new ApiError(502, 'gifs_unavailable', 'No se pudo traer la imagen');
    if (r.status === 404 || r.status === 410) throw notFound('Imagen');
    if (r.status < 200 || r.status >= 300) {
      console.warn('[gifs] el proveedor respondió', r.status, t.p, new URL(t.u).hostname);
      throw new ApiError(502, 'gifs_unavailable', 'No se pudo traer la imagen', { upstream: r.status });
    }
    const type = sniffImage(r.body);
    if (!type || !MEDIA_TYPES.has(type)) throw new ApiError(415, 'not_image', 'El archivo no es una imagen');
    return { body: r.body, contentType: type };
  }));
}

export function tokenFromUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url.trim(), 'https://chaggu.invalid'); } catch { return null; }
  return u.pathname === '/api/v1/gifs/media' ? u.searchParams.get('t') : null;
}

// ---------- Enviar ----------
/** Baja el GIF (o la plantilla) elegido y lo guarda como adjunto de imagen pendiente, como una foto. */
export async function sendGif(userId: string, conversationId: string, input: z.infer<typeof SendGifInput>): Promise<SendGifResult> {
  const token = tokenFromUrl(input.url);
  const t = token ? openMedia(token) : null;
  if (!t || t.k !== 'f' || t.p === 'imgflip') throw badRequest('GIF inválido');
  // Primero el permiso: no se baja nada para quien no puede escribir aquí.
  await conversationAccess(pool, userId, conversationId, 'post');
  const media = await readMedia(t);
  const ext = media.contentType === 'image/gif' ? 'gif' : media.contentType.split('/')[1]!.replace('jpeg', 'jpg');
  const attachment = await upload(userId, conversationId, { body: media.body, name: gifFileName(t.t ?? 'gif', ext), type: media.contentType });
  return { attachment, attribution: t.a ?? null };
}

// ---------- Rutas ----------
/** Límites por usuario: buscar 40/min (el selector busca con debounce), enviar 20/min. */
export const SEARCH_LIMIT = { max: 40, timeWindow: '1 minute' };
export const SEND_LIMIT = { max: 20, timeWindow: '1 minute' };

/** Rutas autenticadas (dentro del bloque priv de http.ts). */
export function registerGifRoutes(priv: FastifyInstance) {
  const perUser = (l: { max: number; timeWindow: string }, name: string) =>
    ({ config: { rateLimit: { hook: 'preHandler' as const, ...l, keyGenerator: (req: any) => `${name}:${req.userId}` } } });
  priv.get('/api/v1/gifs/search', perUser(SEARCH_LIMIT, 'gifs'), async (req, reply) => {
    reply.header('cache-control', 'private, max-age=300');
    return search(req.userId, GifSearchQuery.parse(req.query));
  });
  priv.get('/api/v1/gifs/trending', perUser(SEARCH_LIMIT, 'gifs'), async (req, reply) => {
    reply.header('cache-control', 'private, max-age=600');
    return trending(req.userId, GifTrendingQuery.parse(req.query));
  });
  priv.get('/api/v1/memes/templates', perUser(SEARCH_LIMIT, 'gifs'), async (_req, reply) => {
    reply.header('cache-control', 'private, max-age=3600');
    return memeTemplates();
  });
  priv.post<{ Params: { id: string } }>('/api/v1/conversations/:id/gifs', perUser(SEND_LIMIT, 'gif-send'), async (req) =>
    sendGif(req.userId, z.uuid().parse(req.params.id), SendGifInput.parse(req.body)));
}

/**
 * Imagen por token (sin Bearer: la pide un <img>). El token cifrado solo lo emite este servidor, así el proxy no
 * sirve URLs arbitrarias. Límite por IP.
 */
export function registerGifMediaRoute(app: FastifyInstance) {
  app.get<{ Querystring: { t?: string } }>('/api/v1/gifs/media', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const t = openMedia(String(req.query.t ?? ''));
    if (!t) throw notFound('Imagen');
    const f = await readMedia(t);
    return reply.header('content-type', f.contentType).header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox").header('cache-control', 'public, max-age=86400').send(f.body);
  });
}
