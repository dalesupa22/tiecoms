import pg from 'pg';
import { config, pgSsl } from './config.ts';

// bigint (int8) llega como string por defecto; las secuencias caben en Number.
pg.types.setTypeParser(20, (v) => Number(v));

// statement_timeout lo aplica el servidor: si la conexión muere a mitad de una consulta (caída de la BD del
// 26-oct-2026), la respuesta nunca llega y el await quedaba colgado para siempre; el worker y el puente de
// WhatsApp siguieron «vivos» 2 días sin enviar nada. query_timeout corta del lado del cliente y keepAlive
// detecta el socket muerto. DB_QUERY_TIMEOUT_MS=0 lo desactiva (solo para pruebas).
const queryTimeout = Number(process.env.DB_QUERY_TIMEOUT_MS ?? 15_000);
const connection = {
  connectionString: config.databaseUrl,
  ssl: pgSsl(),
  connectionTimeoutMillis: 5_000,
  application_name: `tiecoms-${config.instanceId}`,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
};

export const pool = new pg.Pool({
  ...connection,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
  statement_timeout: 10_000,
  ...(queryTimeout > 0 ? { query_timeout: queryTimeout } : {}),
});

/** Conexión aparte sin tope del cliente, para lo que puede tardar a propósito (migraciones). Ciérrala con end(). */
export const directClient = () => new pg.Client({ ...connection, statement_timeout: 10_000 });

/** Un error que no vino de Postgres (timeout, socket caído): esa conexión no vuelve al pool. */
export const brokenConnection = (err: unknown) => !(err instanceof pg.DatabaseError);

pool.on('error', (err) => console.error('[db] error en cliente inactivo', err.message));
// El pool solo escucha errores de los clientes inactivos. Si la conexión se cae con un cliente prestado (una
// transacción, un LISTEN), su 'error' sin oyente tumba el proceso entero; la consulta en curso ya falla sola.
pool.on('connect', (client) => client.on('error', (err) => console.error('[db] error en cliente prestado', err.message)));

export type Db = pg.PoolClient | pg.Pool;
export type Tx = pg.PoolClient;

/**
 * Ejecuta fn dentro de una transacción corta. Reintenta ante conflictos de
 * serialización o deadlocks (40001/40P01). Nunca hagas llamadas de red
 * (IA, S3, correo) dentro de fn: van al outbox o a jobs.
 */
export async function tx<T>(fn: (c: Tx) => Promise<T>, attempts = 3): Promise<T> {
  let broken = false;
  for (let i = 1; ; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      // Una conexión que se quedó sin respuesta se descarta; si volviera al pool, la siguiente consulta caería igual.
      broken = brokenConnection(err);
      if (i < attempts && (err?.code === '40001' || err?.code === '40P01')) continue;
      throw err;
    } finally {
      client.release(broken);
      broken = false;
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
