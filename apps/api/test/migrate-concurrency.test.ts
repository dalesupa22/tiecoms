/**
 * Varios migradores a la vez (API, worker y el paso de deploy) sobre una base vacía:
 * el advisory lock serializa, ninguno falla y cada migración se aplica una sola vez.
 * Solo corre con DATABASE_URL local (crea y borra una base temporal).
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const local = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname);

function runMigrator(url: string) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', join(here, '..', 'src', 'migrate-cli.ts')], {
      cwd: join(here, '..'), env: { ...process.env, DATABASE_URL: url, JWT_SECRET: 'x'.repeat(40) },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

it.runIf(local)('tres migradores en paralelo sobre una base vacía no chocan ni repiten migraciones', async () => {
  const pg = await import('pg');
  const admin = new pg.default.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const name = `tiecoms_mig_${randomUUID().slice(0, 8)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
  try {
    const results = await Promise.all([runMigrator(url.toString()), runMigrator(url.toString()), runMigrator(url.toString())]);
    for (const r of results) expect(r.code, r.out).toBe(0);
    const files = readdirSync(join(here, '..', 'migrations')).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f));
    const applied = results.flatMap((r) => [...r.out.matchAll(/aplicada (\S+)/g)].map((m) => m[1]));
    expect(applied.sort()).toEqual([...files].sort());
    const db = new pg.default.Client({ connectionString: url.toString() });
    await db.connect();
    expect((await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(files.length);
    await db.end();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}, 120_000);
