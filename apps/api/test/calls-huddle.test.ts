/**
 * Llamadas como huddles de Slack (pedido de Danny, 29-sep-2026): en un chat con gente de otra empresa, la llamada
 * solo la ve la empresa de quien la empezó. A la otra empresa no le suena, no la ve en curso ni en el historial,
 * no recibe el evento de la conversación ni los mensajes de sistema, salvo que la agreguen con «＋ Agregar».
 * API con CALLS_ENABLED=true y CALLS_PROVIDER=fake.
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const post = (path: string, token: string, body: unknown = {}) => call(path, { token, body });
const get = (path: string, token: string) => call(path, { token });
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.huddle.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
function listen(token: string) {
  const account: any[] = [], conv: any[] = [];
  const s: Socket = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token } });
  s.on('account.event', (e) => account.push(e));
  s.on('conv.event', (e) => conv.push(e));
  const ready = new Promise<void>((res, rej) => { s.once('ready', () => res()); s.once('connect_error', rej); });
  return { s, account, conv, ready };
}
async function waitFor<T>(fn: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 40; i++) { const v = fn(); if (v) return v; await sleep(150); }
  throw new Error(`no llegó ${what}`);
}

describe('llamadas como huddle de la empresa', () => {
  let ana: Actor, beto: Actor, cata: Actor, chatId: string, callId: string;
  let b: ReturnType<typeof listen>, c: ReturnType<typeof listen>;
  beforeAll(async () => {
    ana = await signup('Ana');
    beto = await signup('Beto', (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token);
    cata = await signup('Cata'); // otra empresa, comparte un espacio con Ana
    const ws = await post('/workspaces', ana.token, { name: `Proyecto ${run}` });
    const wi = await post(`/workspaces/${ws.json.id}/invitations`, ana.token, { role: 'member', conversationIds: [] });
    expect((await post(`/invitations/${wi.json.token}/accept`, cata.token)).status).toBe(200);
    const chat = await post('/chats', ana.token, { userIds: [beto.id, cata.id], name: 'Compartido' });
    expect(chat.status).toBe(200);
    chatId = chat.json.id;
    b = listen(beto.token); c = listen(cata.token);
    await Promise.all([b.ready, c.ready]);
    await sleep(300);
  });
  afterAll(() => { b?.s.disconnect(); c?.s.disconnect(); });

  it('le suena a la misma empresa y no a la otra', async () => {
    const r = await post(`/conversations/${chatId}/call`, ana.token, { kind: 'audio' });
    expect(r.status).toBe(200);
    callId = r.json.call.id;
    await waitFor(() => b.account.find((e) => e.type === 'call.ringing' && e.call.id === callId), 'el timbre a Beto');
    await sleep(800);
    expect(c.account.some((e) => e.type === 'call.ringing')).toBe(false);
    // En un chat con otra empresa no va por la conversación (la verían todos): va a Beto por su cuenta.
    expect(c.conv.some((e) => e.type === 'call.updated')).toBe(false);
    expect(c.account.some((e) => e.type === 'call.updated')).toBe(false);
    expect(b.account.some((e) => e.type === 'call.updated' && e.call.id === callId)).toBe(true);
  });

  it('la otra empresa no la ve en curso, no la abre y no entra por el mismo chat', async () => {
    expect((await get('/calls/active', beto.token)).json.calls.map((x: any) => x.call.id)).toContain(callId);
    expect((await get('/calls/active', cata.token)).json.calls.map((x: any) => x.call.id)).not.toContain(callId);
    expect((await get(`/conversations/${chatId}/call`, beto.token)).json.call?.id).toBe(callId);
    expect((await get(`/conversations/${chatId}/call`, cata.token)).json.call).toBeNull();
    expect((await post(`/calls/${callId}/join`, cata.token)).status).toBe(404);
    const busy = await post(`/conversations/${chatId}/call`, cata.token, { kind: 'audio' });
    expect(busy.status).toBe(409);
    expect(busy.json.error?.code ?? busy.json.code).toBe('call_busy');
  });

  it('no deja mensajes de sistema en el chat compartido', async () => {
    const msgs = await get(`/conversations/${chatId}/messages?limit=50`, cata.token);
    const bodies = JSON.stringify(msgs.json);
    expect(bodies).not.toContain('call.started');
  });

  it('si la agregan con «＋ Agregar», la ve y puede entrar', async () => {
    expect((await post(`/calls/${callId}/invite`, ana.token, { userIds: [cata.id] })).status).toBe(200);
    await waitFor(() => c.account.find((e) => e.type === 'call.ringing' && e.call.id === callId), 'el timbre a Cata');
    expect((await get('/calls/active', cata.token)).json.calls.map((x: any) => x.call.id)).toContain(callId);
    expect((await post(`/calls/${callId}/join`, cata.token)).status).toBe(200);
  });

  it('al colgar, el historial de Beto la tiene; el de alguien de otra empresa que no entró, no', async () => {
    const dani = await signup('Dani');
    const ws2 = await post('/workspaces', ana.token, { name: `Otro ${run}` });
    const wi2 = await post(`/workspaces/${ws2.json.id}/invitations`, ana.token, { role: 'member', conversationIds: [] });
    await post(`/invitations/${wi2.json.token}/accept`, dani.token);
    const chat2 = (await post('/chats', ana.token, { userIds: [beto.id, dani.id], name: 'Compartido 2' })).json.id;
    const r = await post(`/conversations/${chat2}/call`, ana.token, { kind: 'audio' });
    const id2 = r.json.call.id;
    await post(`/calls/${id2}/end`, ana.token);
    await sleep(300);
    const hist = async (t: string) => (await get('/calls?limit=30', t)).json.calls.map((x: any) => x.call.id);
    expect(await hist(beto.token)).toContain(id2);
    expect(await hist(dani.token)).not.toContain(id2);
    expect((await get(`/calls/${id2}/transcript`, dani.token)).status).toBe(404);
  });

  it('en un directo con alguien de otra empresa sí le suena', async () => {
    const dm = (await post('/chats', ana.token, { userIds: [cata.id] })).json;
    expect(dm.kind).toBe('direct');
    const before = c.account.length;
    const r = await post(`/conversations/${dm.id}/call`, ana.token, { kind: 'audio' });
    expect(r.status).toBe(200);
    await waitFor(() => c.account.slice(before).find((e) => e.type === 'call.ringing' && e.call.id === r.json.call.id), 'el timbre del directo');
  });
});
