import type { z } from 'zod';
import type { CreateScheduledInput, ScheduledMessageDTO, UpdateScheduledInput } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { enqueueOutbox, pool, type Db } from '../db.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { sendMessage } from './messages.ts';

const MAX_AHEAD_MS = 366 * 86_400_000;
/** Si el worker se cae con un envío tomado, otro lo retoma pasado este tiempo (el clientMessageId evita duplicados). */
const RECLAIM_SECONDS = 120;

const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const toDTO = (r: any): ScheduledMessageDTO => ({
  id: r.id, conversationId: r.conversation_id, body: r.body, mentions: r.mentions ?? [], replyTo: r.reply_to,
  sendAt: iso(r.send_at)!, status: r.status, messageId: r.message_id, error: r.error, createdAt: iso(r.created_at)!, sentAt: iso(r.sent_at),
});

/** Cada envío programado sale con un clientMessageId fijo: reintentar nunca duplica el mensaje. */
export const scheduledClientId = (id: string) => `sched-${id}`;

function checkWhen(sendAt: string) {
  const t = Date.parse(sendAt);
  if (t < Date.now() + 30_000) throw badRequest('Elige una hora en el futuro');
  if (t > Date.now() + MAX_AHEAD_MS) throw badRequest('Se puede programar hasta con un año de anticipación');
}

async function notify(db: Db, r: any) {
  await enqueueOutbox(db as any, 'account.event', { userIds: [r.user_id], event: { type: 'scheduled.updated', scheduled: toDTO(r) } });
}

export async function createScheduled(userId: string, conversationId: string, input: z.infer<typeof CreateScheduledInput>) {
  await conversationAccess(pool, userId, conversationId, 'post');
  checkWhen(input.sendAt);
  if (input.replyTo) {
    const { rowCount } = await pool.query('SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2', [input.replyTo, conversationId]);
    if (!rowCount) throw badRequest('El mensaje citado no está en esta conversación');
  }
  const { rows } = await pool.query(
    `INSERT INTO scheduled_messages (user_id, conversation_id, body, mentions, reply_to, send_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, conversationId, input.body, input.mentions?.length ? JSON.stringify(input.mentions) : null, input.replyTo ?? null, input.sendAt],
  );
  await notify(pool, rows[0]);
  return toDTO(rows[0]);
}

/** Mis programados por salir y los que fallaron (para que la persona se entere y decida). */
export async function listScheduled(userId: string, conversationId?: string) {
  const { rows } = await pool.query(
    `SELECT s.* FROM scheduled_messages s
       JOIN conversation_memberships cm ON cm.conversation_id = s.conversation_id AND cm.user_id = s.user_id AND cm.removed_at IS NULL
      WHERE s.user_id = $1 AND s.status IN ('pending','sending','failed') AND ($2::uuid IS NULL OR s.conversation_id = $2)
      ORDER BY s.send_at LIMIT 500`,
    [userId, conversationId ?? null],
  );
  return rows.map(toDTO);
}

export async function updateScheduled(userId: string, id: string, input: z.infer<typeof UpdateScheduledInput>) {
  if (input.sendAt) checkWhen(input.sendAt);
  // Editar un fallido lo vuelve a poner en cola.
  const { rows } = await pool.query(
    `UPDATE scheduled_messages SET
        body = COALESCE($3, body),
        mentions = CASE WHEN $3::text IS NULL THEN mentions ELSE $4::jsonb END,
        send_at = COALESCE($5::timestamptz, send_at),
        status = 'pending', error = NULL, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status IN ('pending','failed') RETURNING *`,
    [id, userId, input.body ?? null, input.mentions?.length ? JSON.stringify(input.mentions) : null, input.sendAt ?? null],
  );
  if (!rows[0]) throw await missing(userId, id);
  await notify(pool, rows[0]);
  return toDTO(rows[0]);
}

export async function cancelScheduled(userId: string, id: string) {
  const { rows } = await pool.query(
    "UPDATE scheduled_messages SET status = 'cancelled', updated_at = now() WHERE id = $1 AND user_id = $2 AND status IN ('pending','failed') RETURNING *",
    [id, userId],
  );
  if (!rows[0]) throw await missing(userId, id);
  await notify(pool, rows[0]);
  return toDTO(rows[0]);
}

/** «Enviar ahora»: se manda en el acto, sin esperar al worker. */
export async function sendScheduledNow(userId: string, id: string) {
  const { rows } = await pool.query(
    "UPDATE scheduled_messages SET status = 'sending', claimed_at = now(), send_at = LEAST(send_at, now()), updated_at = now() WHERE id = $1 AND user_id = $2 AND status IN ('pending','failed') RETURNING *",
    [id, userId],
  );
  if (!rows[0]) throw await missing(userId, id);
  return deliver(rows[0]);
}

async function missing(userId: string, id: string) {
  const { rows } = await pool.query('SELECT status FROM scheduled_messages WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rows[0]) return notFound('Mensaje programado');
  return conflict(rows[0].status === 'sent' ? 'Ese mensaje ya se envió' : 'Ese mensaje ya no se puede cambiar');
}

/** Envía uno ya tomado ('sending'). Revalida el acceso en ese momento: si ya no puede escribir, queda «fallido». */
async function deliver(r: any): Promise<ScheduledMessageDTO> {
  try {
    const { message } = await sendMessage(r.user_id, r.conversation_id, {
      clientMessageId: scheduledClientId(r.id), body: r.body, mentions: r.mentions ?? undefined, replyTo: r.reply_to ?? null,
    });
    const u = await pool.query("UPDATE scheduled_messages SET status = 'sent', message_id = $2, sent_at = now(), updated_at = now() WHERE id = $1 RETURNING *", [r.id, message.id]);
    await notify(pool, u.rows[0]);
    return toDTO(u.rows[0]);
  } catch (e: any) {
    const status = e?.status ?? e?.statusCode;
    // Errores de permiso o de datos no se arreglan solos: se avisa. Los demás (red, BD) se reintentan.
    if (status && status >= 400 && status < 500) {
      const u = await pool.query("UPDATE scheduled_messages SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 RETURNING *", [r.id, String(e.message ?? 'No se pudo enviar').slice(0, 300)]);
      await notify(pool, u.rows[0]);
      return toDTO(u.rows[0]);
    }
    await pool.query("UPDATE scheduled_messages SET status = 'pending', claimed_at = NULL WHERE id = $1 AND status = 'sending'", [r.id]);
    throw e;
  }
}

/** Lo llama el worker cada 15 s: toma los vencidos (y los que quedaron colgados) y los envía. */
export async function sendDueScheduled(): Promise<number> {
  const { rows } = await pool.query(
    `UPDATE scheduled_messages SET status = 'sending', claimed_at = now()
      WHERE id IN (SELECT id FROM scheduled_messages
                    WHERE (status = 'pending' AND send_at <= now())
                       OR (status = 'sending' AND claimed_at < now() - make_interval(secs => $1))
                    ORDER BY send_at LIMIT 100 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [RECLAIM_SECONDS],
  );
  let sent = 0;
  for (const r of rows) {
    try { if ((await deliver(r)).status === 'sent') sent++; } catch (e: any) { console.error('[worker] programado', r.id, e?.message); }
  }
  return sent;
}
