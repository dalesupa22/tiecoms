/** Diagnóstico y recuperación de borrados personales, reservado al operador SSH. */
import { randomUUID } from 'node:crypto';
import { pool } from './db.ts';
import { deletePersonalObject, getObject, objectKey, putObject } from './storage.ts';

try {
  const command = process.argv[2] ?? 'status';
  if (command === 'status') {
    const { rows } = await pool.query(
      `SELECT id, payload->>'fileId' AS file_id, attempts, run_at, done_at, failed_at, last_error
        FROM jobs WHERE kind = 'account.delete_file' AND done_at IS NULL ORDER BY created_at LIMIT 100`,
    );
    console.log(JSON.stringify(rows, null, 2));
  } else if (command === 'retry-failed') {
    const { rowCount } = await pool.query(
      `UPDATE jobs SET failed_at = NULL, attempts = 0, run_at = now(), locked_until = NULL, last_error = NULL
        WHERE kind = 'account.delete_file' AND done_at IS NULL AND failed_at IS NOT NULL`,
    );
    console.log(JSON.stringify({ requeued: rowCount }));
  } else if (command === 'probe') {
    const key = objectKey(`avatars/deletion-probe-${randomUUID()}.txt`);
    await putObject(key, Buffer.from('Chaggu storage deletion verification'), 'text/plain');
    try { await deletePersonalObject(key); }
    catch (e) { console.error(`Objeto de diagnóstico pendiente de borrar: ${key}`); throw e; }
    let deleted = false;
    try { await getObject(key); }
    catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) deleted = true;
      else throw e;
    }
    if (!deleted) throw new Error('El objeto sigue disponible después de DeleteObject');
    console.log(JSON.stringify({ ok: true, deleted: true }));
  } else throw new Error('Uso: deletion.js status|probe|retry-failed');
} catch (e: any) {
  console.error(e?.message ?? 'Error de eliminación');
  process.exitCode = 1;
} finally { await pool.end(); }
