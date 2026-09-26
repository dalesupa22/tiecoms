/**
 * Menciones con @: offsets UTF-16 (emojis y tildes), validación y descartes, @todos, unreadMentions, bandeja,
 * edición y push aunque la conversación esté silenciada. API + worker (API_URL) con push falso (FAKE_PUSH_URL).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const FAKE_PUSH = process.env.FAKE_PUSH_URL ?? 'http://localhost:59045';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    name, email: `${name.toLowerCase().replace(/\W/g, '')}.men.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'ios' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
/** Arma el body y las menciones como lo haría un cliente (offsets = String.length de JS = UTF-16). */
function compose(parts: (string | { at: string; userId: string })[]) {
  let body = '';
  const mentions: { userId: string; start: number; length: number }[] = [];
  for (const p of parts) {
    if (typeof p === 'string') body += p;
    else { const text = `@${p.at}`; mentions.push({ userId: p.userId, start: body.length, length: text.length }); body += text; }
  }
  return { body, mentions };
}
const send = (a: Actor, conv: string, c: { body: string; mentions?: unknown[] }) =>
  call(`/conversations/${conv}/messages`, { token: a.token, body: { clientMessageId: randomUUID(), ...c } });
const boot = async (a: Actor) => (await call('/bootstrap', { token: a.token })).json;
const pushes = async () => (await (await fetch(`${FAKE_PUSH}/sent`)).json()) as any[];

let ana: Actor, laura: Actor, beto: Actor, otro: Actor, groupId: string, dmId: string;

