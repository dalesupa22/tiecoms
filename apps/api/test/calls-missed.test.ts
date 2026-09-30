/**
 * Llamadas perdidas (29-sep-2026): me sonó, no la rechacé y no entré. Número rojo en Llamadas (bootstrap.missedCalls
 * y el evento calls.missed), «Perdida» en el historial, y POST /calls/seen lo quita. Con No molestar no suena pero
 * queda como perdida. Antes:
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
    name, email: `${name.toLowerCase()}.perdida.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
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

const put = (path: string, token: string, body: unknown) => call(path, { token, method: 'PUT', body });

describe('llamadas perdidas', () => {
  let ana: Actor, beto: Actor, chatId: string, b: ReturnType<typeof listen>;
  const missed = async () => (await get('/bootstrap', beto.token)).json.missedCalls;
  beforeAll(async () => {
    ana = await signup('Ana');
    beto = await signup('Beto', (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token);
    chatId = (await post('/chats', ana.token, { userIds: [beto.id] })).json.id;
    b = listen(beto.token);
    await b.ready;
  });
  afterAll(() => b?.s.disconnect());

  it('si no contesto, queda perdida: número rojo, evento y «Perdida» en el historial', async () => {
    expect(await missed()).toBe(0);
    const id = (await post(`/conversations/${chatId}/call`, ana.token, { kind: 'audio' })).json.call.id;
    await waitFor(() => b.account.find((e) => e.type === 'call.ringing' && e.call.id === id), 'el timbre');
    await post(`/calls/${id}/end`, ana.token);
    const ev = await waitFor(() => b.account.find((e) => e.type === 'calls.missed' && e.callId === id), 'calls.missed');
    expect(ev.missedCalls).toBe(1);
    expect(await missed()).toBe(1);
    const h = (await get('/calls?limit=5', beto.token)).json.calls.find((x: any) => x.call.id === id);
    expect(h.missed).toBe(true);
    // Para quien llamó no es perdida.
    expect((await get('/calls?limit=5', ana.token)).json.calls.find((x: any) => x.call.id === id).missed).toBeUndefined();
  });

  it('abrir Llamadas la quita (en todos mis dispositivos)', async () => {
    expect((await post('/calls/seen', beto.token)).json.missedCalls).toBe(0);
    await waitFor(() => b.account.find((e) => e.type === 'calls.missed' && e.callId === null && e.missedCalls === 0), 'calls.missed 0');
    expect(await missed()).toBe(0);
  });

  it('rechazada o contestada no cuenta', async () => {
    const r1 = (await post(`/conversations/${chatId}/call`, ana.token, { kind: 'audio' })).json.call.id;
    await post(`/calls/${r1}/decline`, beto.token);
    await post(`/calls/${r1}/end`, ana.token);
    const r2 = (await post(`/conversations/${chatId}/call`, ana.token, { kind: 'audio' })).json.call.id;
    expect((await post(`/calls/${r2}/join`, beto.token)).status).toBe(200);
    await post(`/calls/${r2}/end`, ana.token);
    await sleep(500);
    expect(await missed()).toBe(0);
  });

  it('con No molestar no suena, pero queda perdida', async () => {
    expect((await put('/me/dnd', beto.token, { until: new Date(Date.now() + 3600_000).toISOString() })).status).toBe(200);
    const before = b.account.length;
    const id = (await post(`/conversations/${chatId}/call`, ana.token, { kind: 'audio' })).json.call.id;
    await sleep(800);
    expect(b.account.slice(before).some((e) => e.type === 'call.ringing')).toBe(false);
    await post(`/calls/${id}/end`, ana.token);
    await waitFor(() => b.account.find((e) => e.type === 'calls.missed' && e.callId === id), 'calls.missed con DND');
    expect(await missed()).toBe(1);
    await put('/me/dnd', beto.token, { until: null });
  });
});
