/**
 * Perfil propio: nombre, cargo, área y foto. La foto se guarda en S3 y se sirve
 * por /api/v1/avatars/:id (un id nuevo en cada cambio, así se puede cachear para siempre).
 */
import { randomUUID } from 'node:crypto';
import { enqueueOutbox, pool, tx } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { conversationAccess } from '../access.ts';
import { appendMessage } from './messages.ts';
import { deleteObject, getObject, objectKey, putObject } from '../storage.ts';
import { loadUser } from './auth.ts';

export const MAX_AVATAR_BYTES = 3 * 1024 * 1024;
export const avatarUrl = (fileId: string | null | undefined) => (fileId ? `/api/v1/avatars/${fileId}` : null);

/** Tipo real por los primeros bytes: no se confía en el Content-Type del cliente. */
function sniffImage(b: Buffer): { type: string; ext: string } | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  return null;
}

/** Quienes ven a esta persona vuelven a pedir /bootstrap para ver el cambio. */
async function announce(c: import('../db.ts').Tx, userId: string) {
  const { rows } = await c.query(
    `SELECT DISTINCT o.user_id FROM workspace_memberships mine
       JOIN workspace_memberships o ON o.workspace_id = mine.workspace_id AND o.revoked_at IS NULL
      WHERE mine.user_id = $1 AND mine.revoked_at IS NULL
     UNION
     SELECT DISTINCT o.user_id FROM organization_memberships mine
       JOIN organization_memberships o ON o.org_id = mine.org_id
      WHERE mine.user_id = $1`,
    [userId],
  );
  const ids = [...new Set([userId, ...rows.map((r) => r.user_id as string)])];
  await enqueueOutbox(c, 'account.event', { userIds: ids, event: { type: 'scope.changed', reason: 'profile.updated' } });
}

export async function updateProfile(userId: string, input: { name?: string; title?: string | null; area?: string | null }) {
  await tx(async (c) => {
    if (input.name !== undefined) await c.query('UPDATE users SET name = $2 WHERE id = $1', [userId, input.name]);
    if (input.title !== undefined || input.area !== undefined) {
      await c.query(
        `UPDATE organization_memberships om SET
            title = CASE WHEN $2 THEN $3 ELSE om.title END,
            area  = CASE WHEN $4 THEN $5 ELSE om.area END
           FROM users u WHERE u.id = $1 AND om.user_id = u.id AND om.org_id = u.primary_org_id`,
        [userId, input.title !== undefined, input.title || null, input.area !== undefined, input.area || null],
      );
    }
    await announce(c, userId);
  });
  return loadUser(pool, userId);
}

function checkImage(body: Buffer) {
  if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Falta la imagen');
  if (body.length > MAX_AVATAR_BYTES) throw badRequest('La imagen pesa más de 3 MB');
  const img = sniffImage(body);
  if (!img) throw badRequest('Usa una imagen PNG, JPG o WebP');
  return img;
}

