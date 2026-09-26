import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.ts';

// En dist/ las migraciones se copian junto al bundle; en desarrollo están en ../migrations.
const here = dirname(fileURLToPath(import.meta.url));
const dirs = [join(here, 'migrations'), join(here, '..', 'migrations')];

export async function migrate() {
  let dir = '';
  for (const d of dirs) { try { await readdir(d); dir = d; break; } catch {} }
  if (!dir) throw new Error('No encuentro la carpeta de migraciones');
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  try {
    // Un solo migrador a la vez aunque arranquen varios contenedores.
    // Esperar el lock (u otra migración larga) no debe cortarse por el statement_timeout del pool.
    await client.query('SET statement_timeout = 0');
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [f]);
        await client.query('COMMIT');
        console.log(`[migrate] aplicada ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    await client.query('RESET statement_timeout').catch(() => {});
    client.release();
  }
}
