/**
 * Worker de trabajos lentos: nunca bloquea el envío de mensajes.
 * Reclama jobs con lease (FOR UPDATE SKIP LOCKED) en una transacción corta y
 * los ejecuta fuera de ella; reintenta con backoff y deja el fallo inspeccionable.
 */
import { hostname } from 'node:os';
import { migrate } from './migrate.ts';
import { enqueueOutbox, pool, tx } from './db.ts';
import { fireDueReminders } from './modules/reminders.ts';
import { cleanupExpired as cleanupSso } from './modules/sso.ts';
import { previewMessage } from './modules/link-preview.ts';
import { deletePersonalObject } from './storage.ts';
import { notifyReport } from './modules/safety.ts';
import { pushEvent, pushEventSoon, pushMessage, pushReminder } from './modules/push.ts';
import { fireSoonEvents, soonMinutes } from './modules/calendar.ts';
import { cleanupPending as cleanupAttachments } from './modules/attachments.ts';
import { transcribeAttachment } from './modules/voice.ts';

const WORKER_ID = `${hostname()}:${process.pid}`;
const LEASE_SECONDS = 120;

type Handler = (payload: any) => Promise<void>;

const handlers: Record<string, Handler> = {
  async 'account.delete_file'(p) {
    await deletePersonalObject(p.key);
    await pool.query('DELETE FROM files WHERE id = $1 AND deleted_at IS NOT NULL', [p.fileId]);
  },
  async 'safety.notify'(p) { await notifyReport(p.reportId); },
  /** Notificaciones push (APNs / FCM). Los fallos por token se registran sin reintentar el job (evita duplicados). */
  async 'push.message'(p) { await pushMessage(p.messageId); },
  async 'push.reminder'(p) { await pushReminder(p.reminderId); },
  async 'push.event'(p) { await pushEvent(p.eventId); },
  /** Nota de voz: variante AAC, transcripción y resumen (Inworld / DeepSeek). */
  async 'voice.transcribe'(p) { await transcribeAttachment(p.attachmentId); },
  async 'push.event_soon'(p) { await pushEventSoon(p.eventId, p.userIds, soonMinutes()); },
  /** Vista previa del primer enlace de un mensaje. */
  async 'link.preview'(p) { await previewMessage(p.messageId); },
  /** Terceros vencidos: se revoca el acceso y se sacan sus sockets de las salas. */
  async 'housekeeping.expire_guests'() {
    await tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE workspace_memberships SET revoked_at = now()
          WHERE expires_at IS NOT NULL AND expires_at <= now() AND revoked_at IS NULL
          RETURNING workspace_id, user_id`,
      );
      for (const r of rows) {
        const convs = await c.query(
          `UPDATE conversation_memberships m SET removed_at = now() FROM conversations c
            WHERE c.id = m.conversation_id AND c.workspace_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL
            RETURNING m.conversation_id`,
          [r.workspace_id, r.user_id],
        );
        for (const cv of convs.rows) await enqueueOutbox(c, 'rooms.leave', { userIds: [r.user_id], conversationId: cv.conversation_id });
        await enqueueOutbox(c, 'account.event', { userIds: [r.user_id], event: { type: 'scope.changed', reason: 'guest.expired' } });
      }
      if (rows.length) console.log(`[worker] terceros vencidos: ${rows.length}`);
    });
  },
  async 'housekeeping.cleanup'() {
    await pool.query("DELETE FROM outbox WHERE dispatched_at < now() - interval '3 days'");
    await pool.query("DELETE FROM jobs WHERE done_at < now() - interval '7 days'");
    await pool.query("DELETE FROM sessions WHERE (revoked_at < now() - interval '30 days') OR (expires_at < now() - interval '30 days')");
    await pool.query("DELETE FROM socket_io_attachments WHERE created_at < now() - interval '1 hour'");
    await pool.query("DELETE FROM audit_events WHERE created_at < now() - interval '24 months'");
    await pool.query("DELETE FROM safety_reports WHERE created_at < now() - interval '24 months'");
    await cleanupSso();
    const stale = await cleanupAttachments();
    if (stale) console.log(`[worker] adjuntos pendientes borrados: ${stale}`);
  },
};

/** Programa tareas periódicas de forma idempotente (dedupe por ventana de tiempo). */
async function schedule() {
  const minute = Math.floor(Date.now() / 60_000);
  await pool.query(
    `INSERT INTO jobs (kind, dedupe_key) VALUES ('housekeeping.expire_guests', $1), ('housekeeping.cleanup', $2)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [`expire:${minute}`, `cleanup:${Math.floor(minute / 60)}`],
  );
}

async function claim() {
  const { rows } = await pool.query(
    `UPDATE jobs SET locked_until = now() + make_interval(secs => $2), locked_by = $1, attempts = attempts + 1
      WHERE id = (SELECT id FROM jobs WHERE done_at IS NULL AND failed_at IS NULL AND run_at <= now()
                    AND (locked_until IS NULL OR locked_until < now())
                  ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, payload, attempts, max_attempts`,
    [WORKER_ID, LEASE_SECONDS],
  );
  return rows[0];
}

async function runOne(): Promise<boolean> {
  const job = await claim();
  if (!job) return false;
  const h = handlers[job.kind];
  try {
    if (!h) throw new Error(`sin handler para ${job.kind}`);
    await h(job.payload);
    await pool.query('UPDATE jobs SET done_at = now(), locked_until = NULL WHERE id = $1', [job.id]);
  } catch (e: any) {
    const failed = job.attempts >= job.max_attempts;
    const backoff = Math.min(3600, 2 ** job.attempts * 5 + Math.random() * 5);
    await pool.query(
      `UPDATE jobs SET last_error = $2, locked_until = NULL, run_at = now() + make_interval(secs => $3), failed_at = CASE WHEN $4 THEN now() END WHERE id = $1`,
      [job.id, String(e?.message ?? e).slice(0, 2000), backoff, failed],
    );
    console.error(`[worker] job ${job.id} (${job.kind}) falló`, e?.message);
  }
  return true;
}

let stop = false;
async function loop() {
  let lastSchedule = 0;
  let lastReminders = 0;
  while (!stop) {
    try {
      // Recordatorios: revisión cada 15 s; el aviso llega por el outbox a los dispositivos de la persona.
      if (Date.now() - lastReminders > 15_000) { lastReminders = Date.now(); const n = await fireDueReminders(); if (n) console.log(`[worker] recordatorios disparados: ${n}`);
        const s = await fireSoonEvents(); if (s) console.log(`[worker] avisos de reunión: ${s}`); }
      if (Date.now() - lastSchedule > 30_000) { await schedule(); lastSchedule = Date.now(); }
      const worked = await runOne();
      if (!worked) await new Promise((r) => setTimeout(r, 1000));
    } catch (e: any) {
      console.error('[worker] error en ciclo', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  await pool.end();
}

process.on('SIGTERM', () => { stop = true; });
process.on('SIGINT', () => { stop = true; });
console.log(`[worker] ${WORKER_ID} iniciado`);
// Igual que el API: aplica migraciones pendientes antes de trabajar (evita consultas a columnas que aún no existen).
void (async () => {
  if (process.env.MIGRATE_ON_START !== 'false') await migrate().catch((e) => console.error('[worker] migraciones', e?.message));
  await loop();
})();
