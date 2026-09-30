/**
 * Un chat sin nombre con las mismas personas es el mismo chat (Danny, 30-sep-2026: «Josué, Harold» salía repetido).
 * Con nombre, o con otras personas, es uno nuevo.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function call(path: string, body?: unknown, token?: string) {
  const res = await fetch(`${API}/api/v1${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-forwarded-for': ip(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
}
const device = () => ({ deviceId: randomUUID(), name: 'vitest', platform: 'web' });

describe('chats con las mismas personas', () => {
  it('se retoma el mismo chat, en cualquier orden y desde cualquiera de los tres', async () => {
    const ana = (await call('/auth/signup', { name: 'Ana', email: `ana.mismo.${run}@example.com`, password: 'clave-segura-123', orgName: `Mismo ${run}`, device: device() })).json;
    const inv = async () => (await call(`/organizations/${ana.user.primaryOrgId}/invitations`, {}, ana.accessToken)).json.token;
    const josue = (await call('/auth/signup', { name: 'Josué', email: `josue.mismo.${run}@example.com`, password: 'clave-segura-123', orgInviteToken: await inv(), device: device() })).json;
    const harold = (await call('/auth/signup', { name: 'Harold', email: `harold.mismo.${run}@example.com`, password: 'clave-segura-123', orgInviteToken: await inv(), device: device() })).json;
    const first = await call('/chats', { userIds: [josue.user.id, harold.user.id] }, ana.accessToken);
    expect(first.json.kind).toBe('multi');
    const again = await call('/chats', { userIds: [harold.user.id, josue.user.id] }, ana.accessToken);
    expect(again.json.id).toBe(first.json.id);
    const fromJosue = await call('/chats', { userIds: [ana.user.id, harold.user.id] }, josue.accessToken);
    expect(fromJosue.json.id).toBe(first.json.id);
    // Con nombre es un grupo nuevo; con otra gente, otro chat.
    const named = await call('/chats', { userIds: [josue.user.id, harold.user.id], name: 'Proyecto' }, ana.accessToken);
    expect(named.json.id).not.toBe(first.json.id);
    const pair = await call('/chats', { userIds: [josue.user.id] }, ana.accessToken);
    expect(pair.json.kind).toBe('direct');
  });
});
