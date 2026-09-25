/**
 * Asuntos, reuniones y recordatorios en directos y chats grupales (sin espacio), y el aviso
 * «empieza en 10 min». Necesita el API y su worker (API_URL); push con test/fake-push.mjs (FAKE_PUSH_URL).
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const FAKE_PUSH = process.env.FAKE_PUSH_URL ?? 'http://localhost:59045';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.cw.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'ios' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ana: Actor, cesar: Actor, laura: Actor, otro: Actor, dmId: string, multiId: string;
let cesarSocket: Socket;
const accountEvents: any[] = [];

beforeAll(async () => {
  ana = await signup('Ana');
  laura = await signup('Laura', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  cesar = await signup('Cesar', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  otro = await signup('Otro');
  dmId = (await call('/chats', { token: ana.token, body: { userIds: [cesar.id] } })).json.id;
  multiId = (await call('/chats', { token: ana.token, body: { userIds: [cesar.id, laura.id], name: 'Trío' } })).json.id;
  cesarSocket = await new Promise((res, rej) => {
    const s = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: cesar.token } });
    s.on('account.event', (e) => accountEvents.push(e));
    s.once('ready', () => res(s)); s.once('connect_error', rej);
  });
});
afterAll(() => cesarSocket?.disconnect());

describe('asuntos en directos y chats grupales', () => {
  it('se crean sin espacio, se ven en las listas de sus participantes y no de otros', async () => {
    const m = (await call(`/conversations/${dmId}/messages`, { token: cesar.token, body: { clientMessageId: randomUUID(), body: '¿Me mandas la propuesta?' } })).json.message;
    const i = await call(`/conversations/${dmId}/issues`, { token: ana.token, body: { title: 'Enviar propuesta a César', originMessageId: m.id, ownerId: cesar.id } });
    expect(i.status).toBe(200);
    expect(i.json).toMatchObject({ workspaceId: null, conversationId: dmId, ownerId: cesar.id, requestedBy: cesar.id });
    const mine = (await call('/issues?mine=1', { token: cesar.token })).json.issues;
    expect(mine.some((x: any) => x.id === i.json.id)).toBe(true);
    expect((await call('/issues', { token: laura.token })).json.issues.some((x: any) => x.id === i.json.id)).toBe(false);
    expect((await call(`/issues/${i.json.id}`, { token: laura.token })).status).toBe(404);
    expect((await call(`/issues/${i.json.id}/comments`, { token: otro.token, body: { body: 'hola' } })).status).toBe(404);
    // El responsable debe participar; «esperando a» solo empresas de los participantes.
    expect((await call(`/conversations/${dmId}/issues`, { token: ana.token, body: { title: 'Para Laura', ownerId: laura.id } })).status).toBe(400);
    expect((await call(`/issues/${i.json.id}`, { token: ana.token, method: 'PATCH', body: { status: 'waiting', waitingOnOrgId: otro.orgId } })).status).toBe(400);
    const w = await call(`/issues/${i.json.id}`, { token: ana.token, method: 'PATCH', body: { status: 'waiting', waitingOnOrgId: ana.orgId } });
    expect(w.json).toMatchObject({ status: 'waiting', waitingOnOrgId: ana.orgId });
    const c = await call(`/issues/${i.json.id}/comments`, { token: cesar.token, body: { body: 'Te la mando hoy' } });
    expect(c.json.commentCount).toBe(1);
    const b = (await call('/bootstrap', { token: cesar.token })).json.conversations.find((x: any) => x.id === dmId);
    expect(b.openIssues).toBe(1);
  });

  it('en un chat grupal y en una lateral', async () => {
    const i = await call(`/conversations/${multiId}/issues`, { token: laura.token, body: { title: 'Definir agenda del trío' } });
    expect(i.json.workspaceId).toBeNull();
    expect((await call(`/issues?conversationId=${multiId}`, { token: cesar.token })).json.issues).toHaveLength(1);
    const anchor = (await call(`/conversations/${multiId}/messages`, { token: ana.token, body: { clientMessageId: randomUUID(), body: 'duda' } })).json.message;
    const side = await call(`/conversations/${multiId}/side`, { token: ana.token, body: { messageId: anchor.id, userIds: [laura.id] } });
    expect((await call(`/conversations/${side.json.id}/issues`, { token: ana.token, body: { title: 'Asunto de la lateral' } })).status).toBe(200);
    expect((await call('/issues', { token: cesar.token })).json.issues.some((x: any) => x.title === 'Asunto de la lateral')).toBe(false);
  });
});

describe('reuniones y recordatorios en directos', () => {
  it('reunión en un directo: invitados, RSVP, lista de la agenda y privacidad', async () => {
    const ev = await call(`/conversations/${dmId}/events`, { token: ana.token, body: { title: 'Café con César', startsAt: inMin(60), endsAt: inMin(90), timezone: 'America/Bogota' } });
    expect(ev.status).toBe(200);
    expect(ev.json.workspaceId).toBeNull();
    expect(ev.json.invitees.map((x: any) => x.userId).sort()).toEqual([ana.id, cesar.id].sort());
    expect((await call(`/events/${ev.json.id}/rsvp`, { token: cesar.token, body: { rsvp: 'maybe' } })).json.invitees.find((x: any) => x.userId === cesar.id).rsvp).toBe('maybe');
    const list = await call(`/events?from=${encodeURIComponent(inMin(0))}&to=${encodeURIComponent(inMin(120))}`, { token: cesar.token });
    expect(list.json.events.some((e: any) => e.id === ev.json.id)).toBe(true);
    expect((await call(`/events?from=${encodeURIComponent(inMin(0))}&to=${encodeURIComponent(inMin(120))}`, { token: laura.token })).json.events.some((e: any) => e.id === ev.json.id)).toBe(false);
    expect((await call(`/events/${ev.json.id}`, { token: laura.token })).status).toBe(404);
    expect((await call(`/conversations/${dmId}/events`, { token: ana.token, body: { title: 'Con Laura', startsAt: inMin(60), endsAt: inMin(90), timezone: 'America/Bogota', inviteeIds: [laura.id] } })).status).toBe(400);
  });

  it('un recordatorio vence en un directo (reminder.due + push)', async () => {
    const token = `apns-cesar-rem-${run}`;
    await call('/push/token', { token: cesar.token, method: 'PUT', body: { provider: 'apns', token } });
    const r = await call('/reminders', { token: cesar.token, body: { conversationId: dmId, note: 'Llamar a Ana', remindAt: new Date(Date.now() + 500).toISOString() } });
    expect(r.status).toBe(200);
    let got: any = null;
    for (let i = 0; i < 80 && !got; i++) { await sleep(300); got = accountEvents.find((e) => e.type === 'reminder.due' && e.reminder.id === r.json.id); }
    expect(got.reminder.conversationId).toBe(dmId);
    let push: any = null;
    for (let i = 0; i < 30 && !push; i++) { push = ((await (await fetch(`${FAKE_PUSH}/sent`)).json()) as any[]).find((s) => s.token === token && s.body.reminderId === r.json.id); if (!push) await sleep(300); }
    expect(push.body.aps.alert.body).toBe('Llamar a Ana');
  }, 40_000);

  it('aviso «empieza en 10 min»: una vez, a quienes van o no han respondido, con push TC_EVENT', async () => {
    const token = `apns-cesar-soon-${run}`;
    await call('/push/token', { token: cesar.token, method: 'PUT', body: { provider: 'apns', token } });
    const soon = await call(`/conversations/${multiId}/events`, { token: ana.token, body: { title: 'Revisión rápida', startsAt: inMin(8), endsAt: inMin(38), timezone: 'America/Bogota' } });
    const later = await call(`/conversations/${multiId}/events`, { token: ana.token, body: { title: 'Más tarde', startsAt: inMin(45), endsAt: inMin(60), timezone: 'America/Bogota' } });
    // Laura dice que no va: no recibe el aviso.
    await call(`/events/${soon.json.id}/rsvp`, { token: laura.token, body: { rsvp: 'no' } });
    let got: any = null;
    for (let i = 0; i < 100 && !got; i++) { await sleep(300); got = accountEvents.find((e) => e.type === 'event.soon' && e.event.id === soon.json.id); }
    expect(got).toMatchObject({ type: 'event.soon', minutes: 10, event: { id: soon.json.id, workspaceId: null, conversationId: multiId } });
    let push: any = null;
    for (let i = 0; i < 30 && !push; i++) { push = ((await (await fetch(`${FAKE_PUSH}/sent`)).json()) as any[]).find((s) => s.token === token && s.body.eventId === soon.json.id && s.body.minutes); if (!push) await sleep(300); }
    expect(push.body).toMatchObject({ type: 'event', minutes: 10, aps: { category: 'TC_EVENT', alert: { title: 'Empieza en 10 min: Revisión rápida', subtitle: 'Trío' } } });
    await sleep(16_000);
    expect(accountEvents.filter((e) => e.type === 'event.soon' && e.event.id === soon.json.id)).toHaveLength(1);
    expect(accountEvents.some((e) => e.type === 'event.soon' && e.event.id === later.json.id)).toBe(false);
    if (process.env.DATABASE_URL && ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)) {
      const pg = await import('pg');
      const db = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
      const invitedNo = (await db.query("SELECT rsvp FROM calendar_event_invitees WHERE event_id = $1 AND user_id = $2", [soon.json.id, laura.id])).rows[0].rsvp;
      expect(invitedNo).toBe('no');
      const jobs = (await db.query("SELECT payload FROM jobs WHERE kind = 'push.event_soon' AND payload->>'eventId' = $1", [soon.json.id])).rows;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].payload.userIds).not.toContain(laura.id);
      await db.end();
    }
    // Moverla la vuelve a avisar en su nuevo horario.
    const moved = await call(`/events/${soon.json.id}`, { token: ana.token, method: 'PATCH', body: { startsAt: inMin(5), endsAt: inMin(35) } });
    expect(moved.status).toBe(200);
    let again = 0;
    for (let i = 0; i < 100 && again < 2; i++) { await sleep(300); again = accountEvents.filter((e) => e.type === 'event.soon' && e.event.id === soon.json.id).length; }
    expect(again).toBe(2);
  }, 90_000);
});
