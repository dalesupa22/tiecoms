/**
 * «No molestar» (PUT /me/dnd): validación, bootstrap me.dndUntil, evento me.dnd a mis sesiones y
 * push: con DND activo no llega ningún push (mensaje, mención, reacción, reunión ni recordatorio);
 * al apagarlo vuelve. Los no leídos se cuentan igual.
 * Necesita el API y su worker (API_URL) con push falso (test/fake-push.mjs, FAKE_PUSH_URL).
 *   API_URL=http://localhost:3061 FAKE_PUSH_URL=http://localhost:59262 npx vitest run test/dnd.test.ts
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
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
    name, email: `${name.toLowerCase()}.dnd.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'ios' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const send = (a: Actor, conv: string, body: string, mentions?: unknown[]) =>
  call(`/conversations/${conv}/messages`, { token: a.token, body: { clientMessageId: randomUUID(), body, ...(mentions ? { mentions } : {}) } });
const pushes = async () => (await (await fetch(`${FAKE_PUSH}/sent`)).json()) as any[];
const dnd = (a: Actor, until: string | null) => call('/me/dnd', { token: a.token, method: 'PUT', body: { until } });
const inMin = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

let ana: Actor, beto: Actor, groupId: string, dmId: string, betoSocket: Socket;
const betoEvents: any[] = [];
const token = `apns-beto-dnd-${run}`;

beforeAll(async () => {
  ana = await signup('Ana');
  beto = await signup('Beto', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  groupId = (await call('/chats', { token: ana.token, body: { userIds: [beto.id], name: 'Silencio' } })).json.id;
  dmId = (await call('/chats', { token: ana.token, body: { userIds: [beto.id] } })).json.id;
  await call('/push/token', { token: beto.token, method: 'PUT', body: { provider: 'apns', token } });
  betoSocket = await new Promise((res, rej) => {
    const s = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: beto.token } });
    s.on('account.event', (e) => betoEvents.push(e));
    s.once('ready', () => res(s)); s.once('connect_error', rej);
  });
});
afterAll(() => betoSocket?.disconnect());

describe('No molestar', () => {
  it('PUT /me/dnd valida, responde dndUntil, lo refleja el bootstrap y avisa con me.dnd', async () => {
    expect((await call('/me/dnd', { token: beto.token, method: 'PUT', body: { until: 'mañana' } })).status).toBe(400);
    expect((await call('/me/dnd', { token: beto.token, method: 'PUT', body: {} })).status).toBe(400);
    expect((await call('/me/dnd', { method: 'PUT', body: { until: null } })).status).toBe(401);
    expect((await call('/bootstrap', { token: beto.token })).json.me.dndUntil).toBeNull();

    const until = new Date(Date.now() + 3600_000).toISOString();
    const on = await dnd(beto, until);
    expect(on).toEqual({ status: 200, json: { dndUntil: until } });
    expect((await call('/bootstrap', { token: beto.token })).json.me.dndUntil).toBe(until);
    let ev: any = null;
    for (let i = 0; i < 30 && !ev; i++) { await sleep(200); ev = betoEvents.find((e) => e.type === 'me.dnd' && e.dndUntil === until); }
    expect(ev).toEqual({ type: 'me.dnd', dndUntil: until });
    // Otra persona no ve mi «No molestar».
    expect((await call('/bootstrap', { token: ana.token })).json.me.dndUntil).toBeNull();

    // Una fecha pasada lo apaga (null).
    expect((await dnd(beto, new Date(Date.now() - 60_000).toISOString())).json).toEqual({ dndUntil: null });
    expect((await call('/bootstrap', { token: beto.token })).json.me.dndUntil).toBeNull();
    // «Hasta que lo reactive».
    expect((await dnd(beto, FOREVER)).json).toEqual({ dndUntil: '9999-12-31T00:00:00.000Z' });
    expect((await dnd(beto, null)).json).toEqual({ dndUntil: null });
    for (let i = 0; i < 30 && !betoEvents.some((e) => e.type === 'me.dnd' && e.dndUntil === null); i++) await sleep(200);
    expect(betoEvents.some((e) => e.type === 'me.dnd' && e.dndUntil === null)).toBe(true);
  });

  it('con DND activo no llega ningún push (mensaje, mención, reacción, reunión, recordatorio); los no leídos sí cuentan', async () => {
    await dnd(beto, FOREVER);
    const before = (await call('/bootstrap', { token: beto.token })).json.conversations.find((c: any) => c.id === dmId)?.unread ?? 0;
    const m1 = (await send(ana, dmId, 'Hola Beto, ¿tienes un minuto?')).json.message;
    const m2 = (await send(ana, groupId, '@Beto revisa esto', [{ userId: beto.id, start: 0, length: 5 }])).json.message;
    const mine = (await send(beto, groupId, 'Mensaje de Beto')).json.message;
    await call(`/messages/${mine.id}/reactions/${encodeURIComponent('👍')}`, { token: ana.token, method: 'PUT' });
    const ev = await call(`/conversations/${groupId}/events`, { token: ana.token, body: { title: 'Revisión DND', startsAt: inMin(120), endsAt: inMin(150), timezone: 'America/Bogota', inviteeIds: [beto.id] } });
    expect(ev.status).toBe(200);
    const rem = await call('/reminders', { token: beto.token, body: { conversationId: dmId, note: 'Recordatorio en DND', remindAt: new Date(Date.now() + 500).toISOString() } });
    expect(rem.status).toBe(200);
    // El recordatorio vence igual (evento en la app), pero sin push.
    for (let i = 0; i < 60 && !betoEvents.some((e) => e.type === 'reminder.due' && e.reminder.id === rem.json.id); i++) await sleep(300);
    expect(betoEvents.some((e) => e.type === 'reminder.due' && e.reminder.id === rem.json.id)).toBe(true);
    const after = (await call('/bootstrap', { token: beto.token })).json.conversations.find((c: any) => c.id === dmId).unread;
    expect(after).toBe(before + 1);

    // La reacción sale del worker a los ~20 s: se espera a que pase.
    await sleep(24_000);
    const mineSent = (await pushes()).filter((p) => p.token === token);
    expect(mineSent.filter((p) => [m1.id, m2.id, mine.id].includes(p.body.messageId))).toEqual([]);
    expect(mineSent.some((p) => p.body.eventId === ev.json.id || p.body.reminderId === rem.json.id)).toBe(false);

    // Al apagarlo vuelve el push.
    await dnd(beto, null);
    const m3 = (await send(ana, dmId, 'Ya puedes contestar')).json.message;
    let hit: any = null;
    for (let i = 0; i < 40 && !hit; i++) { await sleep(300); hit = (await pushes()).find((p) => p.token === token && p.body.messageId === m3.id); }
    expect(hit?.body).toMatchObject({ type: 'message', conversationId: dmId, aps: { alert: { title: 'Ana', body: 'Ya puedes contestar' } } });
    // Nada de lo enviado en DND se reenvía después.
    expect((await pushes()).some((p) => p.token === token && [m1.id, m2.id].includes(p.body.messageId))).toBe(false);
  }, 60_000);

  it('un DND vencido no bloquea el push', async () => {
    await dnd(beto, new Date(Date.now() + 1500).toISOString());
    await sleep(2000);
    const m = (await send(ana, dmId, 'Pasó la hora')).json.message;
    let hit: any = null;
    for (let i = 0; i < 40 && !hit; i++) { await sleep(300); hit = (await pushes()).find((p) => p.token === token && p.body.messageId === m.id); }
    expect(hit).toBeTruthy();
    expect((await call('/bootstrap', { token: beto.token })).json.me.dndUntil).toBeNull();
  });
});
