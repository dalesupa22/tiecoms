import { waMediaDTO } from './wa-media.ts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
/**
 * Conectar WhatsApp (lado del API). El puente (src/wa-bridge.ts) mantiene las
 * sesiones vivas; aquí solo se crean, se listan y se organizan. Todo pertenece a
 * su dueño: cada consulta filtra por user_id.
 */
import QRCode from 'qrcode';
import type { WaAccountDTO, WaChatDTO, WaMessageDTO } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { enqueueOutbox, pool, tx } from '../db.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { suggestCategory, type WaCategory } from './wa-organize.ts';

export const MAX_WA_ACCOUNTS = 5;

async function toAccountDTO(r: any): Promise<WaAccountDTO> {
  return {
    id: r.id,
    sendEnabled: r.send_enabled === true,
    label: r.label,
    kind: r.kind,
    status: r.status,
    phone: r.phone,
    pushName: r.push_name,
    platform: r.platform,
    // El QR se entrega ya dibujado: el cliente no necesita otra librería.
    qr: r.status === 'qr' && r.qr ? await QRCode.toDataURL(r.qr, { margin: 1, width: 280 }) : null,
    pairingCode: r.status === 'qr' ? r.pairing_code : null,
    lastError: r.last_error,
    connectedAt: r.connected_at ? new Date(r.connected_at).toISOString() : null,
    lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
    chats: Number(r.chats ?? 0),
    groups: Number(r.groups ?? 0),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

const ACCOUNT_SELECT = `SELECT a.*, (SELECT count(*) FROM wa_chats c WHERE c.account_id = a.id) AS chats,
                               (SELECT count(*) FROM wa_chats c WHERE c.account_id = a.id AND c.is_group) AS groups
                          FROM wa_accounts a`;

export async function listAccounts(userId: string) {
  const { rows } = await pool.query(`${ACCOUNT_SELECT} WHERE a.user_id = $1 AND a.removed_at IS NULL ORDER BY a.created_at`, [userId]);
  return Promise.all(rows.map(toAccountDTO));
}

async function ownAccount(db: typeof pool | any, userId: string, id: string) {
  const { rows } = await db.query('SELECT * FROM wa_accounts WHERE id = $1 AND user_id = $2 AND removed_at IS NULL', [id, userId]);
  if (!rows[0]) throw notFound('Cuenta de WhatsApp');
  return rows[0];
}

const normPhone = (p?: string | null) => (p ? p.replace(/\D/g, '') || null : null);

export async function createAccount(userId: string, input: { label: string; kind: 'personal' | 'business'; pairPhone?: string | null }) {
  const phone = normPhone(input.pairPhone);
  if (phone && (phone.length < 8 || phone.length > 15)) throw badRequest('Escribe el número con indicativo de país, p. ej. 573001234567');
  const id = await tx(async (c) => {
    // Bloquea al usuario para que dos clics seguidos no pasen el límite.
    await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const { rows: n } = await c.query('SELECT count(*)::int AS n FROM wa_accounts WHERE user_id = $1 AND removed_at IS NULL', [userId]);
    if (n[0].n >= MAX_WA_ACCOUNTS) throw conflict(`Puedes conectar hasta ${MAX_WA_ACCOUNTS} cuentas de WhatsApp`);
    const { rows } = await c.query(
      'INSERT INTO wa_accounts (user_id, label, kind, pair_phone) VALUES ($1,$2,$3,$4) RETURNING id',
      [userId, input.label, input.kind, phone],
    );
    return rows[0].id as string;
  });
  await pool.query("SELECT pg_notify('tiecoms_wa', $1)", [id]);
  return (await listAccounts(userId)).find((a) => a.id === id)!;
}

export async function updateAccount(userId: string, id: string, input: { label?: string; kind?: 'personal' | 'business'; sendEnabled?: boolean }) {
  await ownAccount(pool, userId, id);
  await pool.query(
    'UPDATE wa_accounts SET label = COALESCE($3, label), kind = COALESCE($4, kind), send_enabled = COALESCE($5, send_enabled), updated_at = now() WHERE id = $1 AND user_id = $2',
    [id, userId, input.label ?? null, input.kind ?? null, input.sendEnabled ?? null],
  );
  return (await listAccounts(userId)).find((a) => a.id === id)!;
}

/** Nuevo código QR (o código de 8 letras) para una cuenta que venció o se cerró desde el teléfono. */
export async function relinkAccount(userId: string, id: string, pairPhone?: string | null) {
  const a = await ownAccount(pool, userId, id);
  if (a.status === 'connected') return (await listAccounts(userId)).find((x) => x.id === id)!;
  await tx(async (c) => {
    if (a.status === 'logged_out' || a.status === 'error') await c.query('DELETE FROM wa_auth WHERE account_id = $1', [id]);
    await c.query(
      `UPDATE wa_accounts SET status = 'pending', qr = NULL, pairing_code = NULL, last_error = NULL,
              pair_phone = COALESCE($2, pair_phone), lease_until = NULL, updated_at = now() WHERE id = $1`,
      [id, normPhone(pairPhone)],
    );
  });
  await pool.query("SELECT pg_notify('tiecoms_wa', $1)", [id]);
  return (await listAccounts(userId)).find((x) => x.id === id)!;
}

/** Desconectar: el puente cierra la sesión en WhatsApp y borra todo lo guardado de esa cuenta. */
export async function removeAccount(userId: string, id: string) {
  await ownAccount(pool, userId, id);
  await pool.query("UPDATE wa_accounts SET removed_at = now(), updated_at = now() WHERE id = $1", [id]);
  await pool.query("SELECT pg_notify('tiecoms_wa', $1)", [id]);
  return { ok: true };
}

/**
 * Nombre y número de un jid de WhatsApp. Muchos llegan como LID (@lid): el nombre se busca por el LID
 * y por el número equivalente (wa_jid_alias). Primero la libreta, luego el pushName (wa_contacts.push_name).
 */
const whoSql = (acc: string, jid: string) => `(SELECT
    COALESCE((SELECT name FROM wa_contacts WHERE account_id = ${acc} AND jid = ${jid}),
             (SELECT k.name FROM wa_jid_alias al JOIN wa_contacts k ON k.account_id = al.account_id AND k.jid = al.pn
               WHERE al.account_id = ${acc} AND al.lid = ${jid}),
             (SELECT push_name FROM wa_contacts WHERE account_id = ${acc} AND jid = ${jid}),
             (SELECT k.push_name FROM wa_jid_alias al JOIN wa_contacts k ON k.account_id = al.account_id AND k.jid = al.pn
               WHERE al.account_id = ${acc} AND al.lid = ${jid})) AS name,
    COALESCE((SELECT pn FROM wa_jid_alias WHERE account_id = ${acc} AND lid = ${jid}),
             CASE WHEN ${jid} LIKE '%@s.whatsapp.net' THEN ${jid} END) AS pn)`;

/** «+57 300 5750500» a partir de un jid de número; null si solo hay LID. */
export function phoneLabel(pn: string | null | undefined) {
  const d = pn?.split('@')[0];
  if (!d || !/^\d{6,15}$/.test(d)) return null;
  return d.startsWith('57') && d.length === 12 ? `+57 ${d.slice(2, 5)} ${d.slice(5)}` : `+${d}`;
}

function toChatDTO(r: any): WaChatDTO {
  return {
    accountId: r.account_id,
    accountLabel: r.account_label,
    accountKind: r.account_kind,
    jid: r.jid,
    name: r.name ?? phoneLabel(r.pn) ?? r.jid.split('@')[0],
    isGroup: r.is_group,
    participants: r.participants,
    description: r.description,
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
    lastPreview: r.last_preview,
    unread: r.unread,
    category: r.category,
    categoryManual: r.category_manual,
    pinned: r.pinned,
    hidden: r.hidden,
    archivedInWhatsApp: r.wa_archived,
    linkedConversationId: r.linked_conversation_id,
    inboxPlace: r.inbox_place ?? null,
    inboxPinnedAt: r.inbox_pinned_at ? new Date(r.inbox_pinned_at).toISOString() : null,
    ...(r.account_status ? { accountStatus: r.account_status } : {}),
  };
}

export async function listChats(userId: string, q: { accountId?: string; category?: WaCategory; groups?: boolean; search?: string; hidden?: boolean; limit: number; cursor?: string }) {
  const scope = JSON.stringify([userId,q.accountId ?? null,q.category ?? null,q.groups ?? null,q.search?.trim() || null,q.hidden ?? false]);
  let cursor: { p: boolean; t: string | null; a: string; j: string } | null = null;
  if (q.cursor) {
    try {
      const [raw,sig] = q.cursor.split('.');
      const expected=createHmac('sha256',config.jwtSecret).update(scope+':'+raw).digest();
      const actual=Buffer.from(sig!, 'base64url');
      if (expected.length!==actual.length || !timingSafeEqual(expected,actual)) throw new Error('scope');
      cursor=JSON.parse(Buffer.from(raw!,'base64url').toString('utf8'));
      if (typeof cursor?.p!=='boolean' || typeof cursor.a!=='string' || typeof cursor.j!=='string' || (cursor.t!==null && !Number.isFinite(Date.parse(cursor.t)))) throw new Error('cursor');
    } catch { throw badRequest('Cursor de WhatsApp inválido para estos filtros'); }
  }

  const { rows } = await pool.query(
    `SELECT c.*, COALESCE(c.name, ct.name) AS name, ct.pn, a.label AS account_label, a.kind AS account_kind, a.status AS account_status
       FROM wa_chats c JOIN wa_accounts a ON a.id = c.account_id
       LEFT JOIN LATERAL ${whoSql('c.account_id', 'c.jid')} ct ON true
      WHERE a.user_id = $1 AND a.removed_at IS NULL
        AND ($2::uuid IS NULL OR c.account_id = $2)
        AND ($3::text IS NULL OR c.category = $3)
        AND ($4::boolean IS NULL OR c.is_group = $4)
        AND ($5::text IS NULL OR COALESCE(c.name, ct.name) ILIKE '%' || $5 || '%')
        AND c.hidden = $6
        AND c.jid NOT LIKE '%@broadcast' AND c.jid NOT LIKE '%@newsletter'
      AND ($8::boolean IS NULL OR c.pinned<$8 OR (c.pinned=$8 AND (
          ($9::timestamptz IS NOT NULL AND (c.last_message_at<$9 OR c.last_message_at IS NULL)) OR
          (c.last_message_at IS NOT DISTINCT FROM $9::timestamptz AND (c.account_id,c.jid)>($10::uuid,$11::text)))))
      ORDER BY c.pinned DESC, c.last_message_at DESC NULLS LAST, c.account_id ASC, c.jid ASC
      LIMIT $7`,
    [userId, q.accountId ?? null, q.category ?? null, q.groups ?? null, q.search?.trim() || null, q.hidden ?? false, q.limit+1, cursor?.p ?? null, cursor?.t ?? null, cursor?.a ?? null, cursor?.j ?? null],
  );
  const { rows: counts } = await pool.query(
    `SELECT c.category, count(*)::int AS n, sum(CASE WHEN c.unread > 0 THEN 1 ELSE 0 END)::int AS unread
       FROM wa_chats c JOIN wa_accounts a ON a.id = c.account_id
      WHERE a.user_id = $1 AND a.removed_at IS NULL AND NOT c.hidden AND ($2::uuid IS NULL OR c.account_id = $2)
        AND ($3::boolean IS NULL OR c.is_group = $3)
        AND c.jid NOT LIKE '%@broadcast' AND c.jid NOT LIKE '%@newsletter'
      GROUP BY c.category`,
    [userId, q.accountId ?? null, q.groups ?? null],
  );
  const hasMore=rows.length>q.limit;
  const page=rows.slice(0,q.limit), last=page.at(-1);
  const raw=last ? Buffer.from(JSON.stringify({p:last.pinned,t:last.last_message_at ? new Date(last.last_message_at).toISOString() : null,a:last.account_id,j:last.jid})).toString('base64url') : '';
  const next=hasMore ? raw+'.'+createHmac('sha256',config.jwtSecret).update(scope+':'+raw).digest('base64url') : null;
  return { chats: page.map(toChatDTO), hasMore, next, syncPartial:true, categories: Object.fromEntries(counts.map((r) => [r.category, { total: r.n, unread: r.unread }])) };
}

export async function ownChat(userId: string, accountId: string, jid: string) {
  const { rows } = await pool.query(
    `SELECT c.*, COALESCE(c.name, ct.name) AS name, ct.pn, a.label AS account_label, a.kind AS account_kind, a.status AS account_status FROM wa_chats c JOIN wa_accounts a ON a.id = c.account_id
       LEFT JOIN LATERAL ${whoSql('c.account_id', 'c.jid')} ct ON true
      WHERE c.account_id = $1 AND c.jid = $2 AND a.user_id = $3 AND a.removed_at IS NULL`,
    [accountId, jid, userId],
  );
  if (!rows[0]) throw notFound('Chat');
  return rows[0];
}

export async function updateChat(userId: string, accountId: string, jid: string, input: {
  category?: WaCategory | null; pinned?: boolean; hidden?: boolean; linkedConversationId?: string | null;
  inboxPlace?: 'groups' | 'dms' | 'auto' | null; inboxPinned?: boolean;
}) {
  const chat = await ownChat(userId, accountId, jid);
  // Vincular exige poder publicar en esa conversación: los mensajes entran a nombre de quien vincula.
  if (input.linkedConversationId) await conversationAccess(pool, userId, input.linkedConversationId, 'post');
  const auto = input.category === null ? suggestCategory(chat.name, { isGroup: chat.is_group, accountKind: chat.account_kind }) : null;
  await pool.query(
    `UPDATE wa_chats SET
        category = COALESCE($3, category),
        category_manual = CASE WHEN $4 THEN $5 ELSE category_manual END,
        pinned = COALESCE($6, pinned),
        hidden = COALESCE($7, hidden),
        linked_conversation_id = CASE WHEN $8 THEN $9::uuid ELSE linked_conversation_id END,
        linked_since = CASE WHEN $8 THEN (CASE WHEN $9::uuid IS NULL THEN NULL ELSE now() END) ELSE linked_since END,
        updated_at = now()
      WHERE account_id = $1 AND jid = $2`,
    [accountId, jid, input.category ?? auto, input.category !== undefined, input.category !== null, input.pinned ?? null, input.hidden ?? null,
      input.linkedConversationId !== undefined, input.linkedConversationId ?? null],
  );
  // Bandeja (docs/WA-BANDEJA-GG-CHAT.md): 'auto' = grupo → Grupos, 1 a 1 → DMs; fijar sin haberlo movido lo mueve solo.
  const touchesInbox = input.inboxPlace !== undefined || input.inboxPinned !== undefined;
  if (touchesInbox) {
    const auto = chat.is_group ? 'groups' : 'dms';
    let place: string | null = chat.inbox_place ?? null;
    let pinnedAt: Date | null = chat.inbox_pinned_at ?? null;
    if (input.inboxPlace !== undefined) place = input.inboxPlace === 'auto' ? auto : input.inboxPlace;
    if (input.inboxPinned === true) { pinnedAt = pinnedAt ?? new Date(); place = place ?? auto; }
    if (input.inboxPinned === false) pinnedAt = null;
    if (place === null) pinnedAt = null;
    await pool.query('UPDATE wa_chats SET inbox_place = $3, inbox_pinned_at = $4, updated_at = now() WHERE account_id = $1 AND jid = $2', [accountId, jid, place, pinnedAt]);
  }
  const dto = toChatDTO(await ownChat(userId, accountId, jid));
  // Ocultar un chat que está en la bandeja también lo saca de ahí en los demás dispositivos.
  if (touchesInbox || (input.hidden !== undefined && dto.inboxPlace)) await emitInbox(userId, dto);
  return dto;
}

/** Aviso a la dueña: cambió una fila de WhatsApp de su bandeja (el cliente la reemplaza sin recargar el bootstrap). */
export async function emitInbox(userId: string, chat: WaChatDTO) {
  await tx((c) => enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'wa.inbox', chat } }));
}

