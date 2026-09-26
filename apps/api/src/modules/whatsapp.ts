/**
 * Conectar WhatsApp (lado del API). El puente (src/wa-bridge.ts) mantiene las
 * sesiones vivas; aquí solo se crean, se listan y se organizan. Todo pertenece a
 * su dueño: cada consulta filtra por user_id.
 */
import QRCode from 'qrcode';
import type { WaAccountDTO, WaChatDTO, WaMessageDTO } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { pool, tx } from '../db.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { suggestCategory, type WaCategory } from './wa-organize.ts';

export const MAX_WA_ACCOUNTS = 5;

async function toAccountDTO(r: any): Promise<WaAccountDTO> {
  return {
    id: r.id,
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

export async function updateAccount(userId: string, id: string, input: { label?: string; kind?: 'personal' | 'business' }) {
  await ownAccount(pool, userId, id);
  await pool.query(
    'UPDATE wa_accounts SET label = COALESCE($3, label), kind = COALESCE($4, kind), updated_at = now() WHERE id = $1 AND user_id = $2',
    [id, userId, input.label ?? null, input.kind ?? null],
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

function toChatDTO(r: any): WaChatDTO {
  return {
    accountId: r.account_id,
    accountLabel: r.account_label,
    accountKind: r.account_kind,
    jid: r.jid,
    name: r.name ?? r.jid.split('@')[0],
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
  };
}

export async function listChats(userId: string, q: { accountId?: string; category?: WaCategory; groups?: boolean; search?: string; hidden?: boolean; limit: number }) {
  const { rows } = await pool.query(
    `SELECT c.*, COALESCE(c.name, ct.name) AS name, a.label AS account_label, a.kind AS account_kind
       FROM wa_chats c JOIN wa_accounts a ON a.id = c.account_id
       LEFT JOIN wa_contacts ct ON ct.account_id = c.account_id AND ct.jid = c.jid
      WHERE a.user_id = $1 AND a.removed_at IS NULL
        AND ($2::uuid IS NULL OR c.account_id = $2)
        AND ($3::text IS NULL OR c.category = $3)
        AND ($4::boolean IS NULL OR c.is_group = $4)
        AND ($5::text IS NULL OR COALESCE(c.name, ct.name) ILIKE '%' || $5 || '%')
        AND c.hidden = $6
        AND c.jid NOT LIKE '%@broadcast' AND c.jid NOT LIKE '%@newsletter'
      ORDER BY c.pinned DESC, c.last_message_at DESC NULLS LAST
      LIMIT $7`,
    [userId, q.accountId ?? null, q.category ?? null, q.groups ?? null, q.search?.trim() || null, q.hidden ?? false, q.limit],
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
  return { chats: rows.map(toChatDTO), categories: Object.fromEntries(counts.map((r) => [r.category, { total: r.n, unread: r.unread }])) };
}

async function ownChat(userId: string, accountId: string, jid: string) {
  const { rows } = await pool.query(
    `SELECT c.*, COALESCE(c.name, ct.name) AS name, a.label AS account_label, a.kind AS account_kind FROM wa_chats c JOIN wa_accounts a ON a.id = c.account_id
       LEFT JOIN wa_contacts ct ON ct.account_id = c.account_id AND ct.jid = c.jid
      WHERE c.account_id = $1 AND c.jid = $2 AND a.user_id = $3 AND a.removed_at IS NULL`,
    [accountId, jid, userId],
  );
  if (!rows[0]) throw notFound('Chat');
  return rows[0];
}

export async function updateChat(userId: string, accountId: string, jid: string, input: {
  category?: WaCategory | null; pinned?: boolean; hidden?: boolean; linkedConversationId?: string | null;
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
  return toChatDTO(await ownChat(userId, accountId, jid));
}

/** Vuelve a pasar el organizador sobre todo lo que no se ha clasificado a mano. */
export async function reorganize(userId: string) {
  const { rows } = await pool.query(
    `SELECT c.account_id, c.jid, COALESCE(c.name, ct.name) AS name, c.is_group, c.category, a.kind FROM wa_chats c JOIN wa_accounts a ON a.id = c.account_id
       LEFT JOIN wa_contacts ct ON ct.account_id = c.account_id AND ct.jid = c.jid
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
    `SELECT * FROM wa_messages WHERE account_id = $1 AND chat_jid = $2 AND ($3::timestamptz IS NULL OR sent_at < $3)
      ORDER BY sent_at DESC LIMIT $4`,
    [accountId, jid, before ?? null, limit],
  );
  const messages: WaMessageDTO[] = rows.reverse().map((r) => ({
    id: r.id, fromMe: r.from_me, author: r.from_me ? null : (r.author_name ?? r.author_jid?.split('@')[0] ?? null),
    kind: r.kind, body: r.body, sentAt: new Date(r.sent_at).toISOString(),
    ...(r.reactions ? { reactions: Object.values(r.reactions as Record<string, { emoji: string; name: string }>) } : {}),
  }));
  await pool.query('UPDATE wa_chats SET unread = 0 WHERE account_id = $1 AND jid = $2 AND unread > 0', [accountId, jid]);
  return { messages, hasMore: rows.length === limit };
}
