/**
 * Enlaces para ver un archivo de chaggu sin cuenta (pedido de Danny, 2-oct-2026). Al arrastrar un adjunto a un chat de
 * WhatsApp (que desde chaggu solo acepta texto) se manda este enlace: https://app.chaggu.com/archivo/<token>.
 * - Solo lo crea quien puede leer el adjunto (mismas reglas que GET /attachments/:id; nunca uno de una sola vista).
 * - Caduca a los 7 días; se guarda el hash del token. Si el adjunto o su mensaje se borran, el enlace deja de servir.
 */
import { pool } from '../db.ts';
import { config } from '../config.ts';
import { notFound } from '../errors.ts';
import { randomToken, sha256 } from '../security.ts';
import { presignDownload } from '../storage.ts';
import { INLINE_TYPES, readable } from './attachments.ts';

export const FILE_LINK_DAYS = 7;
const FILE_URL_SECONDS = 300;

export async function createLink(userId: string, attachmentId: string) {
  const a = await readable(userId, attachmentId);
  const token = randomToken(18);
  const { rows } = await pool.query(
    `INSERT INTO file_links (token_hash, attachment_id, created_by, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4)) RETURNING expires_at`,
    [sha256(token), a.id, userId, FILE_LINK_DAYS],
  );
  return { url: `${config.publicOrigin.replace(/\/$/, '')}/archivo/${token}`, name: a.name as string, expiresAt: new Date(rows[0].expires_at).toISOString() };
}

/** Desactivar un enlace (por si se mandó por error): solo quien lo creó. Desde ahí ya no abre para nadie. */
export async function revokeLink(userId: string, token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound('Enlace');
  const { rowCount } = await pool.query('UPDATE file_links SET revoked_at = now() WHERE token_hash = $1 AND created_by = $2 AND revoked_at IS NULL', [sha256(token), userId]);
  if (!rowCount) throw notFound('Enlace');
  return { ok: true };
}

async function linkRow(token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound('Enlace');
  const { rows } = await pool.query(
    `SELECT l.id, l.expires_at, a.name, a.content_type, a.size_bytes, a.s3_key, u.name AS shared_by
       FROM file_links l JOIN attachments a ON a.id = l.attachment_id LEFT JOIN messages m ON m.id = a.message_id JOIN users u ON u.id = l.created_by
      WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND l.expires_at > now() AND a.deleted_at IS NULL AND m.deleted_at IS NULL AND NOT COALESCE(m.view_once, false)`,
    [sha256(token)],
  );
  if (!rows[0]) throw notFound('Enlace');
  return rows[0];
}

/** GET /file-links/:token (público): lo mínimo para la página «Ver archivo». */
export async function preview(token: string) {
  const r = await linkRow(token);
  return { name: r.name as string, contentType: r.content_type as string, viewable: INLINE_TYPES.has(r.content_type), sizeBytes: Number(r.size_bytes), sharedBy: (r.shared_by as string | null) ?? null, expiresAt: new Date(r.expires_at).toISOString() };
}

/** GET /file-links/:token/file (público): URL firmada de 5 min, para verlo en el navegador o descargarlo. */
export async function fileUrl(token: string, download: boolean) {
  const r = await linkRow(token);
  await pool.query('UPDATE file_links SET opened_count = opened_count + 1 WHERE id = $1', [r.id]);
  // Solo se ve en el navegador lo que es seguro (PDF, imágenes…); lo demás se descarga.
  const inline = !download && INLINE_TYPES.has(r.content_type);
  return presignDownload(r.s3_key, r.name, inline ? r.content_type : 'application/octet-stream', FILE_URL_SECONDS, inline);
}
