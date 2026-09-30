/**
 * Invitados por enlace (proveedor falso: CALLS_ENABLED=true CALLS_PROVIDER=fake).
 * Quien está en la llamada crea el enlace; un tercero sin cuenta ve la llamada, entra con su nombre, late y sale.
 * El enlace no sirve a quien no está dentro, ni quitado, ni con la llamada terminada; los invitados no la sostienen.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'x-forwarded-for': ip(), ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const post = (path: string, token: string, body: unknown = {}) => call(path, { token, body });
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const r = await call('/auth/signup', { body: {
    name, email: `${name.toLowerCase()}.invitado.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken, id: r.json.user.id, orgId: r.json.user.primaryOrgId };
}

describe('invitados por enlace', () => {
  let ana: Actor, beto: Actor, chatId: string, callId: string, token: string;
  beforeAll(async () => {
    ana = await signup('Ana');
    beto = await signup('Beto', (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token);
    chatId = (await post('/chats', ana.token, { userIds: [beto.id], name: 'Con clientes' })).json.id;
  });

  it('solo quien está dentro crea el enlace', async () => {
    const start = await post(`/conversations/${chatId}/call`, ana.token, { kind: 'video' });
    expect(start.status).toBe(200);
    callId = start.json.call.id;
    expect((await post(`/calls/${callId}/link`, beto.token)).json.error.code).toBe('not_in_call');
    const link = await post(`/calls/${callId}/link`, ana.token);
    expect(link.status).toBe(200);
    expect(link.json.url).toMatch(/\/llamada\/[A-Za-z0-9_-]{16,}$/);
    token = link.json.token;
  });

  it('el tercero ve la llamada, entra con su nombre y todos lo ven', async () => {
    const pv = await call(`/call-links/${token}`);
    expect(pv.status).toBe(200);
    expect(pv.json).toMatchObject({ title: 'Con clientes', hostName: 'Ana', kind: 'video', active: true });
    expect(pv.json.conversationId).toBeUndefined();
    expect((await call('/call-links/no-existe-este-token-123')).status).toBe(404);

    const j = await call(`/call-links/${token}/join`, { body: { name: '  Laura (cliente)  ' } });
    expect(j.status).toBe(200);
    expect(j.json.attendee.Attendee.ExternalUserId).toBe(`guest:${j.json.guestId}`);
    expect(j.json.call.guests).toEqual([{ id: j.json.guestId, name: 'Laura (cliente)' }]);
    expect(j.json.call.names[ana.id]).toBe('Ana');

    const active = await call(`/conversations/${chatId}/call`, { token: ana.token });
    expect(active.json.call.guests).toEqual([{ id: j.json.guestId, name: 'Laura (cliente)' }]);

    const hb = await call(`/call-guests/${j.json.guestId}/heartbeat`, { body: { secret: j.json.secret } });
    expect(hb.status).toBe(200);
    expect(hb.json.activeUserIds).toEqual([ana.id]);
    expect((await call(`/call-guests/${j.json.guestId}/heartbeat`, { body: { secret: 'x'.repeat(32) } })).status).toBe(404);

    expect((await call(`/call-guests/${j.json.guestId}/leave`, { body: { secret: j.json.secret } })).status).toBe(200);
    expect((await call(`/conversations/${chatId}/call`, { token: ana.token })).json.call.guests).toBeUndefined();
  });

  it('un enlace quitado ya no deja entrar', async () => {
    expect((await call(`/calls/${callId}/link`, { method: 'DELETE', token: ana.token })).status).toBe(200);
    const j = await call(`/call-links/${token}/join`, { body: { name: 'Otro' } });
    expect(j.json.error.code).toBe('link_revoked');
    expect((await call(`/call-links/${token}`)).json.active).toBe(false);
  });

  it('los invitados no sostienen la llamada: si sale el último de chaggu, termina y el enlace muere', async () => {
    const t2 = (await post(`/calls/${callId}/link`, ana.token)).json.token;
    const g = (await call(`/call-links/${t2}/join`, { body: { name: 'Pedro' } })).json;
    expect(g.guestId).toBeTruthy();
    await post(`/calls/${callId}/leave`, ana.token);
    const hb = await call(`/call-guests/${g.guestId}/heartbeat`, { body: { secret: g.secret } });
    expect(hb.json.error.code).toBe('not_in_call');
    expect((await call(`/call-links/${t2}/join`, { body: { name: 'Tarde' } })).json.error.code).toBe('link_revoked');
  });
});
