/**
 * Lista de lectura (docs/LECTURA.md): lo que la persona guardó en chaggu («Ver después») más los enlaces que llegan a
 * los chats de WhatsApp que marcó («📚 Enlaces a Ver después», p. ej. el de su papá). «Resúmeme todo» resume cada uno
 * por su contenido (artículo, subtítulos de YouTube, texto completo del post), arma un solo resumen por temas y los
 * marca como leídos. Todo es personal: nadie ve la lista ni los resúmenes de otra persona.
 */
import type { LinkPreviewDTO } from '@tiecoms/contracts';
import { pool } from '../db.ts';
import { ApiError, badRequest } from '../errors.ts';
import { classifyUrl, extractUrls, hashUrl, listSaved, readableText } from './links.ts';
import { fetchPage, previewFor, safeGet } from './link-preview.ts';
import { getSummarizer } from './voice-providers.ts';

const BACKFILL_DAYS = 30;
const DIGEST_MAX = 15;
const TEXT_MAX = 14_000;

export interface ReadingItem {
  id: string; url: string; title: string | null; description: string | null; kind: string; provider: string | null; host: string;
  source: 'whatsapp' | 'chaggu' | 'manual'; from: string | null; chat: string | null; sharedAt: string; seen: boolean; imageUrl: string | null;
}

// ---------- Entrada desde WhatsApp ----------

/** Encender o apagar «📚 Enlaces a Ver después» en un chat de WhatsApp propio. Al encender trae los últimos 30 días. */
export async function setWaReading(userId: string, accountId: string, jid: string, on: boolean) {
  const { rowCount } = await pool.query(
    `UPDATE wa_chats c SET reading_list = $4, reading_since = CASE WHEN $4 AND NOT c.reading_list THEN now() - make_interval(days => $5) ELSE c.reading_since END
       FROM wa_accounts a WHERE a.id = c.account_id AND a.user_id = $1 AND a.removed_at IS NULL AND c.account_id = $2 AND c.jid = $3`,
    [userId, accountId, jid, on, BACKFILL_DAYS],
  );
  if (!rowCount) throw new ApiError(404, 'not_found', 'Chat no encontrado');
  if (on) await scanWaReading(accountId, jid);
  return { ok: true, readingList: on };
}

/**
 * Lleva a la lista los enlaces nuevos de los chats marcados (lo llama el worker cada minuto y al encender un chat).
 * Solo mensajes de la otra persona (no los que yo envié), solo chats visibles (respeta los bloqueados de WhatsApp).
 */
export async function scanWaReading(onlyAccount?: string, onlyJid?: string) {
  const { rows: chats } = await pool.query(
    `SELECT c.account_id, c.jid, c.reading_since, a.user_id, c.name AS chat_name FROM wa_chats c JOIN wa_accounts a ON a.id = c.account_id
      WHERE c.reading_list AND a.removed_at IS NULL AND ($1::uuid IS NULL OR c.account_id = $1) AND ($2::text IS NULL OR c.jid = $2)
        AND wa_chat_visible(c.account_id, c.jid)`,
    [onlyAccount ?? null, onlyJid ?? null],
  );
  let added = 0;
  for (const c of chats) {
    const { rows: msgs } = await pool.query(
      `SELECT m.id, m.body, m.sent_at, m.author_name FROM wa_messages m
        WHERE m.account_id = $1 AND m.chat_jid = $2 AND NOT m.from_me AND m.sent_at > COALESCE($3, now() - interval '1 day')
          AND m.body ~* 'https?://' ORDER BY m.sent_at LIMIT 300`,
      [c.account_id, c.jid, c.reading_since],
    );
    let last: Date | null = null;
    for (const m of msgs) {
      for (const url of extractUrls(m.body)) {
        const cls = classifyUrl(url);
        const r = await pool.query(
          `INSERT INTO reading_items (user_id, url, url_hash, host, provider, kind, source, account_id, jid, wa_message_id, from_name, shared_at)
           VALUES ($1,$2,$3,$4,$5,$6,'whatsapp',$7,$8,$9,$10,$11) ON CONFLICT (user_id, url_hash) DO NOTHING RETURNING id`,
          [c.user_id, url, hashUrl(url), cls.host, cls.provider, cls.kind, c.account_id, c.jid, m.id, m.author_name ?? c.chat_name ?? null, m.sent_at],
        );
        if (r.rowCount) { added++; await pool.query("INSERT INTO jobs (kind, payload, max_attempts) VALUES ('reading.preview', $1, 2)", [JSON.stringify({ id: r.rows[0].id })]); }
      }
      last = m.sent_at;
    }
    if (last) await pool.query('UPDATE wa_chats SET reading_since = $3 WHERE account_id = $1 AND jid = $2', [c.account_id, c.jid, last]);
    else if (!c.reading_since) await pool.query('UPDATE wa_chats SET reading_since = now() WHERE account_id = $1 AND jid = $2', [c.account_id, c.jid]);
  }
  return added;
}

