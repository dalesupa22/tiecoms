/**
 * Archivos en árbol de carpetas. Dos alcances:
 *  - «Mis archivos» (workspaceId null): solo su dueño.
 *  - Un espacio: todos sus miembros activos leen y suben; borra o renombra lo
 *    ajeno solo quien lidera o administra el espacio.
 * Los binarios van a S3; aquí vive el árbol. El borrado es lógico.
 */
import { randomUUID } from 'node:crypto';
import type { DriveFileDTO, DriveFolderDTO, DriveTreeDTO } from '@tiecoms/contracts';
import { workspaceAccess } from '../access.ts';
import { enqueueOutbox, pool, tx, type Db, type Tx } from '../db.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { objectKey, presignDownload, putObject } from '../storage.ts';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ITEMS = 5000;

interface Scope { workspaceId: string | null; userId: string; canManageAll: boolean }

async function scopeFor(db: Db, userId: string, workspaceId: string | null): Promise<Scope> {
  if (!workspaceId) return { workspaceId: null, userId, canManageAll: true };
  const a = await workspaceAccess(db, userId, workspaceId, 'member');
  return { workspaceId, userId, canManageAll: a.role === 'lead' || a.role === 'admin' };
}

const scopeWhere = (alias: string, s: Scope, p: number) =>
  s.workspaceId ? `${alias}.workspace_id = $${p}` : `${alias}.workspace_id IS NULL AND ${alias}.owner_id = $${p}`;
const scopeParam = (s: Scope) => s.workspaceId ?? s.userId;

const folderDTO = (r: any): DriveFolderDTO => ({
  id: r.id, parentId: r.parent_id, name: r.name, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(),
});
const fileDTO = (r: any): DriveFileDTO => ({
  id: r.id, folderId: r.folder_id, name: r.name, contentType: r.content_type, size: r.size_bytes,
  createdBy: r.owner_id, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
});

/** Avisa a quienes ven el árbol para que lo vuelvan a pedir. */
async function announce(c: Tx, s: Scope) {
  let userIds = [s.userId];
  if (s.workspaceId) {
    const { rows } = await c.query(
      `SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [s.workspaceId],
    );
    userIds = rows.map((r) => r.user_id);
  }
  await enqueueOutbox(c, 'account.event', { userIds, event: { type: 'drive.updated', workspaceId: s.workspaceId } });
}

export async function tree(userId: string, workspaceId: string | null): Promise<DriveTreeDTO> {
  const s = await scopeFor(pool, userId, workspaceId);
  const [folders, files] = await Promise.all([
    pool.query(`SELECT * FROM folders f WHERE ${scopeWhere('f', s, 1)} AND f.deleted_at IS NULL ORDER BY lower(f.name) LIMIT ${MAX_ITEMS}`, [scopeParam(s)]),
    pool.query(
      `SELECT * FROM files f WHERE f.purpose = 'document' AND ${s.workspaceId ? 'f.workspace_id = $1' : 'f.workspace_id IS NULL AND f.owner_id = $1'}
          AND f.deleted_at IS NULL ORDER BY lower(f.name) LIMIT ${MAX_ITEMS}`,
      [scopeParam(s)],
    ),
  ]);
  return { workspaceId, folders: folders.rows.map(folderDTO), files: files.rows.map(fileDTO), canManageAll: s.canManageAll };
}

async function loadFolder(c: Db, id: string) {
  const { rows } = await c.query('SELECT * FROM folders WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!rows[0]) throw notFound('Carpeta');
  return rows[0];
}

/** La carpeta debe estar en el mismo alcance que se pide. */
async function folderInScope(c: Db, s: Scope, folderId: string | null) {
  if (!folderId) return null;
  const f = await loadFolder(c, folderId);
  if ((f.workspace_id ?? null) !== s.workspaceId || (!s.workspaceId && f.owner_id !== s.userId)) throw notFound('Carpeta');
  return f;
}

async function nameTaken(c: Db, s: Scope, parentId: string | null, name: string, exceptId: string | null = null) {
  const { rowCount } = await c.query(
    `SELECT 1 FROM folders f WHERE ${scopeWhere('f', s, 1)} AND f.deleted_at IS NULL
        AND f.parent_id IS NOT DISTINCT FROM $2 AND lower(f.name) = lower($3) AND ($4::uuid IS NULL OR f.id <> $4)`,
    [scopeParam(s), parentId, name, exceptId],
  );
  return !!rowCount;
}

const cleanName = (n: string) => {
  const v = n.normalize('NFC').replace(/[\u0000-\u001f\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!v || v === '.' || v === '..') throw badRequest('Nombre inválido');
  return v.slice(0, 120);
};

export async function createFolder(userId: string, input: { workspaceId?: string | null; parentId?: string | null; name: string }) {
  return tx(async (c) => {
    const s = await scopeFor(c, userId, input.workspaceId ?? null);
    await folderInScope(c, s, input.parentId ?? null);
    const name = cleanName(input.name);
    if (await nameTaken(c, s, input.parentId ?? null, name)) throw conflict('Ya hay una carpeta con ese nombre aquí');
    const { rows } = await c.query(
      'INSERT INTO folders (workspace_id, owner_id, parent_id, name, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [s.workspaceId, s.workspaceId ? null : userId, input.parentId ?? null, name, userId],
    );
    await announce(c, s);
    return folderDTO(rows[0]);
  });
}

function scopeOfRow(r: any): string | null { return r.workspace_id ?? null; }

export async function updateFolder(userId: string, id: string, input: { name?: string; parentId?: string | null }) {
  return tx(async (c) => {
    const f = await loadFolder(c, id);
    const s = await scopeFor(c, userId, scopeOfRow(f));
    if (!s.workspaceId && f.owner_id !== userId) throw notFound('Carpeta');
    if (!s.canManageAll && f.created_by !== userId) throw forbidden('Solo quien la creó o quien administra el espacio');
    const parentId = input.parentId === undefined ? f.parent_id : input.parentId;
    if (input.parentId !== undefined && parentId) {
      await folderInScope(c, s, parentId);
      // No se puede meter una carpeta dentro de sí misma ni de una de sus hijas.
      const { rows } = await c.query(
        `WITH RECURSIVE up AS (SELECT id, parent_id FROM folders WHERE id = $1
                               UNION ALL SELECT p.id, p.parent_id FROM folders p JOIN up ON p.id = up.parent_id)
         SELECT 1 FROM up WHERE id = $2`,
        [parentId, id],
      );
      if (rows.length) throw badRequest('No puedes mover una carpeta dentro de sí misma');
    }
    const name = input.name !== undefined ? cleanName(input.name) : f.name;
    if (await nameTaken(c, s, parentId, name, id)) throw conflict('Ya hay una carpeta con ese nombre aquí');
    const { rows } = await c.query('UPDATE folders SET name = $2, parent_id = $3, updated_at = now() WHERE id = $1 RETURNING *', [id, name, parentId]);
    await announce(c, s);
    return folderDTO(rows[0]);
  });
}

/** Borra la carpeta con todo lo que tiene dentro (lógico). */
export async function deleteFolder(userId: string, id: string) {
  return tx(async (c) => {
    const f = await loadFolder(c, id);
    const s = await scopeFor(c, userId, scopeOfRow(f));
    if (!s.workspaceId && f.owner_id !== userId) throw notFound('Carpeta');
    if (!s.canManageAll && f.created_by !== userId) throw forbidden('Solo quien la creó o quien administra el espacio');
    const { rows } = await c.query(
      `WITH RECURSIVE down AS (SELECT id FROM folders WHERE id = $1
                               UNION ALL SELECT ch.id FROM folders ch JOIN down ON ch.parent_id = down.id WHERE ch.deleted_at IS NULL)
       SELECT id FROM down`,
      [id],
    );
    const ids = rows.map((r) => r.id);
    await c.query('UPDATE folders SET deleted_at = now() WHERE id = ANY($1)', [ids]);
    const files = await c.query("UPDATE files SET deleted_at = now() WHERE folder_id = ANY($1) AND deleted_at IS NULL AND purpose = 'document'", [ids]);
    await announce(c, s);
    return { folders: ids.length, files: files.rowCount ?? 0 };
  });
}

export async function uploadFile(userId: string, input: { workspaceId: string | null; folderId: string | null; name: string; contentType: string; body: Buffer }) {
  if (!input.body?.length) throw badRequest('El archivo está vacío');
  if (input.body.length > MAX_FILE_BYTES) throw badRequest('El archivo pesa más de 25 MB');
  const s = await scopeFor(pool, userId, input.workspaceId);
  await folderInScope(pool, s, input.folderId);
  const name = cleanName(input.name);
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(input.contentType) ? input.contentType : 'application/octet-stream';
  const id = randomUUID();
  const key = objectKey(`drive/${s.workspaceId ? `ws/${s.workspaceId}` : `me/${userId}`}/${id}`);
  await putObject(key, input.body, type);
  return tx(async (c) => {
    // Revalida dentro de la transacción: la carpeta pudo borrarse mientras subía.
    await folderInScope(c, s, input.folderId);
    const { rows } = await c.query(
      `INSERT INTO files (id, owner_id, purpose, s3_key, content_type, size_bytes, name, workspace_id, folder_id)
       VALUES ($1,$2,'document',$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, userId, key, type, input.body.length, name, s.workspaceId, input.folderId],
    );
    await announce(c, s);
    return fileDTO(rows[0]);
  });
}

