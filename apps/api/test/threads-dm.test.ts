/**
 * Hilos desde directos y chats grupales (sin espacio): el hilo es con las mismas personas y cuelga del mensaje.
 * Necesita el API (API_URL) corriendo.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/auth/signup', { body: {
    name, ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }), email: `${name.toLowerCase()}.hilos.${run}@example.com`,
    password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}
const send = async (token: string, conv: string, body: string) =>
  (await call(`/conversations/${conv}/messages`, { token, body: { clientMessageId: randomUUID(), body } })).json.message;

describe('hilos fuera de un espacio', () => {
  let ana: Awaited<ReturnType<typeof signup>>, beto: typeof ana, caro: typeof ana;
  beforeAll(async () => {
    ana = await signup('Ana');
    const inv = await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} });
    beto = await signup('Beto', inv.json.token);
    const inv2 = await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} });
    caro = await signup('Caro', inv2.json.token);
  });

  it('abre un hilo desde un directo, con las mismas dos personas', async () => {
    const dm = (await call('/chats', { token: ana.token, body: { userIds: [beto.id] } })).json;
    const m = await send(ana.token, dm.id, '¿Revisamos la propuesta de Uniandes?');
    const r = await call(`/conversations/${dm.id}/derive`, { token: ana.token, body: { messageId: m.id, kind: 'same', name: 'Hilo · Uniandes' } });
    expect(r.status).toBe(200);
    const b = (await call('/bootstrap', { token: beto.token })).json;
    const th = b.conversations.find((c: any) => c.id === r.json.id);
    expect(th).toMatchObject({ kind: 'multi', parentId: dm.id, parentMessageId: m.id, deriveKind: 'same' });
    expect([...th.memberIds].sort()).toEqual([ana.id, beto.id].sort());
    // Beto responde en el hilo.
    expect((await call(`/conversations/${r.json.id}/messages`, { token: beto.token, body: { clientMessageId: randomUUID(), body: 'Sí, la miro hoy' } })).status).toBeLessThan(300);
  });

  it('en un chat grupal suma a todos; solo hay hilo «same» y no se deriva un hilo', async () => {
    const chat = (await call('/chats', { token: ana.token, body: { userIds: [beto.id, caro.id], name: `Equipo ${run}` } })).json;
    const chatId = chat.id ?? chat.conversation?.id;
    const m = await send(ana.token, chatId, 'Plan para el lunes');
    expect((await call(`/conversations/${chatId}/derive`, { token: ana.token, body: { messageId: m.id, kind: 'internal' } })).status).toBe(400);
    const r = await call(`/conversations/${chatId}/derive`, { token: ana.token, body: { messageId: m.id, kind: 'same' } });
    expect(r.status).toBe(200);
    const b = (await call('/bootstrap', { token: caro.token })).json;
    expect(b.conversations.find((c: any) => c.id === r.json.id)?.memberIds).toHaveLength(3);
    const inThread = await send(ana.token, r.json.id, 'Arranco yo');
    expect((await call(`/conversations/${r.json.id}/derive`, { token: ana.token, body: { messageId: inThread.id, kind: 'same' } })).status).toBe(400);
  });
});