/** Job: vista previa (título, imagen) de un enlace nuevo de la lista, con la misma caché y protección SSRF del chat. */
export async function previewItem(id: string) {
  const r = (await pool.query('SELECT url FROM reading_items WHERE id = $1', [id])).rows[0];
  if (!r) return;
  const p = await previewFor(r.url).catch(() => null);
  if (p) await pool.query('UPDATE reading_items SET preview = $2, kind = CASE WHEN kind = \'link\' THEN $3 ELSE kind END WHERE id = $1', [id, JSON.stringify(p), p.kind ?? 'link']);
}

/** Guardar a mano (desde una IA o pegando un enlace). */
export async function addManual(userId: string, url: string) {
  const u = extractUrls(url)[0];
  if (!u) throw badRequest('Ese no es un enlace válido');
  const cls = classifyUrl(u);
  const r = await pool.query(
    `INSERT INTO reading_items (user_id, url, url_hash, host, provider, kind, source) VALUES ($1,$2,$3,$4,$5,$6,'manual')
     ON CONFLICT (user_id, url_hash) DO UPDATE SET seen_at = NULL RETURNING id`,
    [userId, u, hashUrl(u), cls.host, cls.provider, cls.kind],
  );
  await previewItem(r.rows[0].id);
  return { id: `r:${r.rows[0].id}`, url: u };
}

// ---------- Lista unificada ----------

function fromRow(r: any): ReadingItem {
  const p = r.preview as LinkPreviewDTO | null;
  return {
    id: `r:${r.id}`, url: r.url, title: p?.title ?? null, description: p?.description ?? null, kind: r.kind, provider: r.provider, host: r.host,
    source: r.source, from: r.from_name, chat: r.chat_name ?? null, sharedAt: new Date(r.shared_at).toISOString(), seen: !!r.seen_at, imageUrl: p?.imageUrl ?? null,
  };
}

export async function list(userId: string, q: { state: 'pending' | 'seen' | 'all'; limit: number; source?: 'whatsapp' | 'chaggu' | 'all' }) {
  const out: ReadingItem[] = [];
  if (q.source !== 'chaggu') {
    const { rows } = await pool.query(
      `SELECT r.*, COALESCE(c.name, r.from_name) AS chat_name FROM reading_items r LEFT JOIN wa_chats c ON c.account_id = r.account_id AND c.jid = r.jid
        WHERE r.user_id = $1 AND ($2 = 'all' OR ($2 = 'pending' AND r.seen_at IS NULL) OR ($2 = 'seen' AND r.seen_at IS NOT NULL))
          AND (r.account_id IS NULL OR wa_chat_visible(r.account_id, r.jid))
        ORDER BY r.shared_at DESC LIMIT $3`,
      [userId, q.state, q.limit],
    );
    out.push(...rows.map(fromRow));
  }
  if (q.source !== 'whatsapp') {
    const saved = await listSaved(userId, { state: q.state, limit: q.limit });
    out.push(...saved.links.map((l): ReadingItem => ({
      id: `l:${l.id}`, url: l.url, title: l.preview?.title ?? null, description: l.preview?.description ?? null, kind: l.kind, provider: l.provider ?? null, host: l.host,
      source: 'chaggu', from: null, chat: null, sharedAt: l.savedAt ?? l.createdAt, seen: !!l.seenAt, imageUrl: l.preview?.imageUrl ?? null,
    })));
  }
  out.sort((a, b) => b.sharedAt.localeCompare(a.sharedAt));
  const pending = (await pool.query('SELECT count(*)::int AS n FROM reading_items WHERE user_id = $1 AND seen_at IS NULL', [userId])).rows[0].n as number;
  return { items: out.slice(0, q.limit), pendingWhatsApp: pending };
}

