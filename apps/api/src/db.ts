import pg from 'pg';
import { config, pgSsl } from './config.ts';

// bigint (int8) llega como string por defecto; las secuencias caben en Number.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: pgSsl(),
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  application_name: `tiecoms-${config.instanceId}`,
});

pool.on('error', (err) => console.error('[db] error en cliente inactivo', err.message));

export type Db = pg.PoolClient | pg.Pool;
export type Tx = pg.PoolClient;

/**
 * Ejecuta fn dentro de una transacción corta. Reintenta ante conflictos de
 * serialización o deadlocks (40001/40P01). Nunca hagas llamadas de red
 * (IA, S3, correo) dentro de fn: van al outbox o a jobs.
 */
export async function tx<T>(fn: (c: Tx) => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (i < attempts && (err?.code === '40001' || err?.code === '40P01')) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Registra un evento para publicar después del commit (patrón outbox). */
export async function enqueueOutbox(c: Tx, topic: string, payload: unknown) {
  await c.query('INSERT INTO outbox (topic, payload) VALUES ($1, $2)', [topic, JSON.stringify(payload)]);
  // NOTIFY se entrega solo si la transacción hace commit: es un despertador, no el transporte.
  await c.query("SELECT pg_notify('tiecoms_outbox', '')");
}

export async function audit(c: Tx, actorId: string | null, action: string, target: { type?: string; id?: string; workspaceId?: string | null }, meta: object = {}) {
  await c.query(
    'INSERT INTO audit_events (actor_id, action, target_type, target_id, workspace_id, meta) VALUES ($1,$2,$3,$4,$5,$6)',
    [actorId, action, target.type ?? null, target.id ?? null, target.workspaceId ?? null, JSON.stringify(meta)],
  );
}
