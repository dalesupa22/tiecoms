/** Local fake-provider integration tests. These do not certify real provider OAuth or licensing. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';

const API = process.env.API_URL ?? 'http://127.0.0.1:3088';
const FAKE = process.env.FAKE_MEETINGS ?? 'http://127.0.0.1:59308';
const hash = (s: string) => createHash('sha256').update(s).digest('base64url');
type User = { token: string; id: string };
let a: User, b: User;
async function call(path: string, user?: User, body?: unknown, method?: string) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: method ?? (body ? 'POST' : 'GET'), headers: {
      'content-type': 'application/json', 'x-tiecoms-contract': '2026-09-28',
      ...(user ? { authorization: `Bearer ${user.token}` } : {}),
    }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() as any };
}
async function signup(): Promise<User> {
  const r = await call('/auth/signup', undefined, { name: 'Local review', orgName: 'Local review', email: `${randomUUID()}@example.com`, password: 'local-review-password-only', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken, id: r.json.user.id };
}
async function begin(user: User, provider = 'google', platform = 'web') {
  const proofVerifier = randomBytes(32).toString('base64url');
  const r = await call(`/meetings/connect/${provider}`, user, { platform, redirectScheme: 'chaggu', proofChallenge: hash(proofVerifier) });
  expect(r.status).toBe(200);
  expect(r.json.url).not.toContain(proofVerifier);
  const auth = await fetch(r.json.url, { redirect: 'manual' });
  return { proofVerifier, callback: auth.headers.get('location')!, provider };
}
async function callback(flow: Awaited<ReturnType<typeof begin>>) {
  const r = await fetch(flow.callback, { redirect: 'manual' });
  expect(r.status).toBe(302);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  const back = new URL(r.headers.get('location')!);
  expect(back.searchParams.has('connected')).toBe(false);
  return { receipt: back.searchParams.get('receipt')!, proofVerifier: flow.proofVerifier };
}
const status = async (u: User, p = 'google') => (await call('/meetings/connections', u)).json.connections.find((x: any) => x.provider === p).status;
async function connect(user: User, provider: string) {
  const proof = await callback(await begin(user, provider));
  expect((await call('/meetings/connect/confirm', user, proof)).json).toEqual({ ok: true, provider });
}
const control = (body: object) => fetch(`${FAKE}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const stats = async () => await (await fetch(`${FAKE}/stats`)).json() as { google: number; microsoft: number; zoom: number };
const input = (provider = 'google') => ({ provider, idempotencyKey: randomUUID(), title: 'Local recovery test', durationMin: 30, timezone: 'America/Bogota', share: false });

beforeAll(async () => {
  // Refuse DB mutations unless the explicitly dedicated local test database is in use.
  const db = new URL(process.env.DATABASE_URL!);
  if (!['localhost', '127.0.0.1'].includes(db.hostname) || !db.pathname.startsWith('/chaggu_meetings_review_')) throw new Error('Dedicated local meetings review database required');
  if (!['localhost', '127.0.0.1'].includes(new URL(API).hostname) || !['localhost', '127.0.0.1'].includes(new URL(FAKE).hostname)) throw new Error('Local fake services required');
  a = await signup(); b = await signup();
});
afterAll(async () => { await control({ googlePending: false, googleFailed: false, dropAfterCreate: null, revokeAll: false }); await pool.end(); });

describe('OAuth receiving-client confirmation', () => {
  it('requires client proof and does not activate a transferred URL; wrong user/proof cannot consume receipt', async () => {
    expect((await call('/meetings/connect/google', a, { platform: 'web' })).status).toBe(400);
    const flow = await begin(a);
    const proof = await callback(flow); // The receiving browser alone gets this receipt.
    expect(proof.receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await status(a)).toBe('none'); expect(await status(b)).toBe('none');
    expect((await call('/meetings/connect/confirm', b, proof)).json.error.code).toBe('meeting_confirmation_invalid');
    expect((await call('/meetings/connect/confirm', a, { ...proof, proofVerifier: randomBytes(32).toString('base64url') })).json.error.code).toBe('meeting_confirmation_invalid');
    expect(await status(a)).toBe('none');
    expect((await call('/meetings/connect/confirm', undefined, proof)).status).toBe(401);
    // Only the original session with both secrets can now activate the pending connection.
    expect((await call('/meetings/connect/confirm', a, proof)).json).toEqual({ ok: true, provider: 'google' });
    expect(await status(a)).toBe('active'); expect(await status(b)).toBe('none');
    expect((await call('/meetings/connect/confirm', a, proof)).json.error.code).toBe('meeting_confirmation_invalid');
  });
  it('binds callback to its provider without consuming the valid flow', async () => {
    const flow = await begin(b);
    const wrong = flow.callback.replace('/auth/google/callback', '/auth/microsoft/callback');
    const r = await fetch(wrong, { redirect: 'manual' });
    expect(r.headers.get('location')).toContain('error=expired');
    expect(await status(b)).toBe('none');
    const proof = await callback(flow);
    expect((await call('/meetings/connect/confirm', b, proof)).status).toBe(200);
  });
  it('rejects expired receipts and preserves the previous active connection', async () => {
    const proof = await callback(await begin(a));
    await pool.query('UPDATE meeting_confirmations SET expires_at = now() - interval \'1 second\' WHERE user_id = $1', [a.id]);
    expect((await call('/meetings/connect/confirm', a, proof)).json.error.code).toBe('meeting_confirmation_invalid');
    expect(await status(a)).toBe('active');
  });
  it('redeems a receipt exactly once even for simultaneous confirmation', async () => {
    const proof = await callback(await begin(a, 'zoom', 'ios'));
    const results = await Promise.all([call('/meetings/connect/confirm', a, proof), call('/meetings/connect/confirm', a, proof)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await status(a, 'zoom')).toBe('active');
  });
});

describe('durable provider idempotency', () => {
  it('rejects different payload for the same key and concurrent creates share one operation', async () => {
    const m = input(); const before = await stats();
    const [x, y] = await Promise.all([call('/meetings', a, m), call('/meetings', a, m)]);
    expect(x.status).toBe(200); expect(y.status).toBe(200); expect(x.json.id).toBe(y.json.id);
    expect((await stats()).google - before.google).toBe(1);
    expect((await call('/meetings', a, { ...m, title: 'Different intent' })).json.error.code).toBe('idempotency_mismatch');
    expect((await call('/meetings', a, { ...m, share: true })).json.error.code).toBe('idempotency_mismatch');
    expect((await call(`/meetings/${x.json.id}`, b)).status).toBe(404);
  });
  it('recovers Google after create succeeded but response was lost, using the stable event id', async () => {
    const m = input(); const before = await stats();
    await control({ dropAfterCreate: 'google' });
    const lost = await call('/meetings', a, m);
    expect(lost.status).toBe(409); expect(lost.json.error.code).toBe('meeting_uncertain');
    const id = lost.json.error.details.meetingId;
    expect((await call(`/meetings/${id}`, a)).json.status).toBe('created');
    expect((await call('/meetings', a, m)).json.id).toBe(id);
    expect((await stats()).google - before.google).toBe(1);
  });
  it('retains pending Google conference and resumes by reading the existing event', async () => {
    const m = input(); const before = await stats();
    await control({ googlePending: true });
    const pending = await call('/meetings', a, m);
    expect(pending.json.error.code).toBe('meeting_pending');
    const id = pending.json.error.details.meetingId;
    expect((await call(`/meetings/${id}`, a)).json).toMatchObject({ status: 'creating', joinUrl: null });
    expect((await call('/meetings', a, m)).json.error.code).toBe('meeting_pending');
    await control({ googlePending: false });
    expect((await call(`/meetings/${id}`, a)).json.status).toBe('created');
    expect((await stats()).google - before.google).toBe(1);
  });
  it('reports a failed Meet conference without creating another calendar event', async () => {
    const m = input(); const before = await stats();
    await control({ googleFailed: true });
    const failed = await call('/meetings', a, m);
    expect(failed.status).toBe(409); expect(failed.json.error.code).toBe('no_meet');
    const id = failed.json.error.details.meetingId;
    expect(id).toBeTruthy();
    expect((await call(`/meetings/${id}`, a)).json).toMatchObject({ status: 'failed', joinUrl: null });
    expect((await call('/meetings', a, m)).json.error.code).toBe('no_meet');
    expect((await stats()).google - before.google).toBe(1);
    await control({ googleFailed: false });
  });
  it('never repeats an uncertain Zoom POST on retry, GET, or simulated process restart', async () => {
    const m = input('zoom'); const before = await stats();
    await control({ dropAfterCreate: 'zoom' });
    const lost = await call('/meetings', a, m);
    expect(lost.json.error.code).toBe('meeting_uncertain');
    const id = lost.json.error.details.meetingId;
    expect((await call('/meetings', a, m)).json.error.code).toBe('meeting_uncertain');
    await pool.query("UPDATE meetings SET operation_state = 'inflight' WHERE id = $1", [id]);
    expect((await call(`/meetings/${id}`, a)).json).toMatchObject({ status: 'creating', joinUrl: null });
    expect((await call('/meetings', a, m)).json.error.code).toBe('meeting_uncertain');
    expect((await stats()).zoom - before.zoom).toBe(1);
  });
  it('does not retry a pending event against a newly connected Google account', async () => {
    const m = input(); const before = await stats();
    await control({ googlePending: true });
    const pending = await call('/meetings', a, m);
    expect(pending.json.error.code).toBe('meeting_pending');
    await connect(a, 'google');
    await control({ googlePending: false });
    expect((await call('/meetings', a, m)).json.error.code).toBe('meeting_uncertain');
    expect((await stats()).google - before.google).toBe(1);
  });
});
