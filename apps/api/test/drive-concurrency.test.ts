/** Real PostgreSQL row-lock races, restricted to the disposable Lorena database. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

const localDb = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '55434' && url.pathname === '/chaggu_lorena_test';
  } catch { return false; }
})();
const localStorage = (() => {
  try { return ['localhost', '127.0.0.1'].includes(new URL(process.env.S3_ENDPOINT ?? '').hostname); }
  catch { return false; }
})();

describe.skipIf(!localDb)('Drive concurrent privacy changes', () => {
  let db: Pool, drive: typeof import('../src/modules/drive.ts'), appPool: Pool;
  const orgId = randomUUID(), ownerId = randomUUID(), adminId = randomUUID(), workspaceId = randomUUID();
  let folderId: string, fileId: string;

  beforeAll(async () => {
    const pg = await import('pg');
    db = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    drive = await import('../src/modules/drive.ts');
    appPool = (await import('../src/db.ts')).pool;
    await db.query('INSERT INTO organizations (id,name,mark,color_bg,color_fg) VALUES ($1,$2,$3,$4,$5)', [orgId, 'Drive concurrency test', 'D', '#ffffff', '#000000']);
    for (const [id, name] of [[ownerId, 'File owner'], [adminId, 'Workspace admin']]) {
      await db.query('INSERT INTO users (id,email,name,primary_org_id) VALUES ($1,$2,$3,$4)', [id, `${id}@concurrency.example.test`, name, orgId]);
    }
    await db.query('INSERT INTO workspaces (id,owning_org_id,name,created_by) VALUES ($1,$2,$3,$4)', [workspaceId, orgId, 'Drive lock tests', adminId]);
    for (const [id, role] of [[ownerId, 'member'], [adminId, 'admin']]) {
      await db.query('INSERT INTO workspace_memberships (workspace_id,user_id,org_id,role) VALUES ($1,$2,$3,$4)', [workspaceId, id, orgId, role]);
    }
  });
  beforeEach(async () => {
    folderId = randomUUID(); fileId = randomUUID();
    await db.query('INSERT INTO folders (id,workspace_id,name,created_by) VALUES ($1,$2,$3,$4)', [folderId, workspaceId, folderId, adminId]);
    await db.query(`INSERT INTO files (id,owner_id,purpose,s3_key,content_type,size_bytes,name,workspace_id,folder_id,visibility)
      VALUES ($1,$2,'document',$3,'text/plain',4,'original.txt',$4,$5,'shared')`, [fileId, ownerId, `test-only/${fileId}`, workspaceId, folderId]);
  });
  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM outbox WHERE payload::text LIKE $1', [`%${workspaceId}%`]);
      await db.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
      await db.query('DELETE FROM users WHERE id=ANY($1)', [[ownerId, adminId]]);
      await db.query('DELETE FROM organizations WHERE id=$1', [orgId]);
      await db.end();
    }
    await appPool?.end();
  });

  /** Wait for an observed database lock, not an assumed scheduling delay. */
  async function awaitBlockedOn(blocker: PoolClient, count = 1) {
    const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
    for (let attempt = 0; attempt < 100; attempt++) {
      const { rows } = await db.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND state=$2', [pid, 'active']);
      if (rows.length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected the competing Drive mutation to wait on the owner row lock');
  }

  it('admin rename cannot restore shared visibility after an owner privacy change', async () => {
    const owner = await db.connect();
    let result: Promise<{ value?: unknown; error?: any }> | undefined;
    try {
      await owner.query('BEGIN');
      await owner.query("UPDATE files SET visibility='private' WHERE id=$1", [fileId]);
      result = drive.updateFile(adminId, fileId, { name: 'admin-rename.txt' }).then((value) => ({ value }), (error) => ({ error }));
      await awaitBlockedOn(owner);
      await owner.query('COMMIT');
      expect((await result).error).toMatchObject({ status: 404 });
      expect((await db.query('SELECT name,visibility,deleted_at FROM files WHERE id=$1', [fileId])).rows[0]).toMatchObject({ name: 'original.txt', visibility: 'private', deleted_at: null });
    } finally { await owner.query('ROLLBACK'); owner.release(); await result; }
  });

  it('ancestor deletion cannot erase a file the owner concurrently makes private', async () => {
    const owner = await db.connect();
    let result: Promise<{ value?: unknown; error?: any }> | undefined;
    try {
      await owner.query('BEGIN');
      await owner.query("UPDATE files SET visibility='private' WHERE id=$1", [fileId]);
      result = drive.deleteFolder(adminId, folderId).then((value) => ({ value }), (error) => ({ error }));
      await awaitBlockedOn(owner);
      await owner.query('COMMIT');
      expect((await result).error).toMatchObject({ status: 403 });
      expect((await db.query('SELECT visibility,deleted_at FROM files WHERE id=$1', [fileId])).rows[0]).toMatchObject({ visibility: 'private', deleted_at: null });
      expect((await db.query('SELECT deleted_at FROM folders WHERE id=$1', [folderId])).rows[0].deleted_at).toBeNull();
    } finally { await owner.query('ROLLBACK'); owner.release(); await result; }
  });

  it.skipIf(!localStorage)('a private upload queued before folder deletion is protected from that deletion', async () => {
    const coordinator = await db.connect();
    let uploading: Promise<{ value?: unknown; error?: any }> | undefined, deleting: Promise<{ value?: unknown; error?: any }> | undefined;
    const name = `late-private-${randomUUID()}.txt`;
    try {
      await coordinator.query('BEGIN');
      await coordinator.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`chaggu:drive:workspace:${workspaceId}`]);
      uploading = drive.uploadFile(ownerId, { workspaceId, folderId, name, visibility: 'private', contentType: 'text/plain', body: Buffer.from('late private content') })
        .then((value) => ({ value }), (error) => ({ error }));
      await awaitBlockedOn(coordinator);
      deleting = drive.deleteFolder(adminId, folderId).then((value) => ({ value }), (error) => ({ error }));
      await awaitBlockedOn(coordinator, 2);
      await coordinator.query('COMMIT');
      expect((await uploading).error).toBeUndefined();
      expect((await deleting).error).toMatchObject({ status: 403 });
      expect((await db.query('SELECT visibility,deleted_at FROM files WHERE name=$1 AND owner_id=$2', [name, ownerId])).rows[0])
        .toMatchObject({ visibility: 'private', deleted_at: null });
      expect((await db.query('SELECT deleted_at FROM folders WHERE id=$1', [folderId])).rows[0].deleted_at).toBeNull();
    } finally { await coordinator.query('ROLLBACK'); coordinator.release(); await uploading; await deleting; }
  });

  it.skipIf(!localStorage)('an upload queued after folder deletion cannot insert into the deleted folder', async () => {
    const coordinator = await db.connect();
    let uploading: Promise<{ value?: unknown; error?: any }> | undefined, deleting: Promise<{ value?: unknown; error?: any }> | undefined;
    const name = `late-private-${randomUUID()}.txt`;
    try {
      await coordinator.query('BEGIN');
      await coordinator.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`chaggu:drive:workspace:${workspaceId}`]);
      deleting = drive.deleteFolder(adminId, folderId).then((value) => ({ value }), (error) => ({ error }));
      await awaitBlockedOn(coordinator);
      uploading = drive.uploadFile(ownerId, { workspaceId, folderId, name, visibility: 'private', contentType: 'text/plain', body: Buffer.from('late private content') })
        .then((value) => ({ value }), (error) => ({ error }));
      await awaitBlockedOn(coordinator, 2);
      await coordinator.query('COMMIT');
      expect((await deleting).error).toBeUndefined();
      expect((await uploading).error).toMatchObject({ status: 404 });
      expect((await db.query('SELECT id FROM files WHERE name=$1 AND owner_id=$2', [name, ownerId])).rows).toHaveLength(0);
      expect((await db.query('SELECT deleted_at FROM folders WHERE id=$1', [folderId])).rows[0].deleted_at).not.toBeNull();
    } finally { await coordinator.query('ROLLBACK'); coordinator.release(); await uploading; await deleting; }
  });
});
