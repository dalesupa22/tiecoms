import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const FAKE_PUSH = process.env.FAKE_PUSH_URL ?? 'http://localhost:59045';
const FOREVER = '9999-12-31T00:00:00Z';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.sched.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'ios' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const send = (a: Actor, conv: string, body: string, mentions?: unknown[]) =>
  call(`/conversations/${conv}/messages`, { token: a.token, body: { clientMessageId: randomUUID(), body, ...(mentions ? { mentions } : {}) } });

/**
 * Mensajes programados: crear, listar, editar, cancelar, «enviar ahora», envío automático del worker
 * (ciclo de 15 s) sin duplicar, y «fallido» si al llegar la hora ya no puede escribir.
 * Necesita el API y su worker (API_URL).
 *   API_URL=http://localhost:3071 npx vitest run test/scheduled.test.ts
 */
const inSec = (n: number) => new Date(Date.now() + n * 1000).toISOString();
const msgs = async (a: Actor, conv: string) => (await call(`/conversations/${conv}/messages?limit=50`, { token: a.token })).json.messages as any[];

let ana: Actor, beto: Actor, chatId: string, groupId: string;
beforeAll(async () => {
  ana = await signup('Ana');
  beto = await signup('Beto', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  chatId = (await call('/chats', { token: ana.token, body: { userIds: [beto.id] } })).json.id;
  groupId = (await call('/chats', { token: ana.token, body: { userIds: [beto.id], name: `Programados ${run}` } })).json.id;
});

describe('mensajes programados', () => {
  it('valida la hora y la conversación', async () => {
    expect((await call(`/conversations/${chatId}/scheduled`, { token: ana.token, body: { body: 'tarde', sendAt: inSec(-60) } })).status).toBe(400);
    expect((await call(`/conversations/${chatId}/scheduled`, { token: ana.token, body: { body: 'lejos', sendAt: new Date(Date.now() + 400 * 86_400_000).toISOString() } })).status).toBe(400);
    expect((await call(`/conversations/${randomUUID()}/scheduled`, { token: ana.token, body: { body: 'x', sendAt: inSec(3600) } })).status).toBeGreaterThanOrEqual(403);
  });

  it('crear, editar, cancelar y enviar ahora; solo lo ve quien lo escribió', async () => {
    const a = await call(`/conversations/${chatId}/scheduled`, { token: ana.token, body: { body: 'borrador', sendAt: inSec(3600) } });
    expect(a.status).toBe(200);
    expect(a.json.status).toBe('pending');
    const e = await call(`/scheduled/${a.json.id}`, { token: ana.token, method: 'PATCH', body: { body: 'editado', sendAt: inSec(7200) } });
    expect(e.json.body).toBe('editado');
    expect((await call(`/scheduled/${a.json.id}`, { token: beto.token, method: 'PATCH', body: { body: 'ajeno' } })).status).toBe(404);
    expect((await call('/scheduled', { token: beto.token })).json.scheduled.some((s: any) => s.id === a.json.id)).toBe(false);
    expect((await call(`/scheduled?conversationId=${chatId}`, { token: ana.token })).json.scheduled.map((s: any) => s.id)).toContain(a.json.id);

    const c = await call(`/scheduled/${a.json.id}`, { token: ana.token, method: 'DELETE' });
    expect(c.json.status).toBe('cancelled');
    expect((await call(`/scheduled/${a.json.id}/send`, { token: ana.token, body: {} })).status).toBe(409);

    const b = await call(`/conversations/${chatId}/scheduled`, { token: ana.token, body: { body: `ya ${run}`, sendAt: inSec(3600) } });
    const now = await call(`/scheduled/${b.json.id}/send`, { token: ana.token, body: {} });
    expect(now.json.status).toBe('sent');
    const list = await msgs(beto, chatId);
    expect(list.filter((m) => m.body === `ya ${run}`)).toHaveLength(1);
    expect((await call(`/scheduled/${b.json.id}/send`, { token: ana.token, body: {} })).status).toBe(409);
  });

  it('el worker lo envía solo a la hora, una sola vez', async () => {
    const s = await call(`/conversations/${chatId}/scheduled`, { token: ana.token, body: { body: `auto ${run}`, sendAt: inSec(32) } });
    expect(s.status).toBe(200);
    let found: any[] = [];
    for (let i = 0; i < 30 && !found.length; i++) { await sleep(3000); found = (await msgs(beto, chatId)).filter((m) => m.body === `auto ${run}`); }
    expect(found).toHaveLength(1);
    expect(Date.parse(found[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(s.json.sendAt) - 1000);
    await sleep(16_000);
    expect((await msgs(beto, chatId)).filter((m) => m.body === `auto ${run}`)).toHaveLength(1);
    expect((await call('/scheduled', { token: ana.token })).json.scheduled.some((x: any) => x.id === s.json.id)).toBe(false);
  }, 150_000);

  it('queda «fallido» si al enviarlo ya no está en la conversación', async () => {
    const s = await call(`/conversations/${groupId}/scheduled`, { token: beto.token, body: { body: 'no llegará', sendAt: inSec(3600) } });
    expect(s.status).toBe(200);
    const rm = await call(`/conversations/${groupId}/members/${beto.id}`, { token: ana.token, method: 'DELETE' });
    expect(rm.status).toBeLessThan(300);
    const r = await call(`/scheduled/${s.json.id}/send`, { token: beto.token, body: {} });
    expect(r.json.status).toBe('failed');
    expect(r.json.error).toBeTruthy();
  });
});