/** Marcar leídos (o no leídos) por id unificado («r:…» lista de lectura, «l:…» Ver después de chaggu). */
export async function setSeen(userId: string, ids: string[], seen: boolean) {
  const r = ids.filter((x) => x.startsWith('r:')).map((x) => x.slice(2));
  const l = ids.filter((x) => x.startsWith('l:')).map((x) => x.slice(2));
  if (r.length) await pool.query('UPDATE reading_items SET seen_at = CASE WHEN $3 THEN COALESCE(seen_at, now()) END WHERE user_id = $1 AND id = ANY($2::uuid[])', [userId, r, seen]);
  if (l.length) {
    await pool.query(
      `UPDATE link_states SET seen_at = CASE WHEN $3 THEN COALESCE(seen_at, now()) END WHERE user_id = $1 AND link_id = ANY($2::uuid[]) AND saved_at IS NOT NULL`,
      [userId, l, seen],
    );
  }
  return { ok: true, updated: r.length + l.length };
}

// ---------- Contenido de cada enlace ----------

/**
 * Contenido de un video de YouTube: los subtítulos si YouTube los entrega (hoy suele pedir un token que un servidor no
 * tiene) y, si no, la descripción completa del video (no la recortada de la vista previa) con su título y capítulos.
 */
export async function youtubeInfo(url: string): Promise<{ transcript: string | null; description: string | null }> {
  const id = url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/|\/embed\/)([\w-]{11})/)?.[1];
  if (!id) return { transcript: null, description: null };
  let html = '';
  try {
    const page = await safeGet(`https://www.youtube.com/watch?v=${id}&hl=es`, 'text/html', 3_000_000, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36');
    html = page.body.toString('utf8');
  } catch (e: any) { console.log(`[lectura] sin página de YouTube ${id}: ${e?.message}`); return { transcript: null, description: null }; }
  let description: string | null = null;
  try {
    const raw = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/)?.[1];
    if (raw) description = (JSON.parse(`"${raw}"`) as string).trim().slice(0, TEXT_MAX) || null;
  } catch { description = null; }
  let transcript: string | null = null;
  try {
    const tracks = html.match(/"captionTracks":(\[.*?\])/)?.[1];
    const list = tracks ? (JSON.parse(tracks) as { baseUrl: string; languageCode: string; kind?: string }[]) : [];
    const pick = list.find((t) => t.languageCode.startsWith('es') && t.kind !== 'asr') ?? list.find((t) => t.languageCode.startsWith('es'))
      ?? list.find((t) => t.languageCode.startsWith('en')) ?? list[0];
    if (pick?.baseUrl) {
      const cap = await safeGet(`${pick.baseUrl.replace(/\\u0026/g, '&')}&fmt=json3`, 'application/json', 2_000_000);
      const body = cap.body.toString('utf8');
      if (body.trim()) {
        const j: any = JSON.parse(body);
        const text = (j.events ?? []).flatMap((e: any) => (e.segs ?? []).map((s: any) => s.utf8 ?? '')).join('').replace(/\s+/g, ' ').trim();
        if (text.length > 200) transcript = text.slice(0, TEXT_MAX);
      }
    }
  } catch (e: any) { console.log(`[lectura] sin subtítulos ${id}: ${e?.message}`); }
  return { transcript, description };
}