/** Para el bootstrap: los chats de WhatsApp movidos a la bandeja, de cuentas vivas y sin ocultar. */
export async function inboxChats(userId: string, only?: { accountId: string; jids: string[] }) {
  const { rows } = await pool.query(
    `SELECT c.*, COALESCE(c.name, ct.name) AS name, ct.pn, a.label AS account_label, a.kind AS account_kind, a.status AS account_status
       FROM wa_chats c JOIN wa_accounts a ON a.id = c.account_id
       LEFT JOIN LATERAL ${whoSql('c.account_id', 'c.jid')} ct ON true
      WHERE a.user_id = $1 AND a.removed_at IS NULL AND c.inbox_place IS NOT NULL AND NOT c.hidden
        AND ($2::uuid IS NULL OR (c.account_id = $2 AND c.jid = ANY($3)))
      ORDER BY c.inbox_pinned_at DESC NULLS LAST, c.last_message_at DESC NULLS LAST
      LIMIT 300`,
    [userId, only?.accountId ?? null, only?.jids ?? []],
  );
  return rows.map(toChatDTO);
}

/** Vuelve a pasar el organizador sobre todo lo que no se ha clasificado a mano. */
export async function reorganize(userId: string) {
  const { rows } = await pool.query(
    `SELECT c.account_id, c.jid, COALESCE(c.name, ct.name) AS name, c.is_group, c.category, a.kind FROM wa_chats c JOIN wa_accounts a ON a.id = c.account_id
       LEFT JOIN LATERAL ${whoSql('c.account_id', 'c.jid')} ct ON true
      WHERE a.user_id = $1 AND a.removed_at IS NULL AND NOT c.category_manual`,
    [userId],
  );
  let changed = 0;
  for (const r of rows) {
    const cat = suggestCategory(r.name, { isGroup: r.is_group, accountKind: r.kind });
    if (cat === r.category) continue;
    await pool.query('UPDATE wa_chats SET category = $3, updated_at = now() WHERE account_id = $1 AND jid = $2', [r.account_id, r.jid, cat]);
    changed++;
  }
  return { reviewed: rows.length, changed };
}

