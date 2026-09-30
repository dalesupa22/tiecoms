/**
 * Llamadas desde varios dispositivos (1.7.1, docs/LLAMADAS.md › Varios dispositivos). API con CALLS_ENABLED=true y
 * CALLS_PROVIDER=fake. Un attendee por dispositivo, activeUserIds sin repetir, myDevices, call.answered y
 * call.declined a mis sesiones, «Pasar aquí» (leave {deviceKey}), /calls/active, bootstrap.myActiveCall,
 * compatibilidad con clientes 1.7.0 (sin deviceKey) y el estado de «＋ Agregar» (CallDTO.invited).
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string; email: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), 'x-forwarded-for': ip() },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const post = (path: string, token: string, body: unknown = {}) => call(path, { token, body });
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const email = `${name.toLowerCase()}.disp.${run}@example.com`;
  const r = await call('/auth/signup', { body: { name, email, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }), device: { deviceId: randomUUID(), name: 'Navegador', platform: 'web' } } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken, id: r.json.user.id, orgId: r.json.user.primaryOrgId, email };
}
/** Otra sesión de la misma persona (otro dispositivo). */
async function login(a: Actor, name: string, platform: string) {
  const r = await call('/auth/login', { body: { email: a.email, password: 'clave-segura-123', device: { deviceId: randomUUID(), name, platform } } });
  expect(r.status).toBe(200);
  return r.json.accessToken as string;
}
function listen(token: string, bag: any[]): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token } });
    s.on('account.event', (e) => bag.push(e));
    s.once('ready', () => res(s)); s.once('connect_error', rej);
  });
}
async function waitFor<T>(fn: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 60; i++) { const v = fn(); if (v) return v; await sleep(150); }
  throw new Error(`no llegó ${what}`);
}

