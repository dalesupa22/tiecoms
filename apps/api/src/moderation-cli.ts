/** Operación reservada a administradores con acceso SSH; no existe ruta pública de moderación. */
import { pool, tx, audit, enqueueOutbox } from './db.ts';
import { appendEvent, toMessageDTO } from './modules/messages.ts';
import { z } from 'zod';

const [command = 'list', id, action, note] = process.argv.slice(2);
try {
  if (command === 'list') {
    const { rows } = await pool.query(
      `SELECT r.*, u.email AS reporter_email FROM safety_reports r LEFT JOIN users u ON u.id = r.reporter_id
        WHERE r.status = 'open' ORDER BY r.created_at LIMIT 100`,
    );
    console.log(JSON.stringify(rows, null, 2));
  } else if (command === 'resolve') {
    z.uuid().parse(id);
    const selected = z.enum(['dismiss', 'remove-message', 'suspend-user']).parse(action);
    z.string().trim().min(5).max(2000).parse(note);
    await tx(async (c) => {
      const r = (await c.query('SELECT * FROM safety_reports WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new Error('Reporte no encontrado');
      if (r.status !== 'open') throw new Error('El reporte ya está resuelto');
      if (selected === 'remove-message') {
        if (!r.message_id) throw new Error('El reporte no corresponde a un mensaje');
        const m = (await c.query("UPDATE messages SET body = '', deleted_at = COALESCE(deleted_at, now()), link_preview = NULL WHERE id = $1 RETURNING *", [r.message_id])).rows[0];
        if (m) {
          await c.query('DELETE FROM message_pins WHERE message_id = $1', [m.id]);
          await appendEvent(c, m.conversation_id, { type: 'message.updated', conversationId: m.conversation_id, message: toMessageDTO(m) }, m.id);
        }
      }
      if (selected === 'suspend-user') {
        if (!r.reported_user_id) throw new Error('El reporte no tiene una persona activa');
        await c.query('UPDATE users SET disabled_at = COALESCE(disabled_at, now()) WHERE id = $1', [r.reported_user_id]);
        const sessions = await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id', [r.reported_user_id]);
        for (const s of sessions.rows) await enqueueOutbox(c, 'session.revoke', { sessionId: s.id });
      }
      const status = { dismiss: 'dismissed', 'remove-message': 'message_removed', 'suspend-user': 'user_suspended' }[selected];
      await c.query('UPDATE safety_reports SET status = $2, resolved_at = now(), resolution_note = $3 WHERE id = $1', [id, status, note]);
      await audit(c, null, `safety.${selected}`, { type: 'report', id }, { note, operator: 'server-cli' });
    });
    console.log(JSON.stringify({ ok: true, id, action }));
  } else throw new Error('Uso: moderation.js list | resolve UUID dismiss|remove-message|suspend-user "motivo"');
} catch (e: any) {
  console.error(e?.message ?? 'Error de moderación');
  process.exitCode = 1;
} finally { await pool.end(); }
