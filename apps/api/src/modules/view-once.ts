/**
 * Mensajes de una sola vista (docs/TANDA-1.7.md §7). La fila del mensaje guarda body '' y los adjuntos sin URL;
 * el texto real está en view_once_body y los archivos solo salen por una URL firmada de 60 s que entrega
 * POST /messages/:id/open, una sola vez por persona (410 already_opened la segunda).
 */
import type { AttachmentDTO, ViewOnceOpenDTO } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { pool, tx } from '../db.ts';
import { ApiError, badRequest, forbidden, notFound } from '../errors.ts';
import { signOnce, verifyOnce } from '../security.ts';
import { getObject } from '../storage.ts';
import { toDTO as attachmentDTO } from './attachments.ts';
import { appendEvent, toMessageDTO } from './messages.ts';

/** Días que un mensaje de una sola vista espera a que lo abran antes de borrarse (de forma lógica). */
export const VIEW_ONCE_DAYS = 14;

export async function openViewOnce(userId: string, messageId: string): Promise<ViewOnceOpenDTO> {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM messages WHERE id = $1 FOR UPDATE', [messageId]);
    const m = rows[0];
    if (!m) throw notFound('Mensaje');
    const a = await conversationAccess(c, userId, m.conversation_id, 'read');
    if (m.seq <= a.historyFromSeq || m.deleted_at) throw notFound('Mensaje');
    if (!m.view_once) throw badRequest('Este mensaje no es de una sola vista');
    if (a.oversight) throw forbidden('La supervisión no abre mensajes de una sola vista');
    // Igual que en WhatsApp: quien lo envió tampoco vuelve a verlo.
    if (m.author_id === userId) throw forbidden('No puedes abrir tu propio mensaje de una sola vista');
    if (m.view_once_purged_at) throw new ApiError(410, 'expired', 'Este mensaje ya no está disponible');
    const ins = await c.query('INSERT INTO message_views (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING opened_at', [messageId, userId]);
    if (!ins.rowCount) throw new ApiError(410, 'already_opened', 'Ya abriste este mensaje');
    const at = new Date(ins.rows[0].opened_at).toISOString();
    const up = await c.query(
      `UPDATE messages SET view_once_opened = COALESCE(view_once_opened, '[]'::jsonb) || $2::jsonb WHERE id = $1 RETURNING *`,
      [messageId, JSON.stringify([{ userId, at }])],
    );
    // Solo cambia el estado (para el autor, «Visto por …»): el contenido nunca viaja por los eventos.
    const message = toMessageDTO(up.rows[0]);
    await appendEvent(c, m.conversation_id, { type: 'message.updated', conversationId: m.conversation_id, message }, messageId);
    const atts = await c.query('SELECT * FROM attachments WHERE message_id = $1 AND deleted_at IS NULL ORDER BY position', [messageId]);
    const attachments: AttachmentDTO[] = atts.rows.map((r) => {
      const dto = attachmentDTO(r);
      return { ...dto, url: `/api/v1/once?t=${signOnce(r.id, userId)}`, thumbUrl: null, ...(dto.kind === 'voice' ? { transcript: null } : {}) };
    });
    return { body: m.view_once_body ?? '', ...(m.display_body!==null ? {displayBody:m.display_body} : {}), attachments };
  });
}

/** GET /once?t= (sin Bearer): el archivo, si la firma es de esta persona y no venció. */
export async function fetchOnce(token: string) {
  const t = verifyOnce(token);
  if (!t) throw forbidden('Enlace vencido');
  const { rows } = await pool.query(
    `SELECT a.*, m.view_once, m.view_once_purged_at FROM attachments a JOIN messages m ON m.id = a.message_id
      JOIN message_views v ON v.message_id = m.id AND v.user_id = $2
     WHERE a.id = $1 AND m.deleted_at IS NULL`,
    [t.attachmentId, t.userId],
  );
  const a = rows[0];
  if (!a || !a.view_once || a.view_once_purged_at) throw notFound('Adjunto');
  const key = a.play_key ?? a.s3_key;
  const obj = await getObject(key);
  return { body: obj.body, contentType: (a.play_type ?? a.content_type) as string };
}

/**
 * Retención: cuando todos los destinatarios lo abrieron (hace más de 2 min, para que la URL firmada alcance
 * a servirse) o a los 14 días, el texto se borra y los adjuntos quedan sin URL (deleted_at).
 */
export async function purgeViewOnce(): Promise<number> {
  const { rows } = await pool.query(
    `UPDATE messages m SET view_once_body = NULL, display_body=NULL, view_once_purged_at = now()
      WHERE m.view_once AND m.view_once_purged_at IS NULL AND (
        m.created_at < now() - make_interval(days => $1)
        OR (NOT EXISTS (
              SELECT 1 FROM conversation_memberships cm
               WHERE cm.conversation_id = m.conversation_id AND cm.removed_at IS NULL AND cm.user_id <> m.author_id AND cm.history_from_seq < m.seq
                 AND NOT EXISTS (SELECT 1 FROM message_views v WHERE v.message_id = m.id AND v.user_id = cm.user_id))
            AND NOT EXISTS (SELECT 1 FROM message_views v WHERE v.message_id = m.id AND v.opened_at > now() - interval '2 minutes')
            AND EXISTS (SELECT 1 FROM message_views v WHERE v.message_id = m.id)))
      RETURNING m.id`,
    [VIEW_ONCE_DAYS],
  );
  if (rows.length) await pool.query('UPDATE attachments SET deleted_at = now() WHERE message_id = ANY($1) AND deleted_at IS NULL', [rows.map((r) => r.id)]);
  return rows.length;
}
