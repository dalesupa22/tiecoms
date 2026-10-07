/**
 * Pedidos de Lorena (7-oct-2026, tarde): eliminar una tarea y la «@» que se quedaba marcada aunque ya se leyó la mención.
 * Necesita el API (API_URL).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), 'x-forwarded-for': ip() },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/auth/signup', { body: {
    name, ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }), email: `${name.toLowerCase()}.l1007.${run}@example.com`,
    password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}

describe('pedidos de Lorena 7-oct (tarde)', () => {
  let danny: Awaited<ReturnType<typeof signup>>, lorena: typeof danny, otro: typeof danny, chatId: string;
  beforeAll(async () => {
    danny = await signup('Danny');
    const inv = async () => (await call(`/organizations/${danny.orgId}/invitations`, { token: danny.token, body: {} })).json.token;
    lorena = await signup('Lorena', await inv());
    otro = await signup('Otro', await inv());
    chatId = (await call('/chats', { token: danny.token, body: { userIds: [lorena.id, otro.id], name: 'Equipo' } })).json.id;
  });

  it('quien creó la tarea la elimina con sus subtareas; otra persona del chat no puede', async () => {
    const t = (await call(`/conversations/${chatId}/issues`, { token: lorena.token, body: { title: 'Tarea a borrar', assigneeIds: [danny.id] } })).json;
    const kid = (await call(`/issues/${t.id}/children`, { token: lorena.token, body: { title: 'Subtarea' } })).json;
    expect(kid.id).toBeTruthy();
    expect((await call('/issues/inbox', { token: danny.token })).json.items.some((x: any) => x.issueId === t.id)).toBe(true);
    expect((await call(`/issues/${t.id}`, { method: 'DELETE', token: otro.token })).status).toBe(403);
    const del = await call(`/issues/${t.id}`, { method: 'DELETE', token: lorena.token });
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    expect(del.json.deleted.sort()).toEqual([t.id, kid.id].sort());
    expect((await call(`/issues/${t.id}`, { token: lorena.token })).status).toBe(404);
    expect((await call(`/issues/${kid.id}`, { token: lorena.token })).status).toBe(404);
    expect((await call('/issues/inbox', { token: danny.token })).json.items.some((x: any) => x.issueId === t.id)).toBe(false);
  });

  it('leer hasta la mención quita la «@» aunque haya mensajes después', async () => {
    const send = (body: string, mentions?: unknown) => call(`/conversations/${chatId}/messages`, { token: danny.token, body: { clientMessageId: randomUUID(), body, ...(mentions ? { mentions } : {}) } });
    const m = (await send('@Lorena revisa esto', [{ userId: lorena.id, start: 0, length: 7 }])).json;
    const seq = m.message?.seq ?? m.seq;
    await send('otro mensaje sin mención');
    const boot = (await call('/bootstrap', { token: lorena.token })).json;
    expect(boot.conversations.find((c: any) => c.id === chatId).unreadMentions).toBe(1);
    const r = await call(`/conversations/${chatId}/read`, { token: lorena.token, body: { seq } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.unreadMentions).toBe(0);
    const again = (await call('/bootstrap', { token: lorena.token })).json;
    expect(again.conversations.find((c: any) => c.id === chatId)).toMatchObject({ unreadMentions: 0, unread: 1 });
  });
});
