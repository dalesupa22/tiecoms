/** Files belong to exactly one personal, workspace or conversation audience. */
import { randomUUID } from 'node:crypto';
import type { CreateDriveDocumentInput, DriveFileDTO, DriveFolderDTO, DriveTreeDTO, DriveVisibility } from '@tiecoms/contracts';
import { conversationAccess, workspaceAccess } from '../access.ts';
import { enqueueOutbox, pool, tx, type Db, type Tx } from '../db.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { objectKey, presignDownload, putObject } from '../storage.ts';
import { generateDriveDocument } from './drive-documents.ts';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ITEMS = 5000;
interface Scope { workspaceId: string | null; conversationId: string | null; userId: string; canManageAll: boolean; canUpload: boolean }

async function scopeFor(db: Db, userId: string, workspaceId: string | null, conversationId: string | null = null, write = false): Promise<Scope> {
  if (workspaceId && conversationId) throw badRequest('Elige un espacio o una conversación, no ambos');
  if (conversationId) {
    const a = await conversationAccess(db, userId, conversationId, write ? 'post' : 'read');
    // Supervision is message access, never membership in a file-sharing audience.
    if (a.oversight) throw notFound('Conversación');
    return { workspaceId: null, conversationId, userId, canManageAll: a.canManage, canUpload: a.canPost };
  }
  if (!workspaceId) return { workspaceId: null, conversationId: null, userId, canManageAll: true, canUpload: true };
  const a = await workspaceAccess(db, userId, workspaceId, 'member');
  return { workspaceId, conversationId: null, userId, canManageAll: a.role === 'lead' || a.role === 'admin', canUpload: true };
}

const scopeWhere = (alias: string, s: Scope, p: number) => s.conversationId
  ? `${alias}.conversation_id = $${p}`
  : s.workspaceId ? `${alias}.workspace_id = $${p} AND ${alias}.conversation_id IS NULL`
    : `${alias}.workspace_id IS NULL AND ${alias}.conversation_id IS NULL AND ${alias}.owner_id = $${p}`;
const scopeParam = (s: Scope) => s.conversationId ?? s.workspaceId ?? s.userId;
const sharedScope = (s: Scope) => !!(s.workspaceId || s.conversationId);
/** Every tree mutation takes this lock before any folder/file row lock. This
 * prevents new uploads or folder moves from entering a deletion snapshot and
 * gives all callers the same lock order. Network uploads happen before it. */
async function lockScope(c: Tx, s: Scope) {
  const audience = s.conversationId ? `conversation:${s.conversationId}` : s.workspaceId ? `workspace:${s.workspaceId}` : `personal:${s.userId}`;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`chaggu:drive:${audience}`]);
}
const folderDTO = (r: any): DriveFolderDTO => ({
  id: r.id, parentId: r.parent_id, name: r.name, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(),
});
const fileDTO = (r: any): DriveFileDTO => ({
  id: r.id, folderId: r.folder_id, name: r.name, contentType: r.content_type, size: r.size_bytes,
  createdBy: r.owner_id, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  visibility: r.workspace_id || r.conversation_id ? (r.visibility ?? 'shared') : 'private',
});

async function announce(c: Tx, s: Scope, privateOnly = false) {
  let userIds = [s.userId];
  if (!privateOnly && s.conversationId) {
    const { rows } = await c.query(`SELECT m.user_id FROM conversation_memberships m JOIN users u ON u.id = m.user_id
      JOIN conversations conv ON conv.id = m.conversation_id
      LEFT JOIN workspace_memberships wm ON wm.workspace_id = conv.workspace_id AND wm.user_id = m.user_id
      WHERE m.conversation_id = $1 AND m.removed_at IS NULL AND u.disabled_at IS NULL
      AND (conv.workspace_id IS NULL OR (wm.revoked_at IS NULL AND wm.user_id IS NOT NULL AND (wm.expires_at IS NULL OR wm.expires_at > now())))`, [s.conversationId]);
    userIds = rows.map((r) => r.user_id);
  } else if (!privateOnly && s.workspaceId) {
    const { rows } = await c.query('SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())', [s.workspaceId]);
    userIds = rows.map((r) => r.user_id);
  }
  await enqueueOutbox(c, 'account.event', { userIds, event: { type: 'drive.updated', workspaceId: s.workspaceId, conversationId: s.conversationId } });
}