export async function listChatMessages(userId: string, accountId: string, jid: string, before: string | undefined, limit: number) {
  await ownChat(userId, accountId, jid);
  const { rows } = await pool.query(
    `SELECT m.*, w.name AS who_name, w.pn AS who_pn FROM wa_messages m
       LEFT JOIN LATERAL ${whoSql('m.account_id', 'm.author_jid')} w ON NOT m.from_me
      WHERE m.account_id = $1 AND m.chat_jid = $2 AND ($3::timestamptz IS NULL OR m.sent_at < $3)
      ORDER BY m.sent_at DESC LIMIT $4`,
    [accountId, jid, before ?? null, limit],
  );
  const messages: WaMessageDTO[] = rows.reverse().map((r) => ({
    id: r.id, fromMe: r.from_me, author: r.from_me ? null : (r.author_name ?? r.who_name ?? phoneLabel(r.who_pn)),
    kind: r.kind, body: r.body, media:waMediaDTO(r), sentAt: new Date(r.sent_at).toISOString(),
    ...(r.reactions ? { reactions: Object.values(r.reactions as Record<string, { emoji: string; name: string }>) } : {}),
  }));
  const read = await pool.query('UPDATE wa_chats SET unread = 0 WHERE account_id = $1 AND jid = $2 AND unread > 0 RETURNING inbox_place', [accountId, jid]);
  // Leído en un dispositivo: la fila de la bandeja se apaga en los demás.
  if (read.rows[0]?.inbox_place) for (const chat of await inboxChats(userId, { accountId, jids: [jid] })) await emitInbox(userId, chat);
  return { messages, hasMore: rows.length === limit };
}

