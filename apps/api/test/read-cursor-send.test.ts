import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { pool } from '../src/db.ts';

const API = process.env.API_URL ?? 'http://127.0.0.1:3088';
type User = { token: string; id: string; orgId: string };
let a: User, b: User;
async function call(path: string, user?: User, body?: unknown) {
  const r = await fetch(`${API}/api/v1${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-tiecoms-contract': '2026-09-28', ...(user ? { authorization: `Bearer ${user.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json(); expect([200, 201], JSON.stringify(j.error)).toContain(r.status); return j;
}
async function signup(orgInviteToken?: string): Promise<User> {
  const j = await call('/auth/signup', undefined, { name: 'Read QA', email: `${randomUUID()}@example.com`, password: 'local-read-cursor-test', ...(orgInviteToken ? { orgInviteToken } : { orgName: 'Read QA' }), device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' } });
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const group = async () => (await call('/groups', a, { name: `Unread ${randomUUID()}`, target: { kind: 'org' }, memberIds: [b.id] })).conversationId as string;
const send = async (u: User, id: string, body = 'Local test') => (await call(`/conversations/${id}/messages`, u, { clientMessageId: randomUUID(), body })).message;
const meta = async (u: User, id: string) => (await call('/bootstrap', u)).conversations.find((c: any) => c.id === id);
beforeAll(async () => {
  const db = new URL(process.env.DATABASE_URL!);
  if (!['localhost', '127.0.0.1'].includes(db.hostname) || !db.pathname.startsWith('/chaggu_meetings_review_')) throw new Error('Dedicated local review database required');
  if (!['localhost', '127.0.0.1'].includes(new URL(API).hostname)) throw new Error('Local API required');
  a = await signup(); b = await signup((await call(`/organizations/${a.orgId}/invitations`, a, {})).token);
});
afterAll(() => pool.end());

it('sending while behind does not acknowledge unread messages or mentions', async () => {
  const id = await group(); const known = await meta(a, id);
  await call(`/conversations/${id}/read`, a, { seq: known.lastMessageSeq });
  const before = (await meta(a, id)).lastReadSeq;
  await call(`/conversations/${id}/messages`, b, { clientMessageId: randomUUID(), body: '@Read QA pendiente', mentions: [{ userId: a.id, start: 0, length: 8 }] });
  await send(b, id, 'Another unseen message');
  await send(a, id, 'Reply from newest without reading history');
  const after = await meta(a, id);
  expect(after.lastReadSeq).toBe(before);
  expect(after.unread).toBeGreaterThan(0);
  expect(after.unreadMentions).toBe(1);
});

it('an authored system message also preserves the unread cursor', async () => {
  const id = await group();
  await call(`/conversations/${id}/read`, a, { seq: (await meta(a, id)).lastMessageSeq });
  const before = (await meta(a, id)).lastReadSeq;
  await send(b, id, 'Unread before issue creation');
  await call(`/conversations/${id}/issues`, a, { title: 'Local task that creates a system message' });
  expect((await meta(a, id)).lastReadSeq).toBe(before);
});

it('sending when caught up advances through the author’s own message', async () => {
  const id = await group(); await send(b, id);
  await call(`/conversations/${id}/read`, a, { seq: (await meta(a, id)).lastMessageSeq });
  const own = await send(a, id);
  const after = await meta(a, id);
  expect(after.lastReadSeq).toBe(own.seq); expect(after.unread).toBe(0);
});

it('new-history membership boundary counts as caught up even without a cursor', async () => {
  const id = await group(); await send(b, id); await send(b, id);
  const boundary = (await meta(a, id)).lastMessageSeq;
  await pool.query('DELETE FROM read_cursors WHERE conversation_id = $1 AND user_id = $2', [id, a.id]);
  await pool.query('UPDATE conversation_memberships SET history_from_seq = $3 WHERE conversation_id = $1 AND user_id = $2', [id, a.id, boundary]);
  const own = await send(a, id);
  expect((await meta(a, id)).lastReadSeq).toBe(own.seq);
  expect((await meta(a, id)).unread).toBe(0);
});