beforeAll(async () => {
  ana = await signup('Ana');
  laura = await signup('Laura Gómez', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  beto = await signup('Beto', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  otro = await signup('Otro', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  groupId = (await call('/chats', { token: ana.token, body: { userIds: [laura.id, beto.id], name: 'Menciones' } })).json.id;
  dmId = (await call('/chats', { token: ana.token, body: { userIds: [laura.id] } })).json.id;
});

describe('menciones', () => {
  it('offsets UTF-16 con emojis y tildes; descarta quien no participa y tramos inválidos', async () => {
    const c = compose(['👋🏽 Hola ', { at: 'Laura Gómez', userId: laura.id }, ' y ', { at: 'Otro', userId: otro.id }, ', ¿revisan el café ☕?']);
    c.mentions.push({ userId: beto.id, start: 1, length: 4 }); // no empieza con «@»
    const r = await send(ana, groupId, c);
    expect(r.status).toBe(201);
    expect(r.json.message.mentions).toEqual([{ userId: laura.id, start: 10, length: 12 }]);
    expect(c.body.slice(10, 22)).toBe('@Laura Gómez');
    expect(r.json.droppedMentions.sort()).toEqual([otro.id, beto.id].sort());
    const page = (await call(`/conversations/${groupId}/messages`, { token: beto.token })).json.messages;
    expect(page.at(-1).mentions).toEqual([{ userId: laura.id, start: 10, length: 12 }]);
    const lb = (await boot(laura)).conversations.find((x: any) => x.id === groupId);
    expect(lb.unreadMentions).toBe(1);
    expect((await boot(beto)).conversations.find((x: any) => x.id === groupId).unreadMentions).toBe(0);
  });

  it('@todos cuenta para todos menos el autor y no se permite en directos', async () => {
    const r = await send(beto, groupId, compose([{ at: 'todos', userId: 'all' }, ' reunión a las 3']));
    expect(r.json.message.mentions).toEqual([{ userId: 'all', start: 0, length: 6 }]);
    expect((await boot(ana)).conversations.find((x: any) => x.id === groupId).unreadMentions).toBe(1);
    expect((await boot(laura)).conversations.find((x: any) => x.id === groupId).unreadMentions).toBe(2);
    expect((await boot(beto)).conversations.find((x: any) => x.id === groupId).unreadMentions).toBe(0);
    const dm = await send(ana, dmId, compose([{ at: 'todos', userId: 'all' }, ' hola']));
    expect(dm.json.message.mentions).toEqual([]);
    expect(dm.json.droppedMentions).toEqual(['all']);
  });

  it('bandeja: mis menciones recientes y leer la conversación las marca leídas', async () => {
    const inbox = (await call('/mentions', { token: laura.token })).json;
    expect(inbox.mentions.length).toBe(2);
    expect(inbox.mentions[0]).toMatchObject({ conversationId: groupId, all: true, read: false });
    expect(inbox.mentions[1]).toMatchObject({ all: false, read: false });
    expect(inbox.mentions[1].message.body).toContain('@Laura Gómez');
    const conv = (await boot(laura)).conversations.find((x: any) => x.id === groupId);
    await call(`/conversations/${groupId}/read`, { token: laura.token, body: { seq: conv.lastMessageSeq } });
    expect((await boot(laura)).conversations.find((x: any) => x.id === groupId).unreadMentions).toBe(0);
    expect((await call('/mentions', { token: laura.token })).json.mentions.every((m: any) => m.read)).toBe(true);
    const page1 = (await call('/mentions?limit=1', { token: laura.token })).json;
    expect(page1.hasMore).toBe(true);
    const page2 = (await call(`/mentions?limit=1&before=${encodeURIComponent(page1.mentions[0].createdAt)}`, { token: laura.token })).json;
    expect(page2.mentions[0].message.id).not.toBe(page1.mentions[0].message.id);
    expect((await call('/mentions', { token: otro.token })).json.mentions).toEqual([]);
  });

  it('editar: nuevas menciones reemplazan las anteriores; sin menciones y con otro texto se quitan', async () => {
    const m = (await send(ana, groupId, compose(['ok ', { at: 'Beto', userId: beto.id }]))).json.message;
    expect((await boot(beto)).conversations.find((x: any) => x.id === groupId).unreadMentions).toBe(1);
    const e = compose(['mejor ', { at: 'Laura Gómez', userId: laura.id }]);
    const ed = await call(`/messages/${m.id}`, { token: ana.token, method: 'PATCH', body: e });
    expect(ed.json.mentions).toEqual([{ userId: laura.id, start: 6, length: 12 }]);
    expect((await boot(beto)).conversations.find((x: any) => x.id === groupId).unreadMentions).toBe(0);
    expect((await boot(laura)).conversations.find((x: any) => x.id === groupId).unreadMentions).toBe(1);
    const plain = await call(`/messages/${m.id}`, { token: ana.token, method: 'PATCH', body: { body: 'sin menciones' } });
    expect(plain.json.mentions).toEqual([]);
    expect((await boot(laura)).conversations.find((x: any) => x.id === groupId).unreadMentions).toBe(0);
  });

  it('push: la mención llega aunque la conversación esté silenciada (no con «siempre»)', async () => {
    const token = `apns-beto-men-${run}`;
    await call('/push/token', { token: beto.token, method: 'PUT', body: { provider: 'apns', token } });
    await call(`/conversations/${groupId}/prefs`, { token: beto.token, method: 'PUT', body: { mutedUntil: new Date(Date.now() + 8 * 3600_000).toISOString() } });
    const plain = (await send(ana, groupId, { body: 'esto no suena' })).json.message;
    const m = (await send(ana, groupId, compose([{ at: 'Beto', userId: beto.id }, ' ¿me confirmas?']))).json.message;
    let hit: any = null;
    for (let i = 0; i < 40 && !hit; i++) { await sleep(300); hit = (await pushes()).find((p) => p.token === token && p.body.messageId === m.id); }
    expect(hit.body).toMatchObject({ type: 'mention', conversationId: groupId, aps: { category: 'TC_MESSAGE', alert: { title: 'Ana te mencionó', subtitle: 'Menciones', body: '@Beto ¿me confirmas?' } } });
    expect((await pushes()).some((p) => p.token === token && p.body.messageId === plain.id)).toBe(false);
    // Silencio «siempre»: tampoco la mención.
    await call(`/conversations/${groupId}/prefs`, { token: beto.token, method: 'PUT', body: { mutedUntil: '2099-12-31T00:00:00.000Z' } });
    const m2 = (await send(ana, groupId, compose([{ at: 'Beto', userId: beto.id }, ' otra']))).json.message;
    await sleep(2500);
    expect((await pushes()).some((p) => p.token === token && p.body.messageId === m2.id)).toBe(false);
    await call(`/conversations/${groupId}/prefs`, { token: beto.token, method: 'PUT', body: { mutedUntil: null } });
  });

  it('borrar el mensaje quita la mención', async () => {
    const m = (await send(ana, groupId, compose([{ at: 'Laura Gómez', userId: laura.id }, ' borrar']))).json.message;
    expect((await boot(laura)).conversations.find((x: any) => x.id === groupId).unreadMentions).toBe(1);
    await call(`/messages/${m.id}`, { token: ana.token, method: 'DELETE' });
    expect((await boot(laura)).conversations.find((x: any) => x.id === groupId).unreadMentions).toBe(0);
    expect((await call('/mentions', { token: laura.token })).json.mentions.some((x: any) => x.message.id === m.id)).toBe(false);
  });
});
