import type { ReminderDTO } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { enqueueOutbox, pool, tx } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';

const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const toDTO = (r: any): ReminderDTO => ({
  id: r.id, conversationId: r.conversation_id, messageId: r.message_id, messageSeq: r.message_seq ?? null, note: r.note,
  remindAt: iso(r.remind_at)!, firedAt: iso(r.fired_at), doneAt: iso(r.done_at),
});
const SELECT = 'SELECT r.*, m.seq AS message_seq FROM reminders r LEFT JOIN messages m ON m.id = r.message_id';

export async function createReminder(userId: string, input: { conversationId: string; messageId?: string | null; note?: string | null; remindAt: string }) {
  const a = await conversationAccess(pool, userId, input.conversationId, 'read');
  if (input.messageId) {
    const m = await pool.query('SELECT seq FROM messages WHERE id = $1 AND conversation_id = $2', [input.messageId, input.conversationId]);
    if (!m.rows[0] || m.rows[0].seq <= a.historyFromSeq) throw badRequest('El mensaje no está en esta conversación');
  }
  if (Date.parse(input.remindAt) < Date.now() - 60_000) throw badRequest('La hora del recordatorio ya pasó');
  const { rows } = await pool.query(
    'INSERT INTO reminders (user_id, conversation_id, message_id, note, remind_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [userId, input.conversationId, input.messageId ?? null, input.note ?? null, input.remindAt],
  );
  return (await pool.query(`${SELECT} WHERE r.id = $1`, [rows[0].id])).rows.map(toDTO)[0]!;
}

/** Recordatorios pendientes y ya disparados sin atender, de conversaciones que la persona aún puede leer. */
export async function listReminders(userId: string) {
  const { rows } = await pool.query(
    `${SELECT} JOIN conversation_memberships cm ON cm.conversation_id = r.conversation_id AND cm.user_id = r.user_id AND cm.removed_at IS NULL
      WHERE r.user_id = $1 AND r.done_at IS NULL ORDER BY r.remind_at`,
    [userId],
  );
  return rows.map(toDTO);
}

export async function completeReminder(userId: string, id: string, snoozeUntil?: string) {
  const { rows } = snoozeUntil
    ? await pool.query('UPDATE reminders SET remind_at = $3, fired_at = NULL WHERE id = $1 AND user_id = $2 AND done_at IS NULL RETURNING id', [id, userId, snoozeUntil])
    : await pool.query('UPDATE reminders SET done_at = now() WHERE id = $1 AND user_id = $2 AND done_at IS NULL RETURNING id', [id, userId]);
  if (!rows[0]) throw notFound('Recordatorio');
  return { ok: true };
}

/**
 * Lo llama el worker: dispara los recordatorios vencidos. Revalida el acceso;
 * si la persona ya no está en la conversación, el recordatorio se cierra sin aviso.
 */
export async function fireDueReminders(): Promise<number> {
  return tx(async (c) => {
    const { rows } = await c.query(
      `${SELECT} WHERE r.fired_at IS NULL AND r.done_at IS NULL AND r.remind_at <= now()
        ORDER BY r.remind_at LIMIT 200 FOR UPDATE OF r SKIP LOCKED`,
    );
    for (const r of rows) {
      const ok = await c.query('SELECT 1 FROM conversation_memberships WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL', [r.conversation_id, r.user_id]);
      if (!ok.rowCount) { await c.query('UPDATE reminders SET done_at = now() WHERE id = $1', [r.id]); continue; }
      const u = await c.query('UPDATE reminders SET fired_at = now() WHERE id = $1 RETURNING fired_at', [r.id]);
      await enqueueOutbox(c, 'account.event', { userIds: [r.user_id], event: { type: 'reminder.due', reminder: toDTO({ ...r, fired_at: u.rows[0].fired_at }) } });
      await c.query("INSERT INTO jobs (kind, payload, max_attempts) VALUES ('push.reminder', $1, 2)", [JSON.stringify({ reminderId: r.id })]);
    }
    return rows.length;
  });
}