/**
 * Responder un chat de WhatsApp desde chaggu. Solo si la persona activó «Responder desde chaggu» en esa cuenta
 * (por defecto es de solo lectura). Se encola en wa_outbox y el puente, que tiene la sesión, lo manda; aquí se espera
 * hasta ~12 s por el resultado: si el puente tarda, queda 'queued' y sale en cuanto pueda.
 */
export async function sendToChat(userId: string, accountId: string, jid: string, text: string): Promise<{ id: string; status: 'sent' | 'queued' | 'failed'; error?: string }> {
  const a = await ownAccount(pool, userId, accountId);
  if (!a.send_enabled) throw forbidden('Esta cuenta está en solo lectura. Activa «Responder desde chaggu» en WhatsApp para poder escribir.');
  if (a.status !== 'connected') throw conflict('La cuenta de WhatsApp no está conectada ahora mismo');
  await ownChat(userId, accountId, jid);
  const { rows } = await pool.query('INSERT INTO wa_outbox (account_id, user_id, jid, body) VALUES ($1,$2,$3,$4) RETURNING id', [accountId, userId, jid, text]);
  const id = rows[0].id as string;
  await pool.query("SELECT pg_notify('tiecoms_wa', $1)", [accountId]);
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = (await pool.query('SELECT status, error FROM wa_outbox WHERE id = $1', [id])).rows[0];
    if (s?.status === 'sent') return { id, status: 'sent' };
    if (s?.status === 'failed') return { id, status: 'failed', error: s.error ?? 'No se pudo enviar' };
  }
  return { id, status: 'queued' };
}

