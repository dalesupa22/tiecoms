import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  receipt: null as null | { request: Buffer; response: unknown }, pending: null as null | { request: Buffer; response: unknown },
  inTx: false, failReceipt: false, failUnlock: false,
  client: { query: vi.fn(), release: vi.fn() },
}));
vi.mock('../src/config.ts', () => ({ config: { jwtSecret: 'local-test-key' } }));
vi.mock('../src/db.ts', () => ({
  pool: { connect: async () => state.client },
  tx: async (run: (c: typeof state.client) => Promise<unknown>) => {
    await state.client.query('BEGIN');
    try { const out = await run(state.client); await state.client.query('COMMIT'); return out; }
    catch (e) { await state.client.query('ROLLBACK'); throw e; }
  },
}));
import { idempotent, idempotentUpload } from '../src/modules/mcp-idempotency.ts';

const ctx = { userId: 'actor', tokenId: 'token', scopes: null, waAccountIds: null, clientName: 'test' };
beforeEach(() => {
  state.receipt = null; state.pending = null; state.inTx = false; state.failReceipt = false; state.failUnlock = false;
  state.client.release.mockReset();
  state.client.query.mockReset().mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql === 'BEGIN') { expect(state.inTx).toBe(false); state.inTx = true; state.pending = null; }
    if (sql === 'COMMIT') { if (state.pending) state.receipt = state.pending; state.inTx = false; }
    if (sql === 'ROLLBACK') { state.pending = null; state.inTx = false; }
    if (sql.startsWith('SELECT request, response')) return { rows: state.receipt ? [state.receipt] : [] };
    if (sql.startsWith('INSERT INTO mcp_idempotency')) {
      expect(state.inTx).toBe(true);
      if (state.failReceipt) throw new Error('receipt failure');
      state.pending = { request: args[2] as Buffer, response: JSON.parse(args[3] as string) };
    }
    if (sql.includes('pg_advisory_unlock') && state.failUnlock) throw new Error('unlock failure');
    return { rows: [] };
  });
});

describe('MCP idempotency transaction and cleanup boundaries', () => {
  it('commits the effect and receipt together, revalidates access, and rejects changed payloads', async () => {
    const authorize = vi.fn(async () => {});
    const effect = vi.fn(async () => { expect(state.inTx).toBe(true); return { id: 'only-one' }; });
    expect(await idempotent(ctx, 'unique-key', 'send', { text: 'a' }, authorize, effect)).toEqual({ id: 'only-one' });
    expect(state.receipt).not.toBeNull();
    expect(await idempotent(ctx, 'unique-key', 'send', { text: 'a' }, authorize, effect)).toEqual({ id: 'only-one' });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(2);
    await expect(idempotent(ctx, 'unique-key', 'send', { text: 'b' }, authorize, effect)).rejects.toMatchObject({ code: 'idempotency_mismatch' });
    authorize.mockRejectedValueOnce(new Error('access revoked'));
    await expect(idempotent(ctx, 'unique-key', 'send', { text: 'a' }, authorize, effect)).rejects.toThrow('access revoked');
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it('never opens a SQL transaction during S3 and skips S3 on a successful retry', async () => {
    const authorize = vi.fn(async () => { expect(state.inTx).toBe(true); });
    const upload = vi.fn(async () => { expect(state.inTx).toBe(false); return 'object-id'; });
    const persist = vi.fn(async (_c, id: string) => { expect(state.inTx).toBe(true); return { id }; });
    expect(await idempotentUpload(ctx, 'file-key', 'upload', {}, authorize, upload, persist)).toEqual({ id: 'object-id' });
    expect(authorize).toHaveBeenCalledTimes(2);
    await idempotentUpload(ctx, 'file-key', 'upload', {}, authorize, upload, persist);
    expect(upload).toHaveBeenCalledTimes(1); expect(persist).toHaveBeenCalledTimes(1);
    expect(state.client.release).toHaveBeenCalledTimes(2);
    expect(state.client.query.mock.calls.filter(([sql]) => sql.includes('pg_advisory_unlock'))).toHaveLength(2);
  });
  it('rolls back a failed receipt, releases the lock, and permits a clean retry', async () => {
    const upload = vi.fn(async () => 'deterministic-object');
    const persist = vi.fn(async (_c, id: string) => ({ id }));
    state.failReceipt = true;
    await expect(idempotentUpload(ctx, 'file-key', 'upload', {}, async () => {}, upload, persist)).rejects.toThrow('receipt failure');
    expect(state.receipt).toBeNull(); expect(state.inTx).toBe(false);
    expect(state.client.release).toHaveBeenCalledTimes(1);
    state.failReceipt = false;
    await expect(idempotentUpload(ctx, 'file-key', 'upload', {}, async () => {}, upload, persist)).resolves.toEqual({ id: 'deterministic-object' });
  });
  it('cleans up an upload failure and destroys a connection if session unlock fails', async () => {
    state.failUnlock = true;
    await expect(idempotentUpload(ctx, 'file-key', 'upload', {}, async () => {}, async () => { throw new Error('S3 failed'); }, async () => ({}))).rejects.toThrow('S3 failed');
    expect(state.receipt).toBeNull(); expect(state.inTx).toBe(false);
    expect(state.client.release).toHaveBeenCalledWith(expect.objectContaining({ message: 'unlock failure' }));
  });
  it('replays must pass the current resource check and never repeat an effect on failure', async () => {
    const effect = vi.fn(async () => ({ messageId: 'message-id' }));
    await idempotent(ctx, 'message-key', 'send', {}, async () => {}, effect);
    await expect(idempotent(ctx, 'message-key', 'send', {}, async () => {}, effect, async () => { throw new Error('message deleted'); })).rejects.toThrow('message deleted');
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
