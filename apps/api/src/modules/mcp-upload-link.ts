/**
 * Enlace de subida para agentes (pedido de Danny 10-oct: «permite que el MCP acepte videos y archivos»).
 * Un agente no puede pegar 2 MB de base64 en una llamada: create_upload_link entrega una URL de un solo uso
 * (15 min) a la que el agente manda los bytes crudos con curl. La subida va por stream, como la app
 * (videos hasta 150 MB al chat; archivos grandes hasta 150 MB a chats o tareas), con los permisos del dueño
 * del token MCP. El adjunto queda pendiente como cualquier otro: send_message (chat) lo vincula; en una tarea
 * se agrega a sus archivos.
 *
 * Seguridad: la URL lleva el id del token MCP y un secreto aleatorio; en la base solo queda su sha256 (tabla
 * mcp_idempotency, que el worker purga a las 24 h). El token MCP debe seguir vigente al subir. Un reintento con
 * la misma URL después de una subida exitosa devuelve el mismo adjunto sin volver a subir.
 */
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { MAX_LARGE_FILE_BYTES, MAX_VIDEO_BYTES } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { config } from '../config.ts';
import { pool } from '../db.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { sha256 } from '../security.ts';
import * as attachments from './attachments.ts';
import * as issues from './issues.ts';
import { taskWriteAccess } from './mcp-attachments.ts';
import type { McpCtx } from './mcp-wa.ts';

const TTL_MS = 15 * 60_000;
const keyOf = (secret: string) => `upload-link:${sha256(secret).toString('hex')}`;

type LinkRequest = { target: { conversationId: string } | { issueId: string }; name: string; type: string; video: boolean; exp: number };

export async function createLink(ctx: McpCtx, target: LinkRequest['target'], name: string, contentType: string) {
  const type = contentType.toLowerCase().trim();
  if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(type)) throw badRequest('content_type debe ser un tipo MIME sin parámetros');
  // Mismo criterio que las subidas en base64: nada que el navegador ejecute o pinte como página.
  if (/(html|[/+]xml$|javascript|ecmascript|svg)/.test(type) || (type.startsWith('text/') && !['text/plain', 'text/csv', 'text/markdown'].includes(type))) {
    throw new ApiError(415, 'unsupported_type', 'Ese tipo de archivo no se admite (HTML, SVG, XML o JavaScript)');
  }
  if ('issueId' in target) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await taskWriteAccess(c, ctx.userId, target.issueId); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  } else await conversationAccess(pool, ctx.userId, target.conversationId, 'post');
  // Los videos van al chat por la ruta de video (reproducción en línea); en tareas quedan como archivo.
  const video = type.startsWith('video/') && 'conversationId' in target;
  const secret = randomBytes(32).toString('base64url');
  const req: LinkRequest = { target, name, type, video, exp: Date.now() + TTL_MS };
  await pool.query('INSERT INTO mcp_idempotency (token_id, key, request) VALUES ($1,$2,$3)', [ctx.tokenId, keyOf(secret), Buffer.from(JSON.stringify(req))]);
  const url = `${config.publicOrigin}/api/mcp/uploads/${ctx.tokenId}/${secret}`;
  return {
    upload_url: url,
    method: 'POST',
    headers: { 'content-type': type },
    max_bytes: video ? MAX_VIDEO_BYTES : MAX_LARGE_FILE_BYTES,
    expires_at: new Date(req.exp).toISOString(),
    curl: `curl -sS -X POST --data-binary @RUTA_DEL_ARCHIVO -H 'content-type: ${type}' '${url}'`,
    next: 'conversationId' in target
      ? 'La respuesta trae attachment.id: inclúyelo en send_message (attachment_ids) para enviarlo.'
      : 'La respuesta trae attachment.id; el archivo ya queda agregado a la tarea.',
  };
}

/** POST de los bytes crudos a la URL del enlace. Sin cabecera Authorization: el secreto de la URL autoriza. */
export async function consume(tokenId: string, secret: string, stream: Readable, length: number | null) {
  if (!/^[0-9a-f-]{36}$/.test(tokenId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw notFound('Enlace de subida');
  const key = keyOf(secret);
  const { rows } = await pool.query(
    `SELECT i.request, i.response, t.user_id FROM mcp_idempotency i
       JOIN mcp_tokens t ON t.id = i.token_id JOIN users u ON u.id = t.user_id
      WHERE i.token_id = $1 AND i.key = $2 AND t.revoked_at IS NULL AND u.disabled_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now())`, [tokenId, key]);
  const row = rows[0];
  if (!row) throw notFound('Enlace de subida');
  if (row.response && !row.response.pending) { stream.resume(); return row.response; }
  const req = JSON.parse(Buffer.from(row.request).toString('utf8')) as LinkRequest;
  if (Date.now() > req.exp) throw new ApiError(410, 'expired', 'El enlace de subida venció; pide otro con create_upload_link');
  // Una sola subida a la vez por enlace.
  const claim = await pool.query(`UPDATE mcp_idempotency SET response = '{"pending":true}' WHERE token_id = $1 AND key = $2 AND response IS NULL RETURNING key`, [tokenId, key]);
  if (!claim.rowCount) throw new ApiError(409, 'busy', 'Ya hay una subida en curso con este enlace');
  const userId: string = row.user_id;
  try {
    let out: Record<string, unknown>;
    if ('conversationId' in req.target) {
      const attachment = req.video
        ? await attachments.uploadVideo(userId, req.target.conversationId, { stream, length, name: req.name })
        : await attachments.uploadLargeFile(userId, req.target, { stream, length, name: req.name, type: req.type });
      out = { chatId: req.target.conversationId, attachment };
    } else {
      const issueId = req.target.issueId;
      const attachment = await attachments.uploadLargeFile(userId, req.target, { stream, length, name: req.name, type: req.type });
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const issue = await taskWriteAccess(c, userId, issueId);
        const ids = [...new Set([...(issue.attachments ?? []).map((f) => f.id), attachment.id])];
        if (ids.length > 20) throw badRequest('Máximo 20 adjuntos por tarea');
        const updated = await issues.updateIssue(userId, issueId, { attachmentIds: ids }, c);
        await c.query('COMMIT');
        out = { taskId: issueId, attachment, attachments: updated.attachments ?? [] };
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    }
    await pool.query('UPDATE mcp_idempotency SET response = $3 WHERE token_id = $1 AND key = $2', [tokenId, key, JSON.stringify(out)]);
    return out;
  } catch (e) {
    await pool.query('UPDATE mcp_idempotency SET response = NULL WHERE token_id = $1 AND key = $2', [tokenId, key]).catch(() => {});
    throw e;
  }
}