export async function tree(userId: string, workspaceId: string | null, conversationId: string | null = null): Promise<DriveTreeDTO> {
  const s = await scopeFor(pool, userId, workspaceId, conversationId);
  const [folders, files] = await Promise.all([
    pool.query(`SELECT * FROM folders f WHERE ${scopeWhere('f', s, 1)} AND f.deleted_at IS NULL ORDER BY lower(f.name) LIMIT ${MAX_ITEMS}`, [scopeParam(s)]),
    pool.query(`SELECT * FROM files f WHERE f.purpose = 'document' AND ${scopeWhere('f', s, 1)}
      AND f.deleted_at IS NULL AND (f.visibility = 'shared' OR f.owner_id = $2)
      ORDER BY lower(f.name) LIMIT ${MAX_ITEMS}`, [scopeParam(s), userId]),
  ]);
  return { workspaceId: s.workspaceId, conversationId: s.conversationId, folders: folders.rows.map(folderDTO), files: files.rows.map(fileDTO), canManageAll: s.canManageAll, canUpload: s.canUpload };
}

async function loadFolder(c: Db, id: string, lock = false) {
  const { rows } = await c.query(`SELECT * FROM folders WHERE id = $1 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw notFound('Carpeta');
  return rows[0];
}
async function folderInScope(c: Db, s: Scope, folderId: string | null, lock = false) {
  if (!folderId) return null;
  let f = await loadFolder(c, folderId);
  const check = () => {
    if ((f.workspace_id ?? null) !== s.workspaceId || (f.conversation_id ?? null) !== s.conversationId || (!sharedScope(s) && f.owner_id !== s.userId)) throw notFound('Carpeta');
  };
  check();
  // Never lock a foreign audience's folder: that would reverse scope lock order.
  if (lock) { f = await loadFolder(c, folderId, true); check(); }
  return f;
}
async function nameTaken(c: Db, s: Scope, parentId: string | null, name: string, exceptId: string | null = null) {
  const { rowCount } = await c.query(`SELECT 1 FROM folders f WHERE ${scopeWhere('f', s, 1)} AND f.deleted_at IS NULL
    AND f.parent_id IS NOT DISTINCT FROM $2 AND lower(f.name) = lower($3) AND ($4::uuid IS NULL OR f.id <> $4)`, [scopeParam(s), parentId, name, exceptId]);
  return !!rowCount;
}
const cleanName = (n: string) => {
  const v = n.normalize('NFC').replace(/[\u0000-\u001f\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!v || v === '.' || v === '..') throw badRequest('Nombre inválido');
  return v.slice(0, 120);
};
async function rowScope(c: Db, userId: string, r: any, write = true) {
  const s = await scopeFor(c, userId, r.workspace_id ?? null, r.conversation_id ?? null, write).catch(() => { throw notFound('Archivo o carpeta'); });
  if (!sharedScope(s) && r.owner_id !== userId) throw notFound('Archivo o carpeta');
  return s;
}

export async function createFolder(userId: string, input: { workspaceId?: string | null; conversationId?: string | null; parentId?: string | null; name: string }) {
  return tx(async (c) => {
    const s = await scopeFor(c, userId, input.workspaceId ?? null, input.conversationId ?? null, true);
    await lockScope(c, s);
    await folderInScope(c, s, input.parentId ?? null, true);
    const name = cleanName(input.name);
    if (await nameTaken(c, s, input.parentId ?? null, name)) throw conflict('Ya hay una carpeta con ese nombre aquí');
    const { rows } = await c.query('INSERT INTO folders (workspace_id, conversation_id, owner_id, parent_id, name, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [s.workspaceId, s.conversationId, sharedScope(s) ? null : userId, input.parentId ?? null, name, userId]);
    await announce(c, s);
    return folderDTO(rows[0]);
  });
}

export async function updateFolder(userId: string, id: string, input: { name?: string; parentId?: string | null }) {
  return tx(async (c) => {
    const s = await rowScope(c, userId, await loadFolder(c, id));
    await lockScope(c, s);
    const f = await loadFolder(c, id, true);
    if (!s.canManageAll && f.created_by !== userId) throw forbidden('Solo quien la creó o quien administra el espacio');
    const parentId = input.parentId === undefined ? f.parent_id : input.parentId;
    if (input.parentId !== undefined && parentId) {
      await folderInScope(c, s, parentId, true);
      const { rows } = await c.query(`WITH RECURSIVE up AS (SELECT id, parent_id FROM folders WHERE id = $1
        UNION ALL SELECT p.id, p.parent_id FROM folders p JOIN up ON p.id = up.parent_id) SELECT 1 FROM up WHERE id = $2`, [parentId, id]);
      if (rows.length) throw badRequest('No puedes mover una carpeta dentro de sí misma');
    }
    const name = input.name !== undefined ? cleanName(input.name) : f.name;
    if (await nameTaken(c, s, parentId, name, id)) throw conflict('Ya hay una carpeta con ese nombre aquí');
    const { rows } = await c.query('UPDATE folders SET name = $2, parent_id = $3, updated_at = now() WHERE id = $1 RETURNING *', [id, name, parentId]);
    await announce(c, s);
    return folderDTO(rows[0]);
  });
}

export async function deleteFolder(userId: string, id: string) {
  return tx(async (c) => {
    const s = await rowScope(c, userId, await loadFolder(c, id));
    await lockScope(c, s);
    const f = await loadFolder(c, id, true);
    if (!s.canManageAll && f.created_by !== userId) throw forbidden('Solo quien la creó o quien administra el espacio');
    const { rows } = await c.query(`WITH RECURSIVE down AS (SELECT id FROM folders WHERE id = $1
      UNION ALL SELECT ch.id FROM folders ch JOIN down ON ch.parent_id = down.id WHERE ch.deleted_at IS NULL) SELECT id FROM down`, [id]);
    const ids = rows.map((r) => r.id);
    await c.query('SELECT id FROM folders WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY id FOR UPDATE', [ids]);
    // Lock every document, including shared ones, before checking privacy. A concurrent
    // owner privacy change must finish first (or wait until this deletion finishes).
    const descendants = await c.query(`SELECT id, owner_id, visibility FROM files
      WHERE folder_id = ANY($1) AND deleted_at IS NULL AND purpose = 'document' ORDER BY id FOR UPDATE`, [ids]);
    if (descendants.rows.some((file) => file.owner_id !== userId && (file.visibility === 'private' || !s.canManageAll))) {
      throw forbidden('La carpeta contiene archivos de otra persona que no puedes eliminar');
    }
    await c.query('UPDATE folders SET deleted_at = now() WHERE id = ANY($1)', [ids]);
    const files = await c.query("UPDATE files SET deleted_at = now() WHERE id = ANY($1) AND deleted_at IS NULL AND purpose = 'document'", [descendants.rows.map((file) => file.id)]);
    await announce(c, s);
    return { folders: ids.length, files: files.rowCount ?? 0 };
  });
}

export async function uploadFile(userId: string, input: { workspaceId: string | null; conversationId?: string | null; folderId: string | null; visibility?: DriveVisibility; name: string; contentType: string; body: Buffer }) {
  if (!input.body?.length) throw badRequest('El archivo está vacío');
  if (input.body.length > MAX_FILE_BYTES) throw badRequest('El archivo pesa más de 25 MB');
  const s = await scopeFor(pool, userId, input.workspaceId, input.conversationId ?? null, true);
  await folderInScope(pool, s, input.folderId);
  const name = cleanName(input.name);
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(input.contentType) ? input.contentType : 'application/octet-stream';
  const visibility = sharedScope(s) ? (input.visibility ?? 'shared') : 'private';
  const id = randomUUID();
  const audience = s.conversationId ? `chat/${s.conversationId}` : s.workspaceId ? `ws/${s.workspaceId}` : `me/${userId}`;
  const key = objectKey(`drive/${audience}/${id}`);
  await putObject(key, input.body, type);
  return tx(async (c) => {
    // Recheck membership and folder after the network upload.
    const current = await scopeFor(c, userId, s.workspaceId, s.conversationId, true);
    await lockScope(c, current);
    await folderInScope(c, current, input.folderId, true);
    const { rows } = await c.query(`INSERT INTO files (id, owner_id, purpose, s3_key, content_type, size_bytes, name, workspace_id, conversation_id, folder_id, visibility)
      VALUES ($1,$2,'document',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [id, userId, key, type, input.body.length, name, s.workspaceId, s.conversationId, input.folderId, visibility]);
    await announce(c, current, visibility === 'private');
    return fileDTO(rows[0]);
  });
}

