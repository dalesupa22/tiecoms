/**
 * WhatsApp por el conector MCP (docs/MCP.md, docs/PLAN-MCP-INTEGRACIONES-SEMILLERO.md).
 *
 * Doble llave: un token solo ve los números que la persona eligió para él (mcp_tokens.wa_account_ids) o, si no
 * eligió, los números con «Compartir con integraciones» encendido (wa_accounts.integrations_enabled; el personal
 * viene apagado). Un chat suelto se puede compartir aunque su número esté apagado (wa_chats.integrations_shared).
 * Encima de eso siguen las reglas de siempre: dueño de la cuenta y chats bloqueados en WhatsApp (wa-privacy.ts).
 * La app de la persona no pasa por aquí y sigue igual.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { enqueueOutbox, pool, tx, type Db } from '../db.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { visibleWaChatSql } from './wa-privacy.ts';
import { WA_KINDS, WA_WEBHOOK_EVENTS } from './mcp-consts.ts';
import { phoneLabel, sendToChat, whoSql } from './whatsapp.ts';
import { seal, sign, post, unseal, validateOutgoingUrl } from './integration-events.ts';

export interface McpCtx { userId: string; tokenId: string; scopes: string[] | null; waAccountIds: string[] | null; clientName: string }

/** Errores con código estable para las integraciones (13). */
export const waError = (code: string, message: string, status = 400) => new ApiError(status, code, message);

/** Números que este token puede usar (ya filtrados por dueño y cuenta activa). */
export async function allowedAccounts(ctx: McpCtx, db: Db = pool) {
  const { rows } = await db.query(
    `SELECT a.id, a.label, a.kind, a.status, a.send_enabled, a.integrations_enabled, a.phone FROM wa_accounts a
      WHERE a.user_id = $1 AND a.removed_at IS NULL AND (CASE WHEN $2::uuid[] IS NULL THEN a.integrations_enabled ELSE a.id = ANY($2) END)
      ORDER BY a.created_at`,
    [ctx.userId, ctx.waAccountIds],
  );
  return rows as { id: string; label: string; kind: string; status: string; send_enabled: boolean; integrations_enabled: boolean; phone: string | null }[];
}

/** Condición SQL de chat permitido para el token. $1 = userId, $2 = wa_account_ids. Alias c (chat) y a (cuenta). */
const ALLOWED = `a.user_id = $1 AND a.removed_at IS NULL AND ${visibleWaChatSql()}
  AND c.jid NOT LIKE '%@broadcast' AND c.jid NOT LIKE '%@newsletter'
  AND (c.integrations_shared OR (CASE WHEN $2::uuid[] IS NULL THEN a.integrations_enabled ELSE a.id = ANY($2) END))`;

const e164 = (pn: string | null | undefined) => { const d = pn?.split('@')[0]; return d && /^\d{6,15}$/.test(d) ? `+${d}` : null; };
export const chatRef = (accountId: string, jid: string) => `${accountId}|${jid}`;

/** Teléfono en E.164 → dígitos (acepta +57 300 123 4567, 573001234567…). */
export function normPhone(raw: string) {
  const d = raw.replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (!/^\d{8,15}$/.test(d)) throw waError('invalid_phone', 'Número inválido: escríbelo con indicativo de país, p. ej. +57 300 123 4567');
  return d;
}

function mapChat(r: any, preview: boolean) {
  return {
    chat: chatRef(r.account_id, r.jid), name: r.name ?? phoneLabel(r.pn) ?? r.jid.split('@')[0], account: r.account_label, accountKind: r.account_kind,
    isGroup: r.is_group, ...(r.is_group ? { participants: r.participants } : { phone: e164(r.pn) }),
    unread: r.unread, aliasCount: Number(r.alias_count ?? 1), lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
    lastMessageFromMe: r.last_from_me ?? null, lastMessageKind: r.last_kind ?? null,
    canReply: !!r.send_enabled && r.account_status === 'connected',
    ...(r.integrations_shared ? { sharedChat: true } : {}),
    ...(preview ? { preview: r.last_preview } : {}),
  };
}

const CHAT_SELECT = `SELECT c.account_id, c.jid, CASE WHEN c.is_group THEN c.jid ELSE COALESCE(ct.pn, c.jid) END AS logical_jid, c.is_group, c.participants, c.unread, c.last_message_at, c.last_preview, c.integrations_shared,
    COALESCE(c.name, ct.name) AS name, ct.pn, a.label AS account_label, a.kind AS account_kind, a.status AS account_status, a.send_enabled,
    lm.from_me AS last_from_me, lm.kind AS last_kind
  FROM wa_chats c JOIN wa_accounts a ON a.id = c.account_id
  LEFT JOIN LATERAL ${whoSql('c.account_id', 'c.jid')} ct ON true
  LEFT JOIN LATERAL (SELECT m.from_me, m.kind FROM wa_messages m WHERE m.account_id = c.account_id AND m.chat_jid = c.jid ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) lm ON true`;