/** Texto completo de un post de X (incluye los largos), por la API pública de fxtwitter. */
export async function xPostText(url: string): Promise<string | null> {
  const m = url.match(/(?:x|twitter)\.com\/([^/?#]+)\/status\/(\d+)/i);
  if (!m) return null;
  try {
    const r = await safeGet(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`, 'application/json', 1_000_000);
    if (r.status >= 400) return null;
    const t = JSON.parse(r.body.toString('utf8'))?.tweet;
    const parts = [t?.author?.name && `${t.author.name} (@${t.author.screen_name})`, t?.text, t?.article?.title, t?.article?.preview_text, t?.quote?.text && `Cita: ${t.quote.text}`].filter(Boolean);
    const text = parts.join('\n').trim();
    return text.length > 20 ? text.slice(0, TEXT_MAX) : null;
  } catch (e: any) { console.log(`[lectura] sin texto de X: ${e?.message}`); return null; }
}

type Basis = 'article' | 'description' | 'transcript' | 'post';

async function contentOf(url: string, kind: string, provider: string | null): Promise<{ text: string; basis: Basis }> {
  if (provider === 'youtube') {
    const y = await youtubeInfo(url);
    if (y.transcript) return { text: y.transcript, basis: 'transcript' };
    if (y.description && y.description.length >= 200) return { text: `Descripción completa del video:\n${y.description}`, basis: 'description' };
  }
  if (provider === 'x') { const t = await xPostText(url); if (t) return { text: t, basis: 'post' }; }
  if (!['video', 'short', 'post', 'audio', 'image'].includes(kind)) {
    try { const page = await fetchPage(url); const text = page ? readableText(page).slice(0, TEXT_MAX) : ''; if (text.length >= 600) return { text, basis: 'article' }; } catch { /* sin página */ }
  }
  return { text: '', basis: 'description' };
}

/** Resumen de 3 a 5 frases por URL (se comparte por URL e idioma: el contenido es público). Rehace los que solo tenían descripción. */
export async function summarizeUrl(url: string, kind: string, provider: string | null, preview: LinkPreviewDTO | null, lang: 'es' | 'en' = 'es') {
  const h = hashUrl(url);
  const cached = (await pool.query('SELECT summary, basis FROM link_summaries WHERE url_hash = $1 AND lang = $2', [h, lang])).rows[0];
  if (cached && cached.basis !== 'description') return { summary: cached.summary as string, basis: cached.basis as Basis };
  const ai = getSummarizer();
  if (!ai?.complete) throw new ApiError(503, 'ai_unavailable', 'El resumen con IA no está configurado');
  const p = preview ?? await previewFor(url).catch(() => null);
  const c = await contentOf(url, kind, provider);
  if (c.basis === 'description' && !c.text && cached) return { summary: cached.summary as string, basis: 'description' as Basis };
  const header = [p?.title && `Título: ${p.title}`, p?.author && `Autor: ${p.author}`, p?.siteName && `Sitio: ${p.siteName}`, p?.description && `Descripción: ${p.description}`, `URL: ${url}`].filter(Boolean).join('\n');
  if (c.basis === 'description' && !c.text && !p?.title && !p?.description) return { summary: null, basis: c.basis };
  const what = { article: 'el texto del artículo', transcript: 'la transcripción del video', post: 'el texto completo de la publicación', description: c.text ? 'la descripción completa del video (no su contenido hablado: no inventes lo que no dice y aclara que el resumen sale de la descripción)' : 'solo el título y la descripción (no inventes lo que no dicen)' }[c.basis];
  const system = lang === 'es'
    ? `Resumes contenido que le mandaron a una persona (artículos, videos, publicaciones) para que sepa lo esencial sin abrirlo. Tienes ${what}. `
      + 'Responde en JSON {"summary": "...", "topic": "..."}: summary con 3 a 5 frases en español neutro (máximo 700 caracteres) con la idea central, los datos o argumentos clave y si hay algo accionable; topic es un tema corto de 1 a 3 palabras (p. ej. «Economía», «Salud», «Tecnología»). Sin frases como «el video habla de».'
    : `You summarize content someone was sent (articles, videos, posts) so they get the gist without opening it. You have ${what}. `
      + 'Reply as JSON {"summary": "...", "topic": "..."}: summary with 3 to 5 sentences in English (max 700 characters) with the main idea, key facts or arguments and anything actionable; topic is a short 1-3 word theme. No phrases like "the video talks about".';
  const out = await ai.complete(system, c.text ? `${header}\n\nContenido:\n${c.text}` : header);
  let summary = ''; let topic: string | null = null;
  try { const j = JSON.parse(out); summary = typeof j.summary === 'string' ? j.summary.trim().replace(/\s+/g, ' ').slice(0, 900) : ''; topic = typeof j.topic === 'string' ? j.topic.trim().slice(0, 40) : null; } catch {}
  if (!summary) throw new ApiError(502, 'ai_failed', 'No se pudo resumir el enlace');
  await pool.query(
    `INSERT INTO link_summaries (url_hash, lang, summary, basis) VALUES ($1,$2,$3,$4)
     ON CONFLICT (url_hash, lang) DO UPDATE SET summary = EXCLUDED.summary, basis = EXCLUDED.basis, created_at = now()`,
    [h, lang, summary, c.basis],
  );
  return { summary, basis: c.basis, topic };
}

// ---------- «Resúmeme todo» ----------

async function pool3<T, R>(items: T[], fn: (x: T) => Promise<R>, n = 3): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}

/**
 * Resume lo pendiente (o los ids pedidos): cada enlace por su contenido y un resumen general agrupado por tema.
 * Marca como leídos los que se pudieron resumir (markRead, por defecto sí). Máximo 15 por llamada; `remaining` dice cuántos quedan.
 */
export async function digest(userId: string, opts: { ids?: string[]; limit?: number; markRead?: boolean; source?: 'whatsapp' | 'chaggu' | 'all'; lang?: 'es' | 'en' } = {}) {
  const lang = opts.lang ?? 'es';
  const all = (await list(userId, { state: opts.ids ? 'all' : 'pending', limit: 200, source: opts.source ?? 'all' })).items;
  const chosen = (opts.ids ? all.filter((x) => opts.ids!.includes(x.id)) : all.slice().reverse()).slice(0, Math.min(opts.limit ?? DIGEST_MAX, DIGEST_MAX));
  if (!chosen.length) return { digest: lang === 'es' ? 'No tienes nada pendiente por leer.' : 'Nothing left to read.', items: [], remaining: 0 };
  const done = await pool3(chosen, async (it) => {
    try {
      const s = await summarizeUrl(it.url, it.kind, it.provider, it.title || it.description ? ({ title: it.title, description: it.description, url: it.url } as LinkPreviewDTO) : null, lang);
      return { ...it, summary: s.summary, basis: s.basis, topic: (s as any).topic ?? null };
    } catch (e: any) { return { ...it, summary: null, basis: null, topic: null, error: e?.message ?? 'error' }; }
  });
  const ok = done.filter((x) => x.summary);
  let overview = '';
  const ai = getSummarizer();
  if (ok.length && ai?.complete) {
    const sys = lang === 'es'
      ? 'Armas un resumen de lectura para una persona con lo que le mandaron (a menudo su familia). Responde en JSON {"digest": "..."} en español neutro y texto plano con saltos de línea: '
        + 'agrupa por tema con un título corto por tema, una o dos frases por enlace (menciona quién lo mandó si se sabe), y al final «Lo más importante:» con 1 a 3 puntos. Máximo 2500 caracteres. No inventes nada que no esté en los resúmenes.'
      : 'You write a reading digest of what someone was sent. Reply as JSON {"digest": "..."} in plain text with line breaks: group by topic with a short heading, one or two sentences per link (mention who sent it if known), and end with "Most important:" with 1-3 points. Max 2500 characters. Do not invent anything.';
    const body = ok.map((x, i) => `${i + 1}. [${x.topic ?? x.kind}] ${x.title ?? x.url}${x.from ? ` (lo mandó ${x.from})` : ''}\n${x.summary}`).join('\n\n');
    try { overview = String(JSON.parse(await ai.complete(sys, body)).digest ?? '').trim().slice(0, 4000); } catch { overview = ''; }
  }
  if (!overview) overview = ok.map((x) => `• ${x.title ?? x.url}: ${x.summary}`).join('\n');
  if (opts.markRead !== false && ok.length) await setSeen(userId, ok.map((x) => x.id), true);
  const remaining = Math.max(0, (opts.ids ? 0 : all.length) - chosen.length);
  return {
    digest: overview,
    items: done.map((x) => ({ id: x.id, url: x.url, title: x.title, from: x.from, kind: x.kind, summary: x.summary, basis: x.basis, topic: x.topic, markedRead: !!x.summary && opts.markRead !== false })),
    remaining,
  };
}