async function loadFile(c: Db, userId: string, id: string, write = false) {
  // Discover the immutable audience without holding a row lock, so scope locking
  // always precedes row locking, including when deleting a whole folder.
  let result = await c.query("SELECT * FROM files WHERE id = $1 AND purpose = 'document' AND deleted_at IS NULL", [id]);
  let f = result.rows[0];
  if (!f || (f.visibility === 'private' && f.owner_id !== userId)) throw notFound('Archivo');
  let s = await rowScope(c, userId, f, write);
  // Mutation ACL and the values used by UPDATE must come from the same locked row.
  // In particular, an admin rename cannot restore stale shared visibility after
  // the uploader has made the document private.
  if (write) {
    await lockScope(c as Tx, s);
    result = await c.query("SELECT * FROM files WHERE id = $1 AND purpose = 'document' AND deleted_at IS NULL FOR UPDATE", [id]);
    f = result.rows[0];
    if (!f || (f.visibility === 'private' && f.owner_id !== userId)) throw notFound('Archivo');
    s = await rowScope(c, userId, f, true);
  }
  return { f, s };
}
export async function updateFile(userId: string, id: string, input: { name?: string; folderId?: string | null; visibility?: DriveVisibility }) {
  return tx(async (c) => {
    const { f, s } = await loadFile(c, userId, id, true);
    if (!s.canManageAll && f.owner_id !== userId) throw forbidden('Solo quien lo subió o quien administra el espacio');
    // Visibility is consent from the uploader, including for administrators.
    if (input.visibility !== undefined && f.owner_id !== userId) throw forbidden('Solo quien lo subió puede cambiar su privacidad');
    if (input.visibility === 'shared' && !sharedScope(s)) throw badRequest('Para compartir el archivo, súbelo en un grupo o chat');
    const folderId = input.folderId === undefined ? f.folder_id : input.folderId;
    if (input.folderId !== undefined) await folderInScope(c, s, folderId, true);
    const name = input.name !== undefined ? cleanName(input.name) : f.name;
    const visibility = sharedScope(s) ? (input.visibility ?? f.visibility) : 'private';
    const { rows } = await c.query('UPDATE files SET name = $2, folder_id = $3, visibility = $4, updated_at = now() WHERE id = $1 RETURNING *', [id, name, folderId, visibility]);
    await announce(c, s, visibility === 'private' && f.visibility === 'private');
    return fileDTO(rows[0]);
  });
}
export async function deleteFile(userId: string, id: string) {
  return tx(async (c) => {
    const { f, s } = await loadFile(c, userId, id, true);
    if (!s.canManageAll && f.owner_id !== userId) throw forbidden('Solo quien lo subió o quien administra el espacio');
    await c.query('UPDATE files SET deleted_at = now() WHERE id = $1', [id]);
    await announce(c, s, f.visibility === 'private');
    return { ok: true };
  });
}
export async function downloadLink(userId: string, id: string) {
  const { f } = await loadFile(pool, userId, id);
  return { url: await presignDownload(f.s3_key, f.name, f.content_type), expiresIn: 300 };
}
export async function createDocument(userId: string, input: CreateDriveDocumentInput) {
  // Reject an inaccessible audience before spending CPU on generation.
  const s = await scopeFor(pool, userId, input.workspaceId ?? null, input.conversationId ?? null, true);
  await folderInScope(pool, s, input.folderId ?? null);
  const doc = await generateDriveDocument(input);
  return uploadFile(userId, { workspaceId: s.workspaceId, conversationId: s.conversationId, folderId: input.folderId ?? null,
    visibility: input.visibility ?? 'private', ...doc });
}