/** Group only already-authorized rows. Sharing one alias never grants access to its siblings. */
const logicalChatsCte = (extra = '') => `allowed_chats AS (${CHAT_SELECT} WHERE ${ALLOWED} ${extra}),
  logical_chats AS (
    SELECT account_id, logical_jid,
      (array_agg(jid ORDER BY (jid = logical_jid) DESC, last_message_at DESC NULLS LAST, jid))[1] AS jid,
      bool_or(is_group) AS is_group, max(participants) AS participants,
      max(unread) AS unread, max(last_message_at) AS last_message_at,
      (array_agg(last_preview ORDER BY last_message_at DESC NULLS LAST, jid))[1] AS last_preview,
      (array_agg(last_from_me ORDER BY last_message_at DESC NULLS LAST, jid))[1] AS last_from_me,
      (array_agg(last_kind ORDER BY last_message_at DESC NULLS LAST, jid))[1] AS last_kind,
      bool_or(integrations_shared) AS integrations_shared,
      (array_agg(name ORDER BY name IS NULL, (jid = logical_jid) DESC, last_message_at DESC NULLS LAST, jid))[1] AS name,
      array_agg(DISTINCT name) FILTER (WHERE name IS NOT NULL) AS names,
      max(pn) AS pn, max(account_label) AS account_label, max(account_kind) AS account_kind,
      max(account_status) AS account_status, bool_or(send_enabled) AS send_enabled, count(*)::int AS alias_count
    FROM allowed_chats GROUP BY account_id, logical_jid
  )`;

const isoDate = z.string().datetime({ offset: true });
const encCursor = (at: string | null, jid: string, account: string) => Buffer.from(JSON.stringify([at, jid, account])).toString('base64url');
const decCursor = (raw: string) => {
  try {
    const values = z.tuple([isoDate.nullable(), z.string().min(1).max(300)]).rest(z.string().uuid()).parse(JSON.parse(Buffer.from(raw, 'base64url').toString()));
    if (values.length > 3) throw new Error('cursor');
    return { at: values[0], jid: values[1], account: values[2] ?? null };
  } catch { throw badRequest('cursor inválido'); }
};

/** One contact per account; unrelated accounts and groups remain separate. */
export async function listChats(ctx: McpCtx, q: { query?: string; unreadOnly?: boolean; since?: string; groups?: boolean; limit: number; cursor?: string; includePreview?: boolean }) {
  const cur = q.cursor ? decCursor(q.cursor) : null;
  const { rows } = await pool.query(
    `WITH ${logicalChatsCte('AND NOT c.hidden')}
      SELECT c.*, to_char(c.last_message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM logical_chats c
      WHERE ($3::text IS NULL OR EXISTS (SELECT 1 FROM unnest(c.names) n WHERE n ILIKE '%' || $3 || '%') OR c.pn LIKE '%' || $3 || '%')
        AND (NOT $4 OR c.unread > 0) AND ($5::timestamptz IS NULL OR c.last_message_at >= $5) AND ($6::boolean IS NULL OR c.is_group = $6)
        AND ($8::text IS NULL OR CASE WHEN $9::uuid IS NULL
          THEN (COALESCE(c.last_message_at, '-infinity'), c.jid) < (COALESCE($7::timestamptz, '-infinity'), $8)
          ELSE (COALESCE(c.last_message_at, '-infinity'), c.jid, c.account_id) < (COALESCE($7::timestamptz, '-infinity'), $8, $9::uuid) END)
      ORDER BY c.last_message_at DESC NULLS LAST, c.jid DESC, c.account_id DESC LIMIT $10`,
    [ctx.userId, ctx.waAccountIds, q.query?.trim() || null, !!q.unreadOnly, q.since ?? null, q.groups ?? null,
      cur?.at ?? null, cur?.jid ?? null, cur?.account ?? null, q.limit + 1],
  );
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return { chats: page.map((r) => mapChat(r, !!q.includePreview)), hasMore: more,
    ...(more && last ? { nextCursor: encCursor(last.cursor_at, last.jid, last.account_id) } : {}) };
}

/** Explicit references must themselves be allowed; names collapse authorized aliases first. */
export async function findChat(ctx: McpCtx, ref: string, db: Db = pool) {
  const bar = ref.indexOf('|');
  if (bar > 0) {
    // Una referencia vieja por LID sigue sirviendo después de unir el chat con el del número (103_wa_lid_merge.sql).
    const { rows } = await db.query(`WITH ${logicalChatsCte()},
      wanted AS (SELECT $4::text AS jid UNION SELECT al.pn FROM wa_jid_alias al WHERE al.account_id::text = $3 AND al.lid = $4)
      SELECT l.*, CASE WHEN EXISTS (SELECT 1 FROM allowed_chats WHERE account_id::text = $3 AND jid = $4) THEN $4::text ELSE l.jid END AS jid
        FROM logical_chats l WHERE l.account_id::text = $3 AND l.logical_jid IN
        (SELECT logical_jid FROM allowed_chats WHERE account_id::text = $3 AND jid IN (SELECT jid FROM wanted))
      LIMIT 1`,
    [ctx.userId, ctx.waAccountIds, ref.slice(0, bar), ref.slice(bar + 1)]);
    if (!rows[0]) throw waError('not_found', 'Ese chat no existe o no está compartido con esta integración', 404);
    return rows[0];
  }
  const { rows } = await db.query(`WITH ${logicalChatsCte()}
    SELECT * FROM logical_chats WHERE EXISTS (SELECT 1 FROM unnest(names) n WHERE n ILIKE '%' || $3 || '%')
    ORDER BY last_message_at DESC NULLS LAST, account_id, jid LIMIT 20`, [ctx.userId, ctx.waAccountIds, ref.trim()]);
  const exact = rows.filter((r) => (r.names ?? []).some((name: string) => name.toLowerCase() === ref.trim().toLowerCase()));
  const hits = exact.length ? exact : rows;
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw waError('not_found', 'No encontré ese chat de WhatsApp entre los compartidos con esta integración', 404);
  throw badRequest(`Hay ${hits.length} chats con ese nombre; usa el valor chat: ${hits.slice(0, 8).map((r) => `${r.name} (${r.account_label}) = ${chatRef(r.account_id, r.jid)}`).join('; ')}`);
}