async function loadFile(c: Db, userId: string, id: string) {
  const { rows } = await c.query("SELECT * FROM files WHERE id = $1 AND purpose = 'document' AND deleted_at IS NULL", [id]);
  const f = rows[0];
  if (!f) throw notFound('Archivo');
  const s = await scopeFor(c, userId, f.workspace_id ?? null).catch(() => { throw notFound('Archivo'); });
  if (!s.workspaceId && f.owner_id !== userId) throw notFound('Archivo');
  return { f, s };
}

export async function updateFile(userId: string, id: string, input: { name?: string; folderId?: string | null }) {
  return tx(async (c) => {
    const { f, s } = await loadFile(c, userId, id);
    if (!s.canManageAll && f.owner_id !== userId) throw forbidden('Solo quien lo subió o quien administra el espacio');
    const folderId = input.folderId === undefined ? f.folder_id : input.folderId;
    if (input.folderId !== undefined) await folderInScope(c, s, folderId);
    const name = input.name !== undefined ? cleanName(input.name) : f.name;
    const { rows } = await c.query('UPDATE files SET name = $2, folder_id = $3, updated_at = now() WHERE id = $1 RETURNING *', [id, name, folderId]);
    await announce(c, s);
    return fileDTO(rows[0]);
  });
}

export async function deleteFile(userId: string, id: string) {
  return tx(async (c) => {
    const { f, s } = await loadFile(c, userId, id);
    if (!s.canManageAll && f.owner_id !== userId) throw forbidden('Solo quien lo subió o quien administra el espacio');
    await c.query('UPDATE files SET deleted_at = now() WHERE id = $1', [id]);
    await announce(c, s);
    return { ok: true };
  });
}

export async function downloadLink(userId: string, id: string) {
  const { f } = await loadFile(pool, userId, id);
  return { url: await presignDownload(f.s3_key, f.name, f.content_type), expiresIn: 300 };
}