export async function setAvatar(userId: string, body: Buffer) {
  const img = checkImage(body);
  const id = randomUUID();
  const key = objectKey(`avatars/${userId}/${id}.${img.ext}`);
  // Primero S3 (llamada de red, fuera de la transacción); luego la fila.
  await putObject(key, body, img.type);
  const old = await tx(async (c) => {
    const prev = await c.query('SELECT f.id, f.s3_key FROM users u JOIN files f ON f.id = u.avatar_file_id WHERE u.id = $1', [userId]);
    await c.query('INSERT INTO files (id, owner_id, purpose, s3_key, content_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, userId, 'avatar', key, img.type, body.length]);
    await c.query('UPDATE users SET avatar_file_id = $2 WHERE id = $1', [userId, id]);
    if (prev.rows[0]) await c.query('UPDATE files SET deleted_at = now() WHERE id = $1', [prev.rows[0].id]);
    await announce(c, userId);
    return prev.rows[0] as { id: string; s3_key: string } | undefined;
  });
  if (old) void deleteObject(old.s3_key).catch((e) => console.error('[files] no pude borrar la foto anterior', e?.message));
  return loadUser(pool, userId);
}

export async function removeAvatar(userId: string) {
  const old = await tx(async (c) => {
    const prev = await c.query('SELECT f.id, f.s3_key FROM users u JOIN files f ON f.id = u.avatar_file_id WHERE u.id = $1', [userId]);
    await c.query('UPDATE users SET avatar_file_id = NULL WHERE id = $1', [userId]);
    if (prev.rows[0]) await c.query('UPDATE files SET deleted_at = now() WHERE id = $1', [prev.rows[0].id]);
    await announce(c, userId);
    return prev.rows[0] as { id: string; s3_key: string } | undefined;
  });
  if (old) void deleteObject(old.s3_key).catch(() => {});
  return loadUser(pool, userId);
}

/** Las fotos son como en cualquier chat: quien tenga el id (que llega en /bootstrap) la ve. */
export async function readAvatar(fileId: string) {
  const { rows } = await pool.query("SELECT s3_key FROM files WHERE id = $1 AND purpose IN ('avatar', 'group_avatar') AND deleted_at IS NULL", [fileId]);
  if (!rows[0]) throw notFound('Foto');
  return getObject(rows[0].s3_key);
}

// ---------- Foto de grupo ----------
const sys = (k: string, p: Record<string, unknown> = {}) => JSON.stringify({ k, ...p });

/** Grupos e internos: quien administra; chats grupales (multi, laterales): cualquier participante. Directos: no. */
async function groupPhotoAccess(db: import('../db.ts').Db, userId: string, conversationId: string, lock = false) {
  const a = await conversationAccess(db, userId, conversationId, 'read', lock);
  if (a.kind === 'direct') throw badRequest('Los directos no tienen foto de grupo');
  if (a.kind !== 'multi' && !a.canManage) throw forbidden('Solo quien administra el grupo puede cambiar su foto');
  if (!a.canPost) throw forbidden('No puedes publicar en esta conversación');
  return a;
}

async function announceGroup(c: import('../db.ts').Tx, conversationId: string) {
  const { rows } = await c.query('SELECT user_id FROM conversation_memberships WHERE conversation_id = $1 AND removed_at IS NULL', [conversationId]);
  if (rows.length) await enqueueOutbox(c, 'account.event', { userIds: rows.map((r) => r.user_id), event: { type: 'scope.changed', reason: 'conversation.photo' } });
}

export async function setGroupAvatar(userId: string, conversationId: string, body: Buffer) {
  await groupPhotoAccess(pool, userId, conversationId);
  const img = checkImage(body);
  const id = randomUUID();
  const key = objectKey(`group-avatars/${conversationId}/${id}.${img.ext}`);
  await putObject(key, body, img.type);
  const old = await tx(async (c) => {
    await groupPhotoAccess(c, userId, conversationId, true);
    const prev = await c.query('SELECT f.id, f.s3_key FROM conversations cv JOIN files f ON f.id = cv.avatar_file_id WHERE cv.id = $1', [conversationId]);
    await c.query('INSERT INTO files (id, owner_id, purpose, s3_key, content_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, userId, 'group_avatar', key, img.type, body.length]);
    await c.query('UPDATE conversations SET avatar_file_id = $2 WHERE id = $1', [conversationId, id]);
    if (prev.rows[0]) await c.query('UPDATE files SET deleted_at = now() WHERE id = $1', [prev.rows[0].id]);
    await appendMessage(c, { conversationId, authorId: userId, kind: 'system', body: sys('group.photo_changed') });
    await announceGroup(c, conversationId);
    return prev.rows[0] as { id: string; s3_key: string } | undefined;
  });
  if (old) void deleteObject(old.s3_key).catch((e) => console.error('[files] no pude borrar la foto anterior del grupo', e?.message));
  return { avatarUrl: avatarUrl(id) };
}

export async function removeGroupAvatar(userId: string, conversationId: string) {
  const old = await tx(async (c) => {
    await groupPhotoAccess(c, userId, conversationId, true);
    const prev = await c.query('SELECT f.id, f.s3_key FROM conversations cv JOIN files f ON f.id = cv.avatar_file_id WHERE cv.id = $1', [conversationId]);
    if (!prev.rows[0]) return undefined;
    await c.query('UPDATE conversations SET avatar_file_id = NULL WHERE id = $1', [conversationId]);
    await c.query('UPDATE files SET deleted_at = now() WHERE id = $1', [prev.rows[0].id]);
    await appendMessage(c, { conversationId, authorId: userId, kind: 'system', body: sys('group.photo_removed') });
    await announceGroup(c, conversationId);
    return prev.rows[0] as { id: string; s3_key: string };
  });
  if (old) void deleteObject(old.s3_key).catch(() => {});
  return { avatarUrl: null };
}
