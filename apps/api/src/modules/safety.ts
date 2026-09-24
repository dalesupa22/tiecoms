import { conversationAccess } from '../access.ts';
import { audit, enqueueOutbox, pool, tx, type Db } from '../db.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { sendMail } from '../mail.ts';

export async function ensureNotBlocked(db: Db, userId: string, otherIds: string[]) {
  if (!otherIds.length) return;
  const { rowCount } = await db.query(
    `SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = ANY($2))
       OR (blocked_id = $1 AND blocker_id = ANY($2)) LIMIT 1`, [userId, otherIds],
  );
  if (rowCount) throw new ApiError(403, 'blocked_user', 'No se puede contactar a esta persona porque hay un bloqueo activo');
}

async function visiblePerson(db: Db, userId: string, otherId: string) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM users u WHERE u.id = $2 AND u.disabled_at IS NULL AND (
      EXISTS (SELECT 1 FROM organization_memberships a JOIN organization_memberships b ON b.org_id = a.org_id
        WHERE a.user_id = $1 AND b.user_id = u.id)
      OR EXISTS (SELECT 1 FROM conversation_memberships a JOIN conversation_memberships b ON b.conversation_id = a.conversation_id
        WHERE a.user_id = $1 AND b.user_id = u.id AND a.removed_at IS NULL AND b.removed_at IS NULL)
      OR EXISTS (SELECT 1 FROM workspace_memberships a JOIN workspace_memberships b ON b.workspace_id = a.workspace_id
        WHERE a.user_id = $1 AND b.user_id = u.id AND a.revoked_at IS NULL AND b.revoked_at IS NULL
          AND (a.expires_at IS NULL OR a.expires_at > now()) AND (b.expires_at IS NULL OR b.expires_at > now())))`,
    [userId, otherId],
  );
  if (!rowCount) throw notFound('Persona');
}

export async function listBlocks(userId: string) {
  const { rows } = await pool.query('SELECT blocked_id FROM user_blocks WHERE blocker_id = $1 ORDER BY created_at', [userId]);
  return { userIds: rows.map((r) => r.blocked_id as string) };
}

export async function setBlock(userId: string, otherId: string, blocked: boolean) {
  if (userId === otherId) throw badRequest('No puedes bloquearte');
  return tx(async (c) => {
    if (blocked) {
      await visiblePerson(c, userId, otherId);
      // Mismo bloqueo de conversación que usa el envío: al confirmar el bloqueo no
      // puede quedar un envío anterior pendiente de publicar en ese directo.
      await c.query("SELECT id FROM conversations WHERE kind = 'direct' AND dm_key = $1 FOR UPDATE", [[userId, otherId].sort().join(':')]);
      await c.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, otherId]);
    } else await c.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [userId, otherId]);
    await enqueueOutbox(c, 'account.event', { userIds: [userId, otherId], event: { type: 'scope.changed', reason: 'safety.updated' } });
    await audit(c, userId, blocked ? 'user.blocked' : 'user.unblocked', { type: 'user', id: otherId });
    return { ok: true };
  });
}

export async function report(userId: string, input: { userId?: string; messageId?: string; reason: string }) {
  if (!input.userId && !input.messageId) throw badRequest('Elige el mensaje o la persona que quieres reportar');
  return tx(async (c) => {
    let targetId = input.userId ?? null, conversationId: string | null = null, snapshot: string | null = null;
    if (input.messageId) {
      const { rows } = await c.query('SELECT author_id, conversation_id, body, seq, deleted_at, kind FROM messages WHERE id = $1', [input.messageId]);
      const m = rows[0];
      if (!m) throw notFound('Mensaje');
      const access = await conversationAccess(c, userId, m.conversation_id, 'read');
      if (m.seq <= access.historyFromSeq || m.deleted_at || m.kind !== 'text') throw notFound('Mensaje');
      if (targetId && targetId !== m.author_id) throw badRequest('El mensaje no pertenece a esa persona');
      targetId = m.author_id; conversationId = m.conversation_id; snapshot = m.body;
    } else await visiblePerson(c, userId, targetId!);
    if (targetId === userId) throw badRequest('No puedes reportarte');
    const { rows } = await c.query(
      `INSERT INTO safety_reports (reporter_id, reported_user_id, message_id, conversation_id, reason, message_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [userId, targetId, input.messageId ?? null, conversationId, input.reason, snapshot],
    );
    const id = rows[0].id as string;
    await c.query("INSERT INTO jobs (kind, payload, dedupe_key) VALUES ('safety.notify', $1, $2)", [JSON.stringify({ reportId: id }), `safety-report:${id}`]);
    await audit(c, userId, 'safety.reported', { type: 'report', id });
    return { id };
  });
}

/** El correo es un aviso; el contenido sensible se consulta en la cola con acceso al servidor. */
export async function notifyReport(reportId: string) {
  const { rows } = await pool.query('SELECT id, notified_at FROM safety_reports WHERE id = $1', [reportId]);
  if (!rows[0] || rows[0].notified_at) return;
  const text = `Hay un reporte de seguridad pendiente en TieComs. Referencia: ${reportId}. Revisar la cola de moderación del servidor según docs/MODERATION.md.`;
  await sendMail({ to: [{ email: process.env.MODERATION_EMAIL ?? 'soporte@tiecoms.com' }], subject: `TieComs: reporte ${reportId}`, text,
    html: `<p>${text}</p>`, tags: ['safety-report'] });
  await pool.query('UPDATE safety_reports SET notified_at = now() WHERE id = $1', [reportId]);
}
