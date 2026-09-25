/**
 * Menciones con @. El body es texto plano; las menciones van aparte (offsets UTF-16 sobre el body ya recortado).
 * Se validan contra los participantes: lo inválido se descarta y se informa (droppedMentions), nunca da error.
 */
import type { MentionDTO, MentionItemDTO } from '@tiecoms/contracts';
import type { Db, Tx } from '../db.ts';
import { pool } from '../db.ts';
import { toMessageDTO } from './messages.ts';

export const MAX_ALL_MEMBERS = 100;

export interface MentionResult { mentions: MentionDTO[]; dropped: string[]; userIds: string[]; all: boolean }

/**
 * Filtra las menciones: tramo dentro del body que empieza con «@», sin solaparse; usuarios que participan
 * (activos) en la conversación; @todos solo en grupos, internos, multi y laterales, con ≤ 100 participantes
 * salvo que quien escribe administre la conversación.
 */
export async function normalizeMentions(
  db: Db, conversationId: string, authorId: string, body: string,
  input: { userId: string; start: number; length: number }[] | undefined,
  access: { kind: string; canManage: boolean },
): Promise<MentionResult> {
  const out: MentionResult = { mentions: [], dropped: [], userIds: [], all: false };
  if (!input?.length) return out;
  const { rows } = await db.query('SELECT user_id FROM conversation_memberships WHERE conversation_id = $1 AND removed_at IS NULL', [conversationId]);
  const members = new Set(rows.map((r) => r.user_id as string));
  const sorted = [...input].sort((a, b) => a.start - b.start);
  let lastEnd = -1;
  const drop = (id: string) => { if (!out.dropped.includes(id)) out.dropped.push(id); };
  for (const m of sorted) {
    const inRange = m.start >= 0 && m.start + m.length <= body.length && body[m.start] === '@' && m.start >= lastEnd;
    if (!inRange) { drop(m.userId); continue; }
    if (m.userId === 'all') {
      const allowed = access.kind !== 'direct' && (members.size <= MAX_ALL_MEMBERS || access.canManage);
      if (!allowed) { drop('all'); continue; }
      out.all = true;
    } else if (!members.has(m.userId)) { drop(m.userId); continue; }
    out.mentions.push({ userId: m.userId, start: m.start, length: m.length });
    lastEnd = m.start + m.length;
  }
  const direct = new Set(out.mentions.filter((m) => m.userId !== 'all').map((m) => m.userId));
  out.userIds = [...(out.all ? members : direct)].filter((u) => u !== authorId);
  // Quien menciona a alguien y a @todos: la fila individual gana (is_all = false).
  (out as any).directIds = direct;
  return out;
}

/** Guarda las filas de la bandeja (reemplaza las del mensaje, conservando lo ya leído). */
export async function saveMentions(c: Tx, messageId: string, conversationId: string, seq: number, r: MentionResult) {
  const direct: Set<string> = (r as any).directIds ?? new Set();
  await c.query('DELETE FROM message_mentions WHERE message_id = $1 AND NOT (user_id = ANY($2))', [messageId, r.userIds]);
  for (const uid of r.userIds) {
    await c.query(
      `INSERT INTO message_mentions (message_id, user_id, conversation_id, seq, is_all) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (message_id, user_id) DO UPDATE SET is_all = EXCLUDED.is_all`,
      [messageId, uid, conversationId, seq, !direct.has(uid)],
    );
  }
}

/** Al leer una conversación hasta seq, sus menciones quedan leídas. */
export async function markMentionsRead(c: Tx, userId: string, conversationId: string, seq: number) {
  await c.query('UPDATE message_mentions SET read_at = now() WHERE user_id = $1 AND conversation_id = $2 AND seq <= $3 AND read_at IS NULL', [userId, conversationId, seq]);
}

/** Bandeja «Menciones»: las más recientes primero, solo de conversaciones que puedo leer y dentro de mi historial. */
export async function listMentions(userId: string, before: string | undefined, limit: number): Promise<{ mentions: MentionItemDTO[]; hasMore: boolean }> {
  const { rows } = await pool.query(
    `SELECT mm.is_all, mm.created_at AS mentioned_at, m.*, GREATEST(COALESCE(rc.last_read_seq, 0), cm.history_from_seq) AS read_from
       FROM message_mentions mm
       JOIN messages m ON m.id = mm.message_id AND m.deleted_at IS NULL
       JOIN conversations c ON c.id = mm.conversation_id AND c.archived_at IS NULL
       JOIN conversation_memberships cm ON cm.conversation_id = c.id AND cm.user_id = $1 AND cm.removed_at IS NULL AND m.seq > cm.history_from_seq
       LEFT JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id AND wm.user_id = $1
       LEFT JOIN read_cursors rc ON rc.conversation_id = c.id AND rc.user_id = $1
      WHERE mm.user_id = $1 AND ($2::timestamptz IS NULL OR mm.created_at < $2)
        AND (c.workspace_id IS NULL OR (wm.user_id IS NOT NULL AND wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at > now())))
      ORDER BY mm.created_at DESC LIMIT $3`,
    [userId, before ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  return {
    mentions: page.map((r) => ({
      message: toMessageDTO(r), conversationId: r.conversation_id, all: r.is_all, read: Number(r.seq) <= Number(r.read_from),
      createdAt: new Date(r.mentioned_at).toISOString(),
    })),
    hasMore: rows.length > limit,
  };
}

/** Quiénes están mencionados en un mensaje (para el push). */
export async function mentionedIn(db: Db, messageId: string): Promise<Set<string>> {
  const { rows } = await db.query('SELECT user_id FROM message_mentions WHERE message_id = $1', [messageId]);
  return new Set(rows.map((r) => r.user_id as string));
}
