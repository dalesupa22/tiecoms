/** Receipts share the product MCP table; effects and receipts always commit together. */
import { pool, tx, type Tx } from '../db.ts';
import { ApiError } from '../errors.ts';
import { sha256 } from '../security.ts';
import type { McpCtx } from './mcp-wa.ts';

const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)])) : v;

export const requestHash = (operation: string, payload: unknown) => sha256(JSON.stringify(canonical([operation, payload])));
const receiptKey = (key: string) => `chaggu-v1:${key}`;
const lockKey = (ctx: McpCtx, key: string) => `mcp-request:${ctx.tokenId}:${receiptKey(key)}`;
type Authorize = (c: Tx) => Promise<unknown>;
type Replay<T> = (c: Tx, response: T) => Promise<void>;

async function previous<T>(c: Tx, ctx: McpCtx, key: string, hash: Buffer, replay?: Replay<T>): Promise<{ response: T } | null> {
  const r = (await c.query('SELECT request, response FROM mcp_idempotency WHERE token_id = $1 AND key = $2', [ctx.tokenId, receiptKey(key)])).rows[0];
  if (!r) return null;
  if (!r.request.equals(hash)) throw new ApiError(409, 'idempotency_mismatch', 'Esta llave ya se usó para otra operación o contenido');
  if (r.response === null) throw new ApiError(409, 'in_progress', 'La operación sigue en curso; reintenta con la misma llave');
  if (replay) await replay(c, r.response as T);
  return { response: r.response as T };
}

async function save(c: Tx, ctx: McpCtx, key: string, hash: Buffer, response: unknown) {
  await c.query('INSERT INTO mcp_idempotency (token_id, key, request, response) VALUES ($1,$2,$3,$4)',
    [ctx.tokenId, receiptKey(key), hash, JSON.stringify(response)]);
}

/** SQL-only operation: serialize retries before the product function sees the request. */
export async function idempotent<T>(ctx: McpCtx, key: string | undefined, operation: string, payload: unknown,
  authorize: Authorize, run: (c: Tx) => Promise<T>, replay?: Replay<T>): Promise<T> {
  const hash = requestHash(operation, payload);
  return tx(async (c) => {
    if (key) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey(ctx, key)]);
    await authorize(c);
    if (key) {
      const prev = await previous(c, ctx, key, hash, replay);
      if (prev) return prev.response;
    }
    const out = await run(c);
    if (key) await save(c, ctx, key, hash, out);
    return out;
  });
}

/**
 * Uploads hold a SESSION advisory lock, never an open SQL transaction during S3 I/O.
 * The same connection does the short preflight and commit, so concurrent uploads cannot
 * exhaust the pool while waiting for a second connection. A process crash releases the
 * lock; a retry overwrites the same deterministic object, then commits one row/receipt.
 */
export async function idempotentUpload<P, T>(ctx: McpCtx, key: string, operation: string, payload: unknown,
  authorize: Authorize, prepare: () => Promise<P>, run: (c: Tx, prepared: P) => Promise<T>, replay?: Replay<T>): Promise<T> {
  const c = await pool.connect();
  const hash = requestHash(operation, payload);
  let locked = false, inTx = false, releaseError: Error | undefined;
  try {
    await c.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey(ctx, key)]);
    locked = true;
    await c.query('BEGIN'); inTx = true;
    await authorize(c);
    const prev = await previous(c, ctx, key, hash, replay);
    await c.query('COMMIT'); inTx = false;
    if (prev) return prev.response;
    const prepared = await prepare();
    // Only SQL below. Revalidate permissions after the possibly slow upload.
    await c.query('BEGIN'); inTx = true;
    await authorize(c);
    const out = await run(c, prepared);
    await save(c, ctx, key, hash, out);
    await c.query('COMMIT'); inTx = false;
    return out;
  } finally {
    if (inTx) await c.query('ROLLBACK').catch((e: Error) => { releaseError = e; });
    if (locked) await c.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey(ctx, key)]).catch((e: Error) => { releaseError = e; });
    // A connection whose unlock failed must not be recycled with a held session lock.
    c.release(releaseError);
  }
}
