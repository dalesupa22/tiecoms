/**
 * Biblioteca de enlaces: cada enlace de un mensaje queda indexado (tipo y plataforma por dominio) para la pestaña
 * «Enlaces» del chat, «Ver después» (estado personal: guardado / visto) y el resumen con IA bajo pedido.
 * Nadie ve el estado de otra persona: no hay «quién abrió qué».
 */
import { createHash } from 'node:crypto';
import type { LinkItemDTO, LinkKind, LinkPreviewDTO, LinkProvider, LinkSummaryDTO } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { pool, tx, type Tx } from '../db.ts';
import { ApiError, notFound } from '../errors.ts';
import { getSummarizer } from './voice-providers.ts';

const URL_RE_G = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const MAX_LINKS = 10;

export const hashUrl = (u: string) => createHash('sha256').update(u).digest();

function cleanUrl(raw: string): string | null {
  let u = raw.replace(/[.,;:!?¿¡)\]}»”’]+$/u, '');
  // Paréntesis balanceados (p. ej. Wikipedia).
  if ((u.match(/\(/g)?.length ?? 0) > (u.match(/\)/g)?.length ?? 0) && raw.startsWith(u + ')')) u += ')';
  try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : null; } catch { return null; }
}

/** Enlaces del texto en orden, sin repetir (máx. 10). */
export function extractUrls(text: string, max = MAX_LINKS): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE_G)) {
    const u = cleanUrl(m[0]);
    if (u && !out.includes(u)) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

/** Tipo y plataforma por dominio y ruta (la misma regla que el índice inicial de la migración 021). */
export function classifyUrl(url: string): { host: string; provider: LinkProvider | null; kind: LinkKind } {
  let u: URL;
  try { u = new URL(url); } catch { return { host: '', provider: null, kind: 'link' }; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.toLowerCase();
  const is = (...hs: string[]) => hs.some((h) => host === h || host.endsWith(`.${h}`));
  const file = /\.(pdf|docx?|xlsx?|pptx?)$/.test(path) ? 'doc' : /\.(png|jpe?g|gif|webp)$/.test(path) ? 'image' : null;
  if (host === 'music.youtube.com') return { host, provider: 'youtube', kind: 'audio' };
  if (is('youtube.com', 'youtu.be')) return { host, provider: 'youtube', kind: path.startsWith('/shorts/') ? 'short' : 'video' };
  if (is('tiktok.com')) return { host, provider: 'tiktok', kind: 'short' };
  if (is('instagram.com', 'instagr.am')) return { host, provider: 'instagram', kind: /^\/(reel|reels|tv)\//.test(path) ? 'short' : 'post' };
  if (is('x.com', 'twitter.com')) return { host, provider: 'x', kind: 'post' };
  if (is('linkedin.com', 'lnkd.in')) return { host, provider: 'linkedin', kind: 'post' };
  if (host === 'fb.watch') return { host, provider: 'facebook', kind: 'video' };
  if (is('facebook.com')) return { host, provider: 'facebook', kind: /\/(watch|videos|reel)\b/.test(path) ? 'video' : 'post' };
  if (is('vimeo.com')) return { host, provider: 'vimeo', kind: 'video' };
  if (host === 'open.spotify.com') return { host, provider: 'spotify', kind: 'audio' };
  if (host === 'docs.google.com' || host === 'drive.google.com') return { host, provider: 'google', kind: 'doc' };
  if (host === 'github.com') return { host, provider: 'github', kind: 'code' };
  return { host, provider: null, kind: file ?? 'link' };
}

/** Qué filtros de la pestaña «Enlaces» abarca cada tipo. */
const FILTERS: Record<string, LinkKind[]> = {
  video: ['video', 'short', 'audio'],
  social: ['post', 'short'],
  article: ['article'],
  doc: ['doc', 'code'],
  other: ['link', 'image'],
};

/**
 * Indexa (o reindexa tras editar) los enlaces de un mensaje dentro de la transacción del envío.
 * Un enlace que sigue en el texto conserva su id (y el «Ver después» de quien lo guardó).
 */
export async function indexLinks(c: Tx, m: { id: string; conversation_id: string; seq: number; author_id: string | null; body: string; created_at: string | Date }) {
  const urls = extractUrls(m.body);
  const { rows: existing } = await c.query('SELECT id, url FROM message_links WHERE message_id = $1', [m.id]);
  if (!urls.length && !existing.length) return;
  // Se liberan las posiciones antes de reordenar (UNIQUE message_id, position).
  if (existing.length) await c.query('UPDATE message_links SET position = -position - 1 WHERE message_id = $1', [m.id]);
  const byUrl = new Map(existing.map((r) => [r.url as string, r.id as string]));
  for (const [i, url] of urls.entries()) {
    const id = byUrl.get(url);
    if (id) { await c.query('UPDATE message_links SET position = $2 WHERE id = $1', [id, i]); byUrl.delete(url); continue; }
    const k = classifyUrl(url);
    await c.query(
      `INSERT INTO message_links (message_id, conversation_id, seq, author_id, position, url, url_hash, host, provider, kind, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [m.id, m.conversation_id, m.seq, m.author_id, i, url, hashUrl(url), k.host, k.provider, k.kind, m.created_at],
    );
  }
  if (byUrl.size) await c.query('DELETE FROM message_links WHERE message_id = $1 AND position < 0', [m.id]);
}

export async function dropLinks(c: Tx, messageId: string) {
  await c.query('DELETE FROM message_links WHERE message_id = $1', [messageId]);
}

const iso = (d: any) => (d ? new Date(d).toISOString() : null);
function toItem(r: any): LinkItemDTO {
  const preview: LinkPreviewDTO | null = r.preview ?? null;
  return {
    id: r.id, conversationId: r.conversation_id, messageId: r.message_id, messageSeq: Number(r.seq), authorId: r.author_id,
    url: r.url, host: r.host, kind: preview?.kind && r.kind === 'link' ? preview.kind : r.kind, provider: r.provider ?? null, preview,
    createdAt: iso(r.created_at)!, savedAt: iso(r.saved_at), seenAt: iso(r.seen_at),
  };
}

const SELECT = `SELECT l.*, s.saved_at, s.seen_at FROM message_links l
  JOIN messages m ON m.id = l.message_id AND m.deleted_at IS NULL
  LEFT JOIN link_states s ON s.link_id = l.id AND s.user_id = $1`;

/** Pestaña «Enlaces» del chat: más recientes primero, con filtro por tipo y búsqueda en URL, título y descripción. */
export async function listLinks(userId: string, conversationId: string, q: { kind: string; q?: string; before?: string; limit: number }) {
  const a = await conversationAccess(pool, userId, conversationId, 'read');
  const kinds = FILTERS[q.kind] ?? null;
  const term = q.q ? `%${q.q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%` : null;
  const { rows } = await pool.query(
    `${SELECT}
      WHERE l.conversation_id = $2 AND l.seq > $3
        AND ($4::text[] IS NULL OR (CASE WHEN l.kind = 'link' AND l.preview->>'kind' IS NOT NULL THEN l.preview->>'kind' ELSE l.kind END) = ANY($4))
        AND ($5::text IS NULL OR l.url ILIKE $5 OR l.preview->>'title' ILIKE $5 OR l.preview->>'description' ILIKE $5 OR l.preview->>'author' ILIKE $5)
        AND ($6::timestamptz IS NULL OR l.created_at < $6)
      ORDER BY l.created_at DESC, l.position LIMIT $7`,
    [userId, conversationId, a.historyFromSeq, kinds, term, q.before ?? null, q.limit + 1],
  );
  return { links: rows.slice(0, q.limit).map(toItem), hasMore: rows.length > q.limit };
}

/** Un enlace que la persona puede leer (revalida el acceso a su conversación). */
async function readableLink(userId: string, linkId: string) {
  const { rows } = await pool.query('SELECT l.*, m.deleted_at FROM message_links l JOIN messages m ON m.id = l.message_id WHERE l.id = $1', [linkId]);
  const l = rows[0];
  if (!l || l.deleted_at) throw notFound('Enlace');
  const a = await conversationAccess(pool, userId, l.conversation_id, 'read');
  if (Number(l.seq) <= a.historyFromSeq) throw notFound('Enlace');
  return l;
}

/** «Ver después» y «visto»: solo cambian la lista de quien lo marca. */
export async function setLinkState(userId: string, linkId: string, input: { saved?: boolean; seen?: boolean }) {
  await readableLink(userId, linkId);
  await pool.query(
    `INSERT INTO link_states (user_id, link_id, saved_at, seen_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END, CASE WHEN $4 THEN now() END)
     ON CONFLICT (user_id, link_id) DO UPDATE SET
       saved_at = CASE WHEN $5 THEN (CASE WHEN $3 THEN COALESCE(link_states.saved_at, now()) END) ELSE link_states.saved_at END,
       seen_at  = CASE WHEN $6 THEN (CASE WHEN $4 THEN COALESCE(link_states.seen_at, now()) END) ELSE link_states.seen_at END`,
    [userId, linkId, input.saved === true, input.seen === true, input.saved !== undefined, input.seen !== undefined],
  );
  await pool.query('DELETE FROM link_states WHERE user_id = $1 AND link_id = $2 AND saved_at IS NULL AND seen_at IS NULL', [userId, linkId]);
  const { rows } = await pool.query(`${SELECT} WHERE l.id = $2`, [userId, linkId]);
  return toItem(rows[0]);
}

/** «Ver después»: pendientes (guardados sin ver), vistos o todos; solo de conversaciones que aún puedo leer. */
export async function listSaved(userId: string, q: { state: 'pending' | 'seen' | 'all'; before?: string; limit: number }) {
  const { rows } = await pool.query(
    `SELECT l.*, s.saved_at, s.seen_at FROM link_states s
       JOIN message_links l ON l.id = s.link_id
       JOIN messages m ON m.id = l.message_id AND m.deleted_at IS NULL
       JOIN conversation_memberships cm ON cm.conversation_id = l.conversation_id AND cm.user_id = s.user_id AND cm.removed_at IS NULL AND l.seq > cm.history_from_seq
       JOIN conversations c ON c.id = l.conversation_id AND c.archived_at IS NULL
      WHERE s.user_id = $1 AND s.saved_at IS NOT NULL
        AND ($2 = 'all' OR ($2 = 'pending' AND s.seen_at IS NULL) OR ($2 = 'seen' AND s.seen_at IS NOT NULL))
        AND ($3::timestamptz IS NULL OR s.saved_at < $3)
      ORDER BY s.saved_at DESC LIMIT $4`,
    [userId, q.state, q.before ?? null, q.limit + 1],
  );
  const pending = await pool.query(
    `SELECT count(*)::int AS n FROM link_states s JOIN message_links l ON l.id = s.link_id JOIN messages m ON m.id = l.message_id AND m.deleted_at IS NULL
       JOIN conversation_memberships cm ON cm.conversation_id = l.conversation_id AND cm.user_id = s.user_id AND cm.removed_at IS NULL
      WHERE s.user_id = $1 AND s.saved_at IS NOT NULL AND s.seen_at IS NULL`,
    [userId],
  );
  return { links: rows.slice(0, q.limit).map(toItem), hasMore: rows.length > q.limit, pending: pending.rows[0].n as number };
}

// ---------- Resumen con IA ----------
const ARTICLE_MIN = 600;

/** Texto legible de una página: <article> o <main> si hay, sin scripts, estilos ni navegación. */
export function readableText(html: string): string {
  const body = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html;
  return body
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function summaryPrompt(lang: 'es' | 'en', basis: 'article' | 'description') {
  return lang === 'es'
    ? `Resumes enlaces que alguien compartió en un chat de trabajo para que la persona decida si vale la pena abrirlo. `
      + `Responde en JSON {"summary": "..."} con 2 o 3 frases en español neutro (máximo 380 caracteres): de qué trata y el dato más útil. `
      + (basis === 'description' ? 'Solo tienes el título y la descripción (es un video o una publicación): no inventes lo que no dicen. ' : '')
      + 'Sin saludos ni frases como «el artículo habla de».'
    : `You summarize links someone shared in a work chat so the reader can decide whether to open it. `
      + `Reply as JSON {"summary": "..."} with 2 or 3 sentences in English (max 380 characters): what it is about and the most useful point. `
      + (basis === 'description' ? 'You only have the title and description (it is a video or a post): do not invent anything. ' : '')
      + 'No greetings and no phrases like "the article talks about".';
}

export async function summarizeLink(userId: string, linkId: string, lang: 'es' | 'en'): Promise<LinkSummaryDTO> {
  const l = await readableLink(userId, linkId);
  const cached = await pool.query('SELECT summary, basis FROM link_summaries WHERE url_hash = $1 AND lang = $2', [l.url_hash, lang]);
  if (cached.rows[0]) return { summary: cached.rows[0].summary, basis: cached.rows[0].basis, lang };
  const ai = getSummarizer();
  if (!ai?.complete) throw new ApiError(503, 'ai_unavailable', 'El resumen con IA no está configurado');
  const p: LinkPreviewDTO | null = l.preview;
  let text = '';
  // Videos y redes: la página casi nunca trae texto útil; se resume la descripción.
  if (!['video', 'short', 'post', 'audio', 'image'].includes(l.kind)) {
    try {
      const { fetchPage } = await import('./link-preview.ts');
      const page = await fetchPage(l.url);
      if (page) text = readableText(page).slice(0, 14_000);
    } catch (e: any) { console.log(`[links] resumen sin página ${l.host}: ${e?.message}`); }
  }
  const basis: 'article' | 'description' = text.length >= ARTICLE_MIN ? 'article' : 'description';
  const header = [p?.title && `Título: ${p.title}`, p?.author && `Autor: ${p.author}`, p?.siteName && `Sitio: ${p.siteName}`, p?.description && `Descripción: ${p.description}`, `URL: ${l.url}`]
    .filter(Boolean).join('\n');
  if (basis === 'description' && !p?.title && !p?.description) throw new ApiError(422, 'nothing_to_summarize', 'Ese enlace no tiene texto para resumir');
  const out = await ai.complete(summaryPrompt(lang, basis), basis === 'article' ? `${header}\n\nTexto:\n${text}` : header);
  let summary = '';
  try { const j = JSON.parse(out); summary = typeof j.summary === 'string' ? j.summary.trim().replace(/\s+/g, ' ').slice(0, 600) : ''; } catch {}
  if (!summary) throw new ApiError(502, 'ai_failed', 'No se pudo resumir el enlace');
  await pool.query(
    'INSERT INTO link_summaries (url_hash, lang, summary, basis) VALUES ($1,$2,$3,$4) ON CONFLICT (url_hash, lang) DO NOTHING',
    [l.url_hash, lang, summary, basis],
  );
  return { summary, basis, lang };
}

// ---------- Resumen semanal por correo ----------
export interface DigestData {
  total: number;
  byConversation: { conversationId: string; name: string; count: number }[];
  pending: { title: string; url: string; conversationName: string }[];
  pendingCount: number;
}

/** Nombre visible de una conversación para una persona (directos: la otra persona). */
async function convName(c: Tx | typeof pool, userId: string, conversationId: string): Promise<string> {
  const { rows } = await c.query(
    `SELECT c.name, c.kind, (SELECT string_agg(u.name, ', ' ORDER BY u.name) FROM conversation_memberships x JOIN users u ON u.id = x.user_id
        WHERE x.conversation_id = c.id AND x.user_id <> $2 AND x.removed_at IS NULL) AS others
       FROM conversations c WHERE c.id = $1`,
    [conversationId, userId],
  );
  const r = rows[0];
  return r?.name || r?.others || 'Chat';
}

/** Lo que va en el correo semanal de una persona: enlaces que compartieron otros en 7 días y su «Ver después» pendiente. */
export async function digestFor(userId: string): Promise<DigestData> {
  const { rows } = await pool.query(
    `SELECT l.conversation_id, count(*)::int AS n FROM message_links l
       JOIN messages m ON m.id = l.message_id AND m.deleted_at IS NULL
       JOIN conversation_memberships cm ON cm.conversation_id = l.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL AND l.seq > cm.history_from_seq
       JOIN conversations c ON c.id = l.conversation_id AND c.archived_at IS NULL
       LEFT JOIN conversation_prefs cp ON cp.conversation_id = c.id AND cp.user_id = $1
      WHERE l.created_at > now() - interval '7 days' AND l.author_id IS DISTINCT FROM $1
        AND (cp.muted_until IS NULL OR cp.muted_until <= now())
      GROUP BY l.conversation_id ORDER BY n DESC`,
    [userId],
  );
  const byConversation = [];
  for (const r of rows.slice(0, 8)) byConversation.push({ conversationId: r.conversation_id, name: await convName(pool, userId, r.conversation_id), count: r.n });
  const saved = await listSaved(userId, { state: 'pending', limit: 5 });
  const pending = [];
  for (const l of saved.links) pending.push({ title: l.preview?.title ?? l.url, url: l.url, conversationName: await convName(pool, userId, l.conversationId) });
  return { total: rows.reduce((n, r) => n + r.n, 0), byConversation, pending, pendingCount: saved.pending };
}

/** Marca el envío para no repetirlo en la misma semana. */
export async function markDigestSent(userId: string) {
  await tx(async (c) => { await c.query('UPDATE users SET link_digest_sent_at = now() WHERE id = $1', [userId]); });
}