const HISTORY_CURSOR_PREFIX = 'wa1.';
const HistoryCursor = z.object({
  v: z.literal(1), account: z.string().uuid(), contact: z.string().min(1).max(300),
  direction: z.enum(['before', 'since']), at: isoDate, id: z.string().min(1).max(1000),
  kinds: z.array(z.enum(WA_KINDS)).max(10), opposite: isoDate.nullable(),
}).strict();
type HistoryCursorValue = z.infer<typeof HistoryCursor>;
const encodeHistoryCursor = (value: HistoryCursorValue) => HISTORY_CURSOR_PREFIX + Buffer.from(JSON.stringify(value)).toString('base64url');
function parseBoundary(raw: string | undefined): string | HistoryCursorValue | null {
  if (raw === undefined) return null;
  if (raw.startsWith(HISTORY_CURSOR_PREFIX)) {
    try {
      const data = raw.slice(HISTORY_CURSOR_PREFIX.length);
      if (raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(data)) throw new Error('cursor');
      return HistoryCursor.parse(JSON.parse(Buffer.from(data, 'base64url').toString('utf8')));
    } catch { throw badRequest('Cursor de historial inválido; usa nextCursor sin modificarlo'); }
  }
  if (!isoDate.safeParse(raw).success) throw badRequest('since/before debe ser una fecha ISO o el cursor devuelto por read_whatsapp');
  return raw;
}

/** ISO bounds stay compatible; cursor bounds preserve timestamp ties and the opposite ISO limit. */
function historyPage(c: any, q: { since?: string; before?: string; kinds?: string[] }) {
  const since = parseBoundary(q.since), before = parseBoundary(q.before);
  const cursor = typeof since === 'object' && since ? since : typeof before === 'object' && before ? before : null;
  const requestedKinds = q.kinds ? [...new Set(q.kinds)].sort() : null;
  if (cursor) {
    const fromSince = typeof since === 'object' && since !== null;
    const opposite = fromSince ? before : since;
    if ((opposite !== null && typeof opposite !== 'string') || cursor.direction !== (fromSince ? 'since' : 'before')
      || cursor.account !== c.account_id || cursor.contact !== c.logical_jid
      || (requestedKinds && JSON.stringify(requestedKinds) !== JSON.stringify(cursor.kinds))
      || (opposite !== null && opposite !== cursor.opposite)) throw badRequest('El cursor no corresponde a este chat, dirección o filtros');
    return { ascending: fromSince, sinceAt: fromSince ? cursor.at : cursor.opposite, sinceId: fromSince ? cursor.id : null,
      beforeAt: fromSince ? cursor.opposite : cursor.at, beforeId: fromSince ? null : cursor.id, kinds: cursor.kinds,
      opposite: cursor.opposite };
  }
  return { ascending: since !== null, sinceAt: since as string | null, sinceId: null, beforeAt: before as string | null,
    beforeId: null, kinds: requestedKinds ?? [], opposite: (since !== null ? before : since) as string | null };
}

/** Authorized PN/LID history, de-duplicated before filtering/pagination. */
export async function readChat(ctx: McpCtx, ref: string, q: { limit: number; since?: string; before?: string; cursor?: string; kinds?: string[] }) {
  const c = await findChat(ctx, ref);
  if (q.cursor !== undefined) {
    const cursor = parseBoundary(q.cursor);
    if (!cursor || typeof cursor === 'string' || q.since !== undefined || q.before !== undefined) {
      throw badRequest('Usa cursor: nextCursor sin combinarlo con since/before');
    }
    q = { ...q, [cursor.direction]: q.cursor };
  }
  const pageState = historyPage(c, q);
  const order = pageState.ascending ? 'ASC' : 'DESC';
  const { rows } = await pool.query(
    `WITH ${logicalChatsCte('AND c.account_id = $3::uuid AND (CASE WHEN c.is_group THEN c.jid ELSE COALESCE(ct.pn, c.jid) END) = $4')}, unique_messages AS (
       SELECT DISTINCT ON (m.id) m.* FROM wa_messages m JOIN allowed_chats ac ON ac.account_id = m.account_id AND ac.jid = m.chat_jid
       WHERE m.account_id = $3::uuid AND ac.logical_jid = $4 AND wa_chat_visible(m.account_id, m.chat_jid)
       ORDER BY m.id, m.sent_at DESC, m.chat_jid
     )
     SELECT m.*, w.name AS who_name, w.pn AS who_pn,
       to_char(m.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
     FROM unique_messages m LEFT JOIN LATERAL ${whoSql('m.account_id', 'm.author_jid')} w ON NOT m.from_me
     WHERE ($5::timestamptz IS NULL OR CASE WHEN $6::text IS NULL THEN m.sent_at > $5 ELSE (m.sent_at, m.id) > ($5::timestamptz, $6) END)
       AND ($7::timestamptz IS NULL OR CASE WHEN $8::text IS NULL THEN m.sent_at < $7 ELSE (m.sent_at, m.id) < ($7::timestamptz, $8) END)
       AND ($9::text[] IS NULL OR m.kind = ANY($9))
     ORDER BY m.sent_at ${order}, m.id ${order} LIMIT $10`,
    [ctx.userId, ctx.waAccountIds, c.account_id, c.logical_jid, pageState.sinceAt, pageState.sinceId,
      pageState.beforeAt, pageState.beforeId, pageState.kinds.length ? pageState.kinds : null, q.limit + 1],
  );
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const ordered = pageState.ascending ? page : page.reverse();
  const pending = new Map<string, string[]>();
  for (const m of ordered) if (m.kind === 'audio' && m.media_info?.kind === 'voice' && !m.transcript) {
    const ids = pending.get(m.chat_jid) ?? []; ids.push(m.id); pending.set(m.chat_jid, ids);
  }
  for (const [jid, ids] of pending) await queueTranscriptions(c.account_id, jid, ids);
  const messages = ordered.map((m) => {
    const t = m.transcript as { status?: string; text?: string; summary?: string } | null;
    const transcribed = t?.status === 'done' && t.text;
    return {
      id: m.id, at: new Date(m.sent_at).toISOString(), fromMe: m.from_me, kind: m.kind,
      text: transcribed ? `🎤 (transcrito) ${t!.text}` : m.body,
      ...(m.from_me ? { sender: 'Tú' } : { sender: m.author_name ?? m.who_name ?? phoneLabel(m.who_pn) ?? 'Contacto', senderPhone: e164(m.who_pn), senderPushName: m.author_name ?? null }),
      ...(m.kind === 'audio' && (m.media_info?.kind === 'voice' || t) ? { transcript: transcribed ? t!.text : null, transcriptStatus: t?.status ?? (m.media_info ? 'pending' : 'unavailable'), ...(t?.summary ? { summary: t.summary } : {}) } : {}),
    };
  });
  const edge = pageState.ascending ? ordered.at(-1) : ordered[0];
  const next = edge ? encodeHistoryCursor({ v: 1, account: c.account_id, contact: c.logical_jid, direction: pageState.ascending ? 'since' : 'before',
    at: edge.cursor_at, id: edge.id, kinds: pageState.kinds as HistoryCursorValue['kinds'], opposite: pageState.opposite }) : null;
  // Keep ISO outputs for clients whose cached schemas still require date-time inputs.
  const cursors: { nextSince?: string; nextBefore?: string; nextCursor?: string } = more && next
    ? { nextCursor: next, ...(pageState.ascending ? { nextSince: edge.cursor_at } : { nextBefore: edge.cursor_at }) } : {};
  return { chat: mapChat(c, false), messages, hasMore: more, ...cursors };
}