describe('llamadas en varios dispositivos (1.7.1)', () => {
  let ana: Actor, beto: Actor, carla: Actor, anaPhone: string, chatId: string, callId: string;
  const anaWeb: any[] = [], anaIos: any[] = [], betoEvents: any[] = [];
  const sockets: Socket[] = [];
  beforeAll(async () => {
    ana = await signup('Ana');
    const inv = async () => (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token;
    beto = await signup('Beto', await inv());
    carla = await signup('Carla', await inv());
    anaPhone = await login(ana, 'iPhone de Ana', 'ios');
    chatId = (await post('/chats', ana.token, { userIds: [beto.id, carla.id], name: `Varios ${run}` })).json.id;
    sockets.push(await listen(ana.token, anaWeb), await listen(anaPhone, anaIos), await listen(beto.token, betoEvents));
  }, 120_000);
  afterAll(() => sockets.forEach((s) => s.disconnect()));

  it('un attendee por dispositivo y activeUserIds sin repetir', async () => {
    const web = await post(`/conversations/${chatId}/call`, ana.token, { kind: 'audio', deviceKey: 'webA1111' });
    expect(web.status, JSON.stringify(web.json)).toBe(200);
    callId = web.json.call.id;
    expect(web.json.attendee.Attendee.ExternalUserId).toBe(`${ana.id}#webA1111`);
    const phone = await post(`/calls/${callId}/join`, anaPhone, { deviceKey: 'iosB2222' });
    expect(phone.status).toBe(200);
    expect(phone.json.attendee.Attendee.ExternalUserId).toBe(`${ana.id}#iosB2222`);
    expect(phone.json.attendee.Attendee.AttendeeId).not.toBe(web.json.attendee.Attendee.AttendeeId);
    expect(phone.json.call.activeUserIds).toEqual([ana.id]);
    expect(phone.json.call.myDevices.map((d: any) => d.deviceKey).sort()).toEqual(['iosB2222', 'webA1111']);
    expect(phone.json.call.myDevices.find((d: any) => d.deviceKey === 'iosB2222')).toMatchObject({ platform: 'ios', label: 'iPhone de Ana' });
    // El otro dispositivo se entera de que contesté en el iPhone (y deja de sonar).
    const answered = await waitFor(() => anaWeb.find((e) => e.type === 'call.answered' && e.deviceKey === 'iosB2222'), 'call.answered');
    expect(answered).toMatchObject({ callId, conversationId: chatId, platform: 'ios', label: 'iPhone de Ana' });
    // Por la cuenta llega call.updated con MIS dispositivos; a Beto no le llegan los de Ana.
    await waitFor(() => anaWeb.find((e) => e.type === 'call.updated' && e.call.id === callId && e.call.myDevices?.length === 2), 'myDevices');
    expect(betoEvents.some((e) => e.type === 'call.updated' && e.call.myDevices?.length)).toBe(false);
  });

  it('latido por dispositivo, bootstrap.myActiveCall y /calls/active', async () => {
    expect((await post(`/calls/${callId}/heartbeat`, ana.token, { deviceKey: 'webA1111' })).json).toEqual({ ok: true });
    expect((await post(`/calls/${callId}/heartbeat`, ana.token, { deviceKey: 'otro0000' })).status).toBe(409);
    const b = (await call('/bootstrap', { token: anaPhone })).json;
    expect(b.myActiveCall).toMatchObject({ id: callId, activeUserIds: [ana.id] });
    expect(b.myActiveCall.myDevices).toHaveLength(2);
    expect((await call('/bootstrap', { token: beto.token })).json.myActiveCall).toBeNull();
    const act = (await call('/calls/active', { token: beto.token })).json.calls;
    expect(act.find((x: any) => x.call.id === callId)).toMatchObject({ title: `Varios ${run}`, call: { activeUserIds: [ana.id], myDevices: [] } });
  });

  it('«Pasar aquí»: leave {deviceKey} saca solo ese dispositivo', async () => {
    const r = await post(`/calls/${callId}/leave`, anaPhone, { deviceKey: 'webA1111' });
    expect(r.status).toBe(200);
    expect(r.json.call.endedAt).toBeNull();
    expect(r.json.call.activeUserIds).toEqual([ana.id]);
    expect(r.json.call.myDevices.map((d: any) => d.deviceKey)).toEqual(['iosB2222']);
  });

  it('cliente 1.7.0 (sin deviceKey): attendee con el id solo, latido y salida como antes', async () => {
    const j = await post(`/calls/${callId}/join`, beto.token);
    expect(j.status).toBe(200);
    expect(j.json.attendee.Attendee.ExternalUserId).toBe(beto.id);
    expect(j.json.call.activeUserIds).toEqual([ana.id, beto.id]);
    expect((await post(`/calls/${callId}/heartbeat`, beto.token)).json).toEqual({ ok: true });
    expect((await post(`/calls/${callId}/leave`, beto.token)).json.call.activeUserIds).toEqual([ana.id]);
  });

  it('rechazar avisa a todas mis sesiones', async () => {
    expect((await post(`/calls/${callId}/decline`, beto.token)).json).toEqual({ ok: true });
    await waitFor(() => betoEvents.find((e) => e.type === 'call.declined' && e.callId === callId), 'call.declined');
    expect(anaWeb.some((e) => e.type === 'call.declined')).toBe(false);
  });

  it('«＋ Agregar»: invited con Llamando… y joined al entrar; volver a llamar renueva la hora', async () => {
    const r = await post(`/calls/${callId}/invite`, anaPhone, { userIds: [carla.id] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const first = r.json.call.invited.find((x: any) => x.userId === carla.id);
    expect(first).toMatchObject({ joined: false });
    await sleep(1100);
    const again = (await post(`/calls/${callId}/invite`, anaPhone, { userIds: [carla.id] })).json.call.invited.find((x: any) => x.userId === carla.id);
    expect(Date.parse(again.at)).toBeGreaterThan(Date.parse(first.at));
    const j = await post(`/calls/${callId}/join`, carla.token, { deviceKey: 'andC3333' });
    expect(j.json.call.invited.find((x: any) => x.userId === carla.id).joined).toBe(true);
  });

  it('con No molestar de Beto, escribirle sigue respondiendo 201', async () => {
    await call('/me/dnd', { method: 'PUT', token: beto.token, body: { until: new Date(Date.now() + 3600_000).toISOString() } });
    const r = await post(`/conversations/${chatId}/messages`, ana.token, { clientMessageId: randomUUID(), body: 'hola en la llamada' });
    expect(r.status).toBe(201);
    await call('/me/dnd', { method: 'PUT', token: beto.token, body: { until: null } });
  });

  it('colgar el último dispositivo termina la llamada', async () => {
    await post(`/calls/${callId}/leave`, carla.token, { deviceKey: 'andC3333' });
    const r = await post(`/calls/${callId}/leave`, anaPhone, { deviceKey: 'iosB2222' });
    expect(r.json.call.endedAt).not.toBeNull();
    expect((await call('/bootstrap', { token: ana.token })).json.myActiveCall).toBeNull();
  });
});
