/**
 * CH029 (2-nov-2026): «Llamando…» → «Sonando…». El teléfono que suena lo confirma (POST /calls/:id/ringing) y quien
 * llama lo ve en CallDTO.ringingUserIds; deja de verlo si rechaza, entra o la llamada termina. Token VoIP aparte del
 * de avisos. Base tomada de calls-missed:
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
    name, email: `${name.toLowerCase()}.sonando.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
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

describe('sonando (CH029)', () => {
  let ana: Actor, beto: Actor, chatId: string, a: ReturnType<typeof listen>, b: ReturnType<typeof listen>;
  beforeAll(async () => {
    ana = await signup('Ana');
    beto = await signup('Beto', (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token);
    chatId = (await post('/chats', ana.token, { userIds: [beto.id] })).json.id;
    a = listen(ana.token); b = listen(beto.token);
    await Promise.all([a.ready, b.ready]);
  });
  afterAll(() => { a?.s.disconnect(); b?.s.disconnect(); });
  const updates = (id: string) => [...a.account.filter((e) => e.type === 'call.updated'), ...a.conv.filter((e) => e.type === 'call.updated')]
    .map((e) => e.call).filter((c) => c?.id === id);

  it('Llamando… hasta que el otro teléfono confirma; luego Sonando…', async () => {
    const start = await post(`/conversations/${chatId}/call`, ana.token, { kind: 'audio' });
    const id = start.json.call.id;
    expect(start.json.call.ringingUserIds).toBeUndefined();
    await waitFor(() => b.account.find((e) => e.type === 'call.ringing' && e.call.id === id), 'el timbre');
    expect((await post(`/calls/${id}/ringing`, beto.token)).status).toBe(200);
    await waitFor(() => updates(id).find((c) => c.ringingUserIds?.includes(beto.id)), 'Sonando…');
    // Confirmar dos veces no vuelve a publicar.
    const n = updates(id).length;
    await post(`/calls/${id}/ringing`, beto.token);
    await sleep(500);
    expect(updates(id).length).toBe(n);
    // Al contestar deja de contar como «sonando».
    await post(`/calls/${id}/join`, beto.token, {});
    const joined = await waitFor(() => updates(id).find((c) => c.activeUserIds.includes(beto.id)), 'entró');
    expect(joined.ringingUserIds).toBeUndefined();
    await post(`/calls/${id}/end`, ana.token);
  });

  it('si rechaza, quien llama deja de ver Sonando…', async () => {
    const id = (await post(`/conversations/${chatId}/call`, ana.token, { kind: 'audio' })).json.call.id;
    await waitFor(() => b.account.find((e) => e.type === 'call.ringing' && e.call.id === id), 'el timbre');
    await post(`/calls/${id}/ringing`, beto.token);
    await waitFor(() => updates(id).find((c) => c.ringingUserIds?.includes(beto.id)), 'Sonando…');
    await post(`/calls/${id}/decline`, beto.token);
    await waitFor(() => updates(id).slice(-1).find((c) => !c.ringingUserIds), 'ya no suena');
    await post(`/calls/${id}/end`, ana.token);
  });

  it('solo confirma quien puede ver la llamada; terminada no hace nada', async () => {
    const extra = await signup('Ciro');
    const id = (await post(`/conversations/${chatId}/call`, ana.token, { kind: 'audio' })).json.call.id;
    expect((await post(`/calls/${id}/ringing`, extra.token)).status).toBeGreaterThanOrEqual(403);
    await post(`/calls/${id}/end`, ana.token);
    expect((await post(`/calls/${id}/ringing`, beto.token)).status).toBe(200);
  });

  it('el token VoIP no reemplaza el de avisos (ni al revés)', async () => {
    expect((await put('/push/token', beto.token, { provider: 'apns', token: `alerta-${run}-0123456789` })).status).toBe(200);
    expect((await put('/push/token', beto.token, { provider: 'apns_voip', token: `voip-${run}-0123456789` })).status).toBe(200);
    expect((await put('/push/token', beto.token, { provider: 'apns_voip', token: `voip2-${run}-0123456789` })).status).toBe(200);
    expect((await put('/push/token', beto.token, { provider: 'apns', token: `alerta2-${run}-0123456789` })).status).toBe(200);
    const pg = await import('pg');
    const db = new pg.default.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:pg@127.0.0.1:15529/tiecoms' });
    await db.connect();
    const { rows } = await db.query('SELECT provider, token FROM push_subscriptions WHERE token LIKE $1 ORDER BY provider', [`%-${run}-%`]);
    await db.end();
    expect(rows).toEqual([{ provider: 'apns', token: `alerta2-${run}-0123456789` }, { provider: 'apns_voip', token: `voip2-${run}-0123456789` }]);
  });
});