/** One authorized logical contact per account, even if WhatsApp uses several LIDs. */
export async function findByPhone(ctx: McpCtx, raw: string, db: Db = pool) {
  const d = normPhone(raw), pn = `${d}@s.whatsapp.net`;
  const { rows } = await db.query(`WITH ${logicalChatsCte()}
    SELECT c.*, (SELECT k.push_name FROM wa_contacts k WHERE k.account_id = c.account_id AND k.jid = $3) AS push_name
    FROM logical_chats c WHERE NOT c.is_group AND c.logical_jid = $3
    ORDER BY c.last_message_at DESC NULLS LAST, c.account_id`, [ctx.userId, ctx.waAccountIds, pn]);
  return { phone: `+${d}`, chats: rows.map((r) => ({ ...mapChat(r, false), pushName: r.push_name ?? null })) };
}

/** 9. Grupo: asunto, descripción y participantes (con teléfono cuando se conoce). */
export async function groupInfo(ctx: McpCtx, ref: string) {
  const c = await findChat(ctx, ref);
  if (!c.is_group) throw badRequest('Ese chat no es un grupo');
  const g = (await pool.query('SELECT description, members FROM wa_chats WHERE account_id = $1 AND jid = $2', [c.account_id, c.jid])).rows[0];
  const members = (g?.members ?? []) as { jid: string; pn?: string | null; admin?: string | null }[];
  let people: any[] = [];
  if (members.length) {
    const { rows } = await pool.query(
      `SELECT m.jid, w.name, w.pn, (SELECT push_name FROM wa_contacts k WHERE k.account_id = $1 AND (k.jid = m.jid OR k.jid = w.pn) AND push_name IS NOT NULL ORDER BY (k.jid = m.jid) DESC LIMIT 1) AS push_name
         FROM unnest($2::text[]) AS m(jid) LEFT JOIN LATERAL ${whoSql('$1::uuid', 'm.jid')} w ON true`,
      [c.account_id, members.map((m) => m.jid)],
    );
    people = rows.map((r) => {
      const meta = members.find((m) => m.jid === r.jid);
      return { name: r.name ?? r.push_name ?? phoneLabel(r.pn ?? meta?.pn) ?? null, pushName: r.push_name ?? null, phone: e164(r.pn ?? meta?.pn), admin: !!meta?.admin };
    });
  } else {
    // Sin metadatos todavía (el puente los trae al reconectar): quienes han escrito en el grupo.
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (m.author_jid) m.author_jid, m.author_name, w.name, w.pn FROM wa_messages m
         LEFT JOIN LATERAL ${whoSql('m.account_id', 'm.author_jid')} w ON true
        WHERE m.account_id = $1 AND m.chat_jid = $2 AND NOT m.from_me AND m.author_jid IS NOT NULL ORDER BY m.author_jid, m.sent_at DESC`,
      [c.account_id, c.jid],
    );
    people = rows.map((r) => ({ name: r.name ?? r.author_name ?? phoneLabel(r.pn), pushName: r.author_name ?? null, phone: e164(r.pn), admin: null }));
  }
  return { chat: chatRef(c.account_id, c.jid), subject: c.name, description: g?.description ?? null, participants: c.participants, members: people, membersSource: members.length ? 'whatsapp' : 'authors' };
}

/** 11. Buscar en el texto (y las transcripciones) de los chats permitidos. */
export async function search(ctx: McpCtx, q: { query: string; since?: string; limit: number }) {
  const { rows } = await pool.query(
    `WITH ${logicalChatsCte()}, unique_messages AS (
       SELECT DISTINCT ON (m.account_id, ac.logical_jid, m.id) m.*, ac.logical_jid
       FROM wa_messages m JOIN allowed_chats ac ON ac.account_id = m.account_id AND ac.jid = m.chat_jid
       WHERE wa_chat_visible(m.account_id, m.chat_jid)
       ORDER BY m.account_id, ac.logical_jid, m.id, m.sent_at DESC, m.chat_jid
     )
     SELECT m.account_id, c.jid AS chat_jid, m.id, m.from_me, m.kind, m.body, m.sent_at,
       m.transcript->>'text' AS transcript, c.name, c.pn
     FROM unique_messages m JOIN logical_chats c ON c.account_id = m.account_id AND c.logical_jid = m.logical_jid
     WHERE ($4::timestamptz IS NULL OR m.sent_at >= $4)
       AND (tiecoms_fold(m.body) LIKE '%' || tiecoms_fold($3) || '%' OR tiecoms_fold(COALESCE(m.transcript->>'text', '')) LIKE '%' || tiecoms_fold($3) || '%')
     ORDER BY m.sent_at DESC, m.id DESC, m.account_id, c.jid LIMIT $5`,
    [ctx.userId, ctx.waAccountIds, q.query, q.since ?? null, q.limit],
  );
  return {
    results: rows.map((r) => {
      const text = r.transcript && !String(r.body).toLowerCase().includes(q.query.toLowerCase()) ? `🎤 (transcrito) ${r.transcript}` : r.body;
      const i = text.toLowerCase().indexOf(q.query.toLowerCase());
      return { chat: chatRef(r.account_id, r.chat_jid), name: r.name ?? phoneLabel(r.pn), messageId: r.id, at: new Date(r.sent_at).toISOString(), fromMe: r.from_me, kind: r.kind,
        snippet: i < 0 ? text.slice(0, 200) : `${i > 60 ? '…' : ''}${text.slice(Math.max(0, i - 60), i + q.query.length + 100)}` };
    }),
  };
}

/** Destino de un envío: chat permitido o número nuevo en una cuenta permitida (se crea el chat). */
export async function target(ctx: McpCtx, a: { chat?: string; phone?: string; account?: string }, db: Db = pool) {
  const accounts = await allowedAccounts(ctx, db);
  if (a.chat) {
    const c = await findChat(ctx, a.chat, db);
    if (a.account && a.account !== c.account_id && a.account.toLowerCase() !== String(c.account_label).toLowerCase()) throw badRequest('account no corresponde al chat indicado');
    return { accountId: c.account_id as string, jid: c.jid as string, label: (c.name ?? phoneLabel(c.pn) ?? c.jid) as string, account: accounts.find((x) => x.id === c.account_id) ?? (await accountRow(ctx.userId, c.account_id, db)) };
  }
  if (!a.phone) throw badRequest('Indica chat o phone');
  const found = await findByPhone(ctx, a.phone, db);
  const usable = accounts.filter((x) => !a.account || x.id === a.account || x.label.toLowerCase() === a.account.toLowerCase());
  const matches = found.chats.filter((c) => usable.some((x) => c.chat.startsWith(`${x.id}|`)));
  if (matches.length > 1) throw badRequest('Ese teléfono aparece en varias cuentas; indica el account exacto');
  const existing = matches[0];
  if (existing) { const [accountId, jid] = existing.chat.split('|') as [string, string]; return { accountId, jid, label: existing.name, account: usable.find((x) => x.id === accountId)! }; }
  if (!usable.length) throw waError('integrations_disabled', 'Ningún número de WhatsApp está compartido con esta integración. Actívalo en chaggu › WhatsApp o en Tú › Conector para IAs.', 403);
  const sendable = usable.filter((x) => x.send_enabled && x.status === 'connected');
  const acc = a.account || usable.length === 1 ? usable[0]! : sendable.length === 1 ? sendable[0]! : null;
  if (!acc) throw badRequest(`Tienes varios números; indica account: ${usable.map((x) => x.label).join(', ')}`);
  const jid = `${normPhone(a.phone)}@s.whatsapp.net`;
  // Chat nuevo, sin nombre: el puente lo completa cuando WhatsApp responda. No pisa uno existente.
  await db.query(`INSERT INTO wa_chats (account_id, jid, is_group, category) VALUES ($1, $2, false, 'clientes') ON CONFLICT (account_id, jid) DO NOTHING`, [acc.id, jid]);
  return { accountId: acc.id, jid, label: `+${normPhone(a.phone)}`, account: acc };
}

async function accountRow(userId: string, id: string, db: Db = pool) {
  return (await db.query('SELECT id, label, kind, status, send_enabled, integrations_enabled, phone FROM wa_accounts WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
}

/** 13. Enviar con llave de idempotencia (24 h por token), a un chat o a un número nuevo, con errores con código. */
export async function send(ctx: McpCtx, a: { chat?: string; phone?: string; account?: string; text: string; idempotencyKey?: string }) {
  const fingerprint = createHash('sha256').update(JSON.stringify([a.chat ?? null, a.phone ?? null, a.account ?? null, a.text])).digest();
  if (a.idempotencyKey) {
    await pool.query("DELETE FROM mcp_idempotency WHERE created_at < now() - interval '24 hours'");
    const ins = await pool.query('INSERT INTO mcp_idempotency (token_id, key, request) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key', [ctx.tokenId, a.idempotencyKey, fingerprint]);
    if (!ins.rowCount) {
      const prev = (await pool.query('SELECT request, response FROM mcp_idempotency WHERE token_id = $1 AND key = $2', [ctx.tokenId, a.idempotencyKey])).rows[0];
      if (prev && !Buffer.from(prev.request).equals(fingerprint)) throw waError('idempotency_mismatch', 'Esa idempotency_key ya se usó con otro destino o texto', 409);
      if (prev?.response) return { ...prev.response, duplicate: true };
      throw waError('in_progress', 'Ese envío ya está en curso con la misma idempotency_key; consulta de nuevo en unos segundos', 409);
    }
  }
  try {
    const t = await target(ctx, a);
    if (!t.account?.send_enabled) throw waError('send_disabled', `El número «${t.account?.label}» está en solo lectura. Activa «Responder desde chaggu» en WhatsApp.`, 403);
    if (t.account.status !== 'connected') throw waError('not_connected', `El número «${t.account.label}» no está conectado ahora mismo`, 409);
    const r = await sendToChat(ctx.userId, t.accountId, t.jid, a.text);
    // outboxId siempre (sirve si queda 'queued'); messageId = id de WhatsApp (el de read_whatsapp) cuando ya salió.
    const out = { to: t.label, chat: chatRef(t.accountId, t.jid), account: t.account.label, status: r.status, outboxId: r.id, ...(r.messageId ? { messageId: r.messageId } : {}), ...(r.error ? { error: r.error } : {}) };
    if (a.idempotencyKey) await pool.query('UPDATE mcp_idempotency SET response = $3 WHERE token_id = $1 AND key = $2', [ctx.tokenId, a.idempotencyKey, JSON.stringify(out)]);
    return out;
  } catch (e) {
    // Si falló antes de encolar, la llave queda libre para reintentar.
    if (a.idempotencyKey) await pool.query('DELETE FROM mcp_idempotency WHERE token_id = $1 AND key = $2 AND response IS NULL', [ctx.tokenId, a.idempotencyKey]);
    throw e;
  }
}

// ---------- 12. Borradores ----------

export async function createDraft(ctx: McpCtx, a: { chat?: string; phone?: string; account?: string; text: string; source?: string; externalRef?: string }) {
  const t = await target(ctx, a);
  const { rows } = await pool.query(
    `INSERT INTO wa_drafts (user_id, token_id, account_id, jid, to_label, body, source, external_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [ctx.userId, ctx.tokenId, t.accountId, t.jid, t.label, a.text, a.source ?? ctx.clientName, a.externalRef ?? null],
  );
  await tx(async (c) => {
    await enqueueOutbox(c, 'account.event', { userIds: [ctx.userId], event: { type: 'wa.drafts' } });
    // Un aviso agrupado por persona cada pocos minutos, no uno por borrador.
    await c.query("INSERT INTO jobs (kind, payload, dedupe_key, run_at) VALUES ('push.wa_drafts', $1, $2, now() + interval '20 seconds') ON CONFLICT (dedupe_key) DO NOTHING",
      [JSON.stringify({ userId: ctx.userId }), `wa-drafts:${ctx.userId}:${Math.floor(Date.now() / 300_000)}`]);
  });
  return { draft: rows[0].id, to: t.label, chat: chatRef(t.accountId, t.jid), status: 'pending', note: 'La persona lo verá en chaggu › WhatsApp › Por enviar y decidirá Enviar, Editar o Descartar.' };
}

export async function listDrafts(userId: string, opts: { tokenId?: string; status?: string } = {}) {
  const { rows } = await pool.query(
    `SELECT d.*, a.label AS account_label, t.client_name, t.name AS token_name FROM wa_drafts d JOIN wa_accounts a ON a.id = d.account_id
       LEFT JOIN mcp_tokens t ON t.id = d.token_id
      WHERE d.user_id = $1 AND ($2::uuid IS NULL OR d.token_id = $2) AND ($3::text IS NULL OR d.status = $3)
      ORDER BY d.created_at DESC LIMIT 200`,
    [userId, opts.tokenId ?? null, opts.status ?? null],
  );
  return rows.map((d) => ({
    id: d.id, chat: chatRef(d.account_id, d.jid), to: d.to_label, account: d.account_label, text: d.body, source: d.source ?? d.client_name ?? d.token_name,
    externalRef: d.external_ref, status: d.status, error: d.error, createdAt: new Date(d.created_at).toISOString(), decidedAt: d.decided_at ? new Date(d.decided_at).toISOString() : null,
  }));
}

/** La persona (o la integración que lo creó, si sigue pendiente) lo descarta. */
export async function discardDraft(userId: string, id: string, tokenId?: string) {
  const { rows } = await pool.query(
    `UPDATE wa_drafts SET status = 'discarded', decided_at = now() WHERE id = $1 AND user_id = $2 AND status = 'pending' AND ($3::uuid IS NULL OR token_id = $3) RETURNING *`,
    [id, userId, tokenId ?? null],
  );
  if (!rows[0]) throw notFound('Borrador pendiente');
  await draftEvent(rows[0], 'whatsapp.draft.discarded');
  return { ok: true };
}

/** Enviar (opcionalmente editado). Solo la persona, desde la app: es su aprobación. */
export async function sendDraft(userId: string, id: string, body?: string) {
  const { rows } = await pool.query(
    `UPDATE wa_drafts SET status = 'sending', body = COALESCE($3, body) WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING *`,
    [id, userId, body?.trim() || null],
  );
  const d = rows[0];
  if (!d) throw notFound('Borrador pendiente');
  try {
    const r = await sendToChat(userId, d.account_id, d.jid, d.body);
    const status = r.status === 'failed' ? 'failed' : 'sent';
    await pool.query('UPDATE wa_drafts SET status = $2, error = $3, decided_at = now() WHERE id = $1', [id, status, r.error ?? null]);
    if (status === 'sent') await draftEvent({ ...d, status }, 'whatsapp.draft.sent');
    return { status: r.status, ...(r.error ? { error: r.error } : {}) };
  } catch (e: any) {
    await pool.query("UPDATE wa_drafts SET status = 'pending' WHERE id = $1 AND status = 'sending'", [id]);
    throw e;
  }
}

// ---------- 10. Avisos al instante ----------

export const WEBHOOK_EVENTS = WA_WEBHOOK_EVENTS;

export async function setWebhook(ctx: McpCtx, a: { url: string; events?: string[]; chats: string[] }) {
  validateOutgoingUrl(a.url);
  const events = (a.events?.length ? a.events : [...WEBHOOK_EVENTS]).filter((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  // Solo chats permitidos para este token: un chat no compartido no se puede escuchar.
  const chats: string[] = [];
  for (const ref of a.chats) { const c = await findChat(ctx, ref); chats.push(chatRef(c.account_id, c.jid)); }
  const secret = `whsec_${randomUUID().replace(/-/g, '')}`;
  await pool.query('UPDATE mcp_webhooks SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL', [ctx.tokenId]);
  const { rows } = await pool.query('INSERT INTO mcp_webhooks (token_id, user_id, url, secret, events, chats) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [ctx.tokenId, ctx.userId, a.url, seal(secret), events, [...new Set(chats)]]);
  return { webhook: rows[0].id, url: a.url, events, chats: [...new Set(chats)], secret, signature: 'x-chaggu-signature: t=<unix>,v1=<hex hmac-sha256 de "t.cuerpo"> con el secret' };
}

export async function getWebhook(ctx: McpCtx) {
  const r = (await pool.query('SELECT id, url, events, chats, created_at FROM mcp_webhooks WHERE token_id = $1 AND revoked_at IS NULL', [ctx.tokenId])).rows[0];
  return r ? { webhook: r.id, url: r.url, events: r.events, chats: r.chats, createdAt: new Date(r.created_at).toISOString() } : { webhook: null };
}

export async function deleteWebhook(ctx: McpCtx) {
  await pool.query('UPDATE mcp_webhooks SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL', [ctx.tokenId]);
  return { ok: true };
}

/**
 * Encola avisos de mensajes nuevos de WhatsApp (lo llama el puente después de guardarlos). Solo webhooks cuyo token
 * sigue vivo, que pidieron ese evento, que listan el chat y que todavía tienen permiso sobre ese número o chat.
 */
export async function queueWaWebhooks(accountId: string, msgs: { chat: string; id: string; fromMe: boolean; kind: string; body: string; sentAt: Date; authorName?: string | null }[]) {
  if (!msgs.length) return;
  const refs = [...new Set(msgs.map((m) => chatRef(accountId, m.chat)))];
  const { rows: hooks } = await pool.query(
    `SELECT h.id, h.events, h.chats FROM mcp_webhooks h JOIN mcp_tokens t ON t.id = h.token_id JOIN wa_accounts a ON a.user_id = h.user_id AND a.id = $1
      WHERE h.revoked_at IS NULL AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND a.removed_at IS NULL
        AND (t.scopes IS NULL OR 'whatsapp:read' = ANY(t.scopes)) AND h.chats && $2::text[]`,
    [accountId, refs],
  );
  for (const h of hooks) {
    for (const m of msgs) {
      const ref = chatRef(accountId, m.chat);
      const type = m.fromMe ? 'whatsapp.message.sent' : 'whatsapp.message.received';
      if (!h.chats.includes(ref) || !h.events.includes(type)) continue;
      await queueDelivery(h.id, type, { chat: ref, message: { id: m.id, at: m.sentAt.toISOString(), fromMe: m.fromMe, kind: m.kind, text: m.body, ...(m.fromMe ? {} : { sender: m.authorName ?? null }) } }, accountId, m.chat);
    }
  }
}

async function queueDelivery(webhookId: string, type: string, data: object, accountId?: string, jid?: string) {
  const id = randomUUID();
  // El permiso se vuelve a revisar al entregar (el chat pudo dejar de estar compartido).
  const payload = { id, type, createdAt: new Date().toISOString(), data, ...(accountId ? { scope: { accountId, jid } } : {}) };
  await pool.query('INSERT INTO mcp_webhook_deliveries (id, webhook_id, event_type, payload) VALUES ($1,$2,$3,$4)', [id, webhookId, type, JSON.stringify(payload)]);
  await pool.query("INSERT INTO jobs (kind, payload, max_attempts) VALUES ('mcp.webhook', $1, 8)", [JSON.stringify({ deliveryId: id })]);
}

async function draftEvent(d: any, type: 'whatsapp.draft.sent' | 'whatsapp.draft.discarded') {
  if (!d.token_id) return;
  const { rows } = await pool.query('SELECT id, events FROM mcp_webhooks WHERE token_id = $1 AND revoked_at IS NULL', [d.token_id]);
  for (const h of rows) if (h.events.includes(type)) await queueDelivery(h.id, type, { draft: d.id, externalRef: d.external_ref, chat: chatRef(d.account_id, d.jid), text: d.body, at: new Date().toISOString() });
}

/** Job del worker; lanza para reintentar con backoff. */
export async function deliverWebhook(deliveryId: string) {
  const { rows } = await pool.query(
    `SELECT d.*, h.url, h.secret, h.revoked_at, h.user_id, h.chats, t.wa_account_ids, t.revoked_at AS token_revoked FROM mcp_webhook_deliveries d
       JOIN mcp_webhooks h ON h.id = d.webhook_id JOIN mcp_tokens t ON t.id = h.token_id WHERE d.id = $1`,
    [deliveryId],
  );
  const d = rows[0];
  if (!d || d.delivered_at || d.revoked_at || d.token_revoked) return;
  const scope = d.payload.scope as { accountId: string; jid: string } | undefined;
  if (scope) {
    const ok = await pool.query(`SELECT 1 FROM wa_chats c JOIN wa_accounts a ON a.id = c.account_id WHERE ${ALLOWED} AND c.account_id = $3 AND c.jid = $4`,
      [d.user_id, d.wa_account_ids, scope.accountId, scope.jid]);
    if (!ok.rowCount) return;
  }
  const { scope: _s, ...event } = d.payload;
  const body = JSON.stringify(event);
  let status = 0; let error: string | null = null;
  try {
    const r = await post(new URL(d.url), body, { 'x-chaggu-event': d.event_type, 'x-chaggu-delivery': d.id, 'x-chaggu-signature': sign(unseal(d.secret), body) });
    status = r.status;
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch { error = 'No se pudo entregar al destino'; }
  await pool.query('UPDATE mcp_webhook_deliveries SET attempts = attempts + 1, last_status = $2, last_error = $3, delivered_at = CASE WHEN $3::text IS NULL THEN now() END WHERE id = $1', [d.id, status || null, error]);
  if (error) throw new Error(`Webhook MCP ${d.id}: ${error}`);
}

// ---------- 6. Transcripción de notas de voz ----------

export async function queueTranscriptions(accountId: string, jid: string, ids: string[]) {
  const { rows } = await pool.query(
    `UPDATE wa_messages SET transcript = '{"status":"pending"}' WHERE account_id = $1 AND chat_jid = $2 AND id = ANY($3) AND transcript IS NULL
       AND kind = 'audio' AND media_state = 'ready' AND media_info->>'kind' = 'voice' RETURNING id`,
    [accountId, jid, ids],
  );
  for (const r of rows) await pool.query("INSERT INTO jobs (kind, payload, max_attempts) VALUES ('wa.transcribe', $1, 2)", [JSON.stringify({ accountId, jid, id: r.id })]);
  return rows.length;
}

/** Notas de voz listas en números/chats compartidos con integraciones: se transcriben solas (lo llama el worker). */
export async function queueSharedVoiceNotes(limit = 20) {
  const { rows } = await pool.query(
    `SELECT m.account_id, m.chat_jid, m.id FROM wa_messages m JOIN wa_chats c ON c.account_id = m.account_id AND c.jid = m.chat_jid
       JOIN wa_accounts a ON a.id = m.account_id
      WHERE m.kind = 'audio' AND m.media_state = 'ready' AND m.media_info->>'kind' = 'voice' AND m.transcript IS NULL
        AND m.sent_at > now() - interval '3 days' AND a.removed_at IS NULL AND (a.integrations_enabled OR c.integrations_shared)
        AND (SELECT count(*) FROM wa_messages x WHERE x.account_id = m.account_id AND x.transcript IS NOT NULL AND x.sent_at > now() - interval '1 day') < $2
      ORDER BY m.sent_at DESC LIMIT $1`,
    [limit, Number(process.env.WA_TRANSCRIBE_DAILY_MAX ?? 300)],
  );
  let n = 0;
  for (const r of rows) n += await queueTranscriptions(r.account_id, r.chat_jid, [r.id]);
  return n;
}

export async function transcribeWaVoice(p: { accountId: string; jid: string; id: string }) {
  const { getTranscriber, getSummarizer, toPcm16, chunkPcm, wavFromPcm } = await import('./voice-providers.ts');
  const { getObject } = await import('../storage.ts');
  const row = (await pool.query('SELECT media_info, sent_at FROM wa_messages WHERE account_id = $1 AND chat_jid = $2 AND id = $3 AND wa_chat_visible(account_id, chat_jid)', [p.accountId, p.jid, p.id])).rows[0];
  const save = (t: object) => pool.query('UPDATE wa_messages SET transcript = $4 WHERE account_id = $1 AND chat_jid = $2 AND id = $3', [p.accountId, p.jid, p.id, JSON.stringify(t)]);
  if (!row?.media_info) { await save({ status: 'unavailable' }); return; }
  const transcriber = getTranscriber();
  if (!transcriber) { await save({ status: 'disabled' }); return; }
  const maxMs = Number(process.env.WA_TRANSCRIBE_MAX_MS ?? 10 * 60_000);
  if ((row.media_info.durationMs ?? 0) > maxMs) { await save({ status: 'too_long' }); return; }
  try {
    const audio = (await getObject(row.media_info.key)).body;
    const parts: string[] = [];
    let language: string | null = null;
    if (transcriber.accepts.has(row.media_info.contentType) && audio.length <= transcriber.maxBytes) {
      const r = await transcriber.transcribe(audio, 'es-ES'); parts.push(r.text); language = r.language;
    } else {
      for (const chunk of chunkPcm(await toPcm16(audio), transcriber.maxBytes - 44)) { const r = await transcriber.transcribe(wavFromPcm(chunk), 'es-ES'); parts.push(r.text); language ??= r.language; }
    }
    const text = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    let summary: string | null = null;
    const summarizer = getSummarizer();
    if (summarizer && text.split(/\s+/).length >= 40) {
      try { summary = (await summarizer.summarize(text, { language: 'es', wantSummary: true, authorName: 'el contacto de WhatsApp', participants: [], conversationName: null })).summary; } catch { /* sin resumen */ }
    }
    await save({ status: 'done', text, language, summary });
    const { rows: hooks } = await pool.query(
      `SELECT h.id FROM mcp_webhooks h JOIN mcp_tokens t ON t.id = h.token_id WHERE h.revoked_at IS NULL AND t.revoked_at IS NULL
         AND 'whatsapp.message.transcribed' = ANY(h.events) AND $1 = ANY(h.chats)`,
      [chatRef(p.accountId, p.jid)],
    );
    for (const h of hooks) await queueDelivery(h.id, 'whatsapp.message.transcribed', { chat: chatRef(p.accountId, p.jid), messageId: p.id, transcript: text, summary }, p.accountId, p.jid);
  } catch (e: any) {
    await save({ status: 'failed', error: String(e?.message ?? e).slice(0, 200) });
  }
}