/**
 * Para «gg de este chat» (gg-side.ts): los últimos mensajes de UN chat, o solo los ids pedidos (citados), sin marcar
 * nada como leído. Quien llama ya comprobó con ownChat que el chat es de la persona.
 */
export async function messagesForGg(accountId: string, jid: string, opts: { limit?: number; ids?: string[] }) {
  const { rows } = await pool.query(
    `SELECT m.id, m.from_me, m.body, m.kind, m.sent_at, COALESCE(m.author_name, w.name) AS author, w.pn FROM wa_messages m
       LEFT JOIN LATERAL ${whoSql('m.account_id', 'm.author_jid')} w ON NOT m.from_me
      WHERE m.account_id = $1 AND m.chat_jid = $2 AND m.body <> '' AND ($3::text[] IS NULL OR m.id = ANY($3))
      ORDER BY m.sent_at DESC LIMIT $4`,
    [accountId, jid, opts.ids ?? null, opts.limit ?? 60],
  );
  return rows.reverse().map((r) => ({
    id: String(r.id), mine: !!r.from_me, author: r.from_me ? null : (r.author ?? phoneLabel(r.pn) ?? 'Contacto'),
    text: String(r.body ?? ''), at: new Date(r.sent_at).toISOString(), seq: new Date(r.sent_at).getTime(),
  }));
}
