/**
 * Ronda de feedback de TestFlight: foto de grupo, conversaciones laterales,
 * «responder en privado» (forwarded.messageId) y notificaciones push.
 * Necesita el API y su worker (API_URL) con S3 falso (test/fake-s3.mjs) y los
 * APNs/FCM falsos (test/fake-push.mjs; FAKE_PUSH_URL = su puerto HTTP).
 * Si DATABASE_URL apunta a una base local, además revisa las filas de push.
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const FAKE_PUSH = process.env.FAKE_PUSH_URL ?? 'http://localhost:59045';
const run = randomUUID().slice(0, 8);
const localDb = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname) && !!process.env.APNS_HOST;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Actor { token: string; id: string; orgId: string; name: string; email: string }

async function call(path: string, opts: { method?: string; token?: string; body?: unknown; raw?: Buffer; type?: string } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : opts.raw ? { 'content-type': opts.type ?? 'image/png' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : opts.raw,
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// Cada alta desde una IP distinta (x-forwarded-for) para no chocar con el límite de 10 por minuto.
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function authCall(path: string, body: unknown) {
  const res = await fetch(`${API}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const email = `${name.toLowerCase()}.fb.${run}@example.com`;
  const r = await authCall('/auth/signup', {
    name, email, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'ios' },
  });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken, id: r.json.user.id, orgId: r.json.user.primaryOrgId, name, email };
}
async function login(a: Actor) {
  const r = await authCall('/auth/login', { email: a.email, password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest 2', platform: 'android' } });
  expect(r.status).toBe(200);
  return r.json.accessToken as string;
}
const send = (a: Actor, convId: string, body: string, extra: object = {}) =>
  call(`/conversations/${convId}/messages`, { token: a.token, body: { clientMessageId: randomUUID(), body, ...extra } });
const boot = async (a: Actor) => (await call('/bootstrap', { token: a.token })).json;

function connect(a: Actor): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: a.token } });
    s.once('ready', () => res(s));
    s.once('connect_error', rej);
  });
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Ana y Laura: empresa A. Beto y Carla: empresa B. Solo Ana y Beto están en el General del espacio.
let ana: Actor, laura: Actor, beto: Actor, carla: Actor;
let workspaceId: string, generalId: string, anchorId: string;
let betoSocket: Socket;

beforeAll(async () => {
  ana = await signup('Ana');
  laura = await signup('Laura', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  beto = await signup('Beto');
  carla = await signup('Carla', (await call(`/organizations/${beto.orgId}/invitations`, { token: beto.token, body: {} })).json.token);
  const ws = await call('/workspaces', { token: ana.token, body: { name: `Proyecto ${run}` } });
  workspaceId = ws.json.id; generalId = ws.json.generalConversationId;
  const inv = await call(`/workspaces/${workspaceId}/invitations`, { token: ana.token, body: { role: 'member', conversationIds: [generalId] } });
  expect((await call(`/invitations/${inv.json.token}/accept`, { token: beto.token, body: {} })).status).toBe(200);
  anchorId = (await send(ana, generalId, 'No tengo ni idea de cómo cerrar el contrato con el proveedor de logística')).json.message.id;
  betoSocket = await connect(beto);
});
afterAll(() => betoSocket?.disconnect());

describe('conversaciones laterales', () => {
  let sideLaura: string;

  it('abre una lateral privada con una colega que no está en el origen', async () => {
    const before = (await boot(beto)).conversations.find((c: any) => c.id === generalId);
    const seen: any[] = [];
    betoSocket.on('conv.event', (e) => seen.push(e));
    const r = await call(`/conversations/${generalId}/side`, { token: ana.token, body: { messageId: anchorId, userIds: [laura.id], question: '¿Me ayudas con esto?' } });
    expect(r.status).toBe(200);
    sideLaura = r.json.id;
    const lb = await boot(laura);
    const side = lb.conversations.find((c: any) => c.id === sideLaura);
    expect(side).toMatchObject({ kind: 'multi', workspaceId: null, parentId: generalId, parentMessageId: anchorId, deriveKind: 'side', avatarUrl: null });
    expect(side.name).toMatch(/^Consulta · No tengo ni idea/);
    expect(side.memberIds.sort()).toEqual([ana.id, laura.id].sort());
    const msgs = (await call(`/conversations/${sideLaura}/messages`, { token: laura.token })).json.messages;
    const started = JSON.parse(msgs[0].body);
    expect(started).toMatchObject({ k: 'side.started', authorName: 'Ana', parentName: null, messageId: anchorId });
    expect(started.excerpt).toContain('No tengo ni idea');
    expect(msgs[1]).toMatchObject({ kind: 'text', authorId: ana.id, body: '¿Me ayudas con esto?' });
    // Laura no puede leer el origen.
    expect((await call(`/conversations/${generalId}/messages`, { token: laura.token })).status).toBe(404);

    // Privacidad: Beto (en el origen) no la ve, no recibe sus eventos y en el origen no se publicó nada.
    await send(laura, sideLaura, 'Claro, mira la cláusula 4');
    await sleep(1500);
    const bb = await boot(beto);
    expect(bb.conversations.some((c: any) => c.id === sideLaura)).toBe(false);
    expect(bb.conversations.find((c: any) => c.id === generalId).lastMessageSeq).toBe(before.lastMessageSeq);
    expect(seen.some((e) => e.conversationId === sideLaura)).toBe(false);
    expect((await call(`/conversations/${sideLaura}/messages`, { token: beto.token })).status).toBe(404);
  });

  it('con alguien del origen muestra el nombre del origen', async () => {
    const r = await call(`/conversations/${generalId}/side`, { token: ana.token, body: { messageId: anchorId, userIds: [beto.id] } });
    expect(r.status).toBe(200);
    const msgs = (await call(`/conversations/${r.json.id}/messages`, { token: beto.token })).json.messages;
    expect(JSON.parse(msgs[0].body)).toMatchObject({ k: 'side.started', parentName: 'General' });
    expect(msgs).toHaveLength(1);
  });

  it('nadie de otra empresa que no esté en el origen (side_outsider)', async () => {
    const r = await call(`/conversations/${generalId}/side`, { token: ana.token, body: { messageId: anchorId, userIds: [laura.id, carla.id] } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('side_outsider');
    expect(r.json.error.details.userIds).toEqual([carla.id]);
    // Beto sí puede consultar a su colega Carla.
    expect((await call(`/conversations/${generalId}/side`, { token: beto.token, body: { messageId: anchorId, userIds: [carla.id] } })).status).toBe(200);
    // Tampoco se puede sumar después.
    const add = await call(`/conversations/${sideLaura}/members`, { token: laura.token, body: { userIds: [carla.id], history: 'all' } });
    expect(add.status).toBe(403);
    expect(add.json.error.code).toBe('side_outsider');
  });

  it('valida el mensaje ancla y las personas', async () => {
    const sysMsg = (await call(`/conversations/${generalId}/messages`, { token: ana.token })).json.messages.find((m: any) => m.kind === 'system');
    expect((await call(`/conversations/${generalId}/side`, { token: ana.token, body: { messageId: sysMsg.id, userIds: [laura.id] } })).status).toBe(400);
    expect((await call(`/conversations/${generalId}/side`, { token: ana.token, body: { messageId: anchorId, userIds: [ana.id] } })).status).toBe(400);
    expect((await call(`/conversations/${generalId}/side`, { token: ana.token, body: { messageId: anchorId, userIds: [] } })).status).toBe(400);
    expect((await call(`/conversations/${generalId}/side`, { token: laura.token, body: { messageId: anchorId, userIds: [ana.id] } })).status).toBe(404);
  });

  it('respeta los bloqueos', async () => {
    const lauraTok = laura.token;
    expect((await call(`/blocks/${ana.id}`, { token: lauraTok, method: 'PUT' })).status).toBe(200);
    const r = await call(`/conversations/${generalId}/side`, { token: ana.token, body: { messageId: anchorId, userIds: [laura.id] } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('blocked_user');
    expect((await call(`/blocks/${ana.id}`, { token: lauraTok, method: 'DELETE' })).status).toBe(200);
  });

  it('llevar la respuesta al hilo: solo quien puede escribir en el origen', async () => {
    expect((await call(`/conversations/${sideLaura}/return`, { token: laura.token, body: { summary: 'Laura dice: cláusula 4' } })).status).toBe(404);
    const r = await call(`/conversations/${sideLaura}/return`, { token: ana.token, body: { summary: 'Resuelto: aplica la cláusula 4' } });
    expect(r.status).toBe(200);
    const msgs = (await call(`/conversations/${generalId}/messages`, { token: beto.token })).json.messages;
    expect(msgs.at(-1)).toMatchObject({ body: 'Resuelto: aplica la cláusula 4', mergedFrom: sideLaura });
  });
});

describe('foto de grupo', () => {
  it('quien administra la cambia, los miembros la ven y queda un aviso', async () => {
    const up = await call(`/conversations/${generalId}/avatar`, { token: ana.token, raw: PNG });
    expect(up.status).toBe(200);
    expect(up.json.avatarUrl).toMatch(/^\/api\/v1\/avatars\/[0-9a-f-]{36}$/);
    const c = (await boot(beto)).conversations.find((x: any) => x.id === generalId);
    expect(c.avatarUrl).toBe(up.json.avatarUrl);
    const img = await fetch(`${API}${up.json.avatarUrl}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    const msgs = (await call(`/conversations/${generalId}/messages`, { token: beto.token })).json.messages;
    expect(JSON.parse(msgs.at(-1).body).k).toBe('group.photo_changed');
    // Reemplazar invalida la anterior.
    const up2 = await call(`/conversations/${generalId}/avatar`, { token: ana.token, raw: PNG, type: 'image/png' });
    expect((await fetch(`${API}${up.json.avatarUrl}`)).status).toBe(404);
    const del = await call(`/conversations/${generalId}/avatar`, { token: ana.token, method: 'DELETE' });
    expect(del.json).toEqual({ avatarUrl: null });
    expect((await fetch(`${API}${up2.json.avatarUrl}`)).status).toBe(404);
    const last = (await call(`/conversations/${generalId}/messages`, { token: beto.token })).json.messages.at(-1);
    expect(JSON.parse(last.body).k).toBe('group.photo_removed');
  });

  it('en un grupo del espacio no puede quien no administra; en multi, cualquiera; directos no', async () => {
    expect((await call(`/conversations/${generalId}/avatar`, { token: beto.token, raw: PNG })).status).toBe(403);
    const chat = await call('/chats', { token: ana.token, body: { userIds: [laura.id, beto.id], name: 'Equipo mixto' } });
    const up = await call(`/conversations/${chat.json.id}/avatar`, { token: beto.token, raw: PNG });
    expect(up.status).toBe(200);
    expect((await boot(laura)).conversations.find((x: any) => x.id === chat.json.id).avatarUrl).toBe(up.json.avatarUrl);
    const dm = await call('/chats', { token: ana.token, body: { userIds: [laura.id] } });
    expect((await call(`/conversations/${dm.json.id}/avatar`, { token: ana.token, raw: PNG })).status).toBe(400);
    expect((await call(`/conversations/${chat.json.id}/avatar`, { token: carla.token, raw: PNG })).status).toBe(404);
    expect((await call(`/conversations/${chat.json.id}/avatar`, { token: beto.token, raw: Buffer.from('no soy imagen'), type: 'image/png' })).status).toBe(400);
  });
});

describe('responder en privado', () => {
  it('manda al directo con el autor la cita del mensaje original', async () => {
    const dm = await call('/chats', { token: beto.token, body: { userIds: [ana.id] } });
    expect(dm.json.kind).toBe('direct');
    const fw = { source: 'tiecoms', author: 'Ana', sentAt: new Date().toISOString(), fromConversationId: generalId, messageId: anchorId };
    const r = await send(beto, dm.json.id, 'Te cuento por aquí', { forwarded: fw });
    expect(r.status).toBe(201);
    expect(r.json.message.forwarded).toMatchObject({ source: 'tiecoms', fromConversationId: generalId, messageId: anchorId, excerpt: 'No tengo ni idea de cómo cerrar el contrato con el proveedor de logística' });
    expect(r.json.message.forwarded.messageSeq).toBeGreaterThan(0);
    const seen = (await call(`/conversations/${dm.json.id}/messages`, { token: ana.token })).json.messages.at(-1);
    expect(seen.forwarded.messageId).toBe(anchorId);
    // Sin conversación de origen, o con un mensaje de otra conversación, no.
    expect((await send(beto, dm.json.id, 'x', { forwarded: { source: 'tiecoms', messageId: anchorId } })).status).toBe(400);
    const other = (await send(beto, dm.json.id, 'otro')).json.message.id;
    expect((await send(beto, dm.json.id, 'y', { forwarded: { source: 'tiecoms', fromConversationId: generalId, messageId: other } })).status).toBe(400);
  });
});

describe('nuevo grupo en un espacio (POST /workspaces/:id/conversations)', () => {
  it('interno solo admite a mi empresa; compartido admite a quien participa en el espacio; un tercero no puede crear', async () => {
    const internal = await call(`/workspaces/${workspaceId}/conversations`, { token: ana.token, body: { name: 'Solo Acme', kind: 'internal', level: null, memberIds: [beto.id] } });
    expect(internal.status).toBe(400);
    // Laura es colega pero no está en el espacio: tampoco.
    expect((await call(`/workspaces/${workspaceId}/conversations`, { token: ana.token, body: { name: 'Solo Acme', kind: 'internal', memberIds: [laura.id] } })).status).toBe(400);
    const ok = await call(`/workspaces/${workspaceId}/conversations`, { token: ana.token, body: { name: 'Directivo mixto', kind: 'group', level: 'directivo', memberIds: [beto.id] } });
    expect(ok.status).toBe(200);
    const c = (await boot(beto)).conversations.find((x: any) => x.id === ok.json.id);
    expect(c).toMatchObject({ kind: 'group', level: 'directivo', name: 'Directivo mixto', workspaceId });
    const solo = await call(`/workspaces/${workspaceId}/conversations`, { token: ana.token, body: { name: 'Interno vacío', kind: 'internal' } });
    expect(solo.status).toBe(200);
    expect((await boot(beto)).conversations.some((x: any) => x.id === solo.json.id)).toBe(false);
    // Tercero invitado: no crea grupos.
    const g = await call(`/workspaces/${workspaceId}/invitations`, { token: ana.token, body: { role: 'guest', conversationIds: [generalId] } });
    const guest = await signup('Gina');
    expect((await call(`/invitations/${g.json.token}/accept`, { token: guest.token, body: {} })).status).toBe(200);
    expect((await call(`/workspaces/${workspaceId}/conversations`, { token: guest.token, body: { name: 'Del tercero', kind: 'group' } })).status).toBe(403);
  });
});

describe('comentar asuntos', () => {
  it('cualquier participante comenta y el historial lo muestra con autor y hora', async () => {
    const issue = await call(`/conversations/${generalId}/issues`, { token: ana.token, body: { title: 'Cerrar contrato de logística', originMessageId: anchorId } });
    expect(issue.status).toBe(200);
    const ev = new Promise<any>((res) => betoSocket.on('conv.event', (e) => { if (e.type === 'issue.updated' && e.issue.id === issue.json.id && e.issue.commentCount === 1) res(e); }));
    const r = await call(`/issues/${issue.json.id}/comments`, { token: beto.token, body: { body: '¿Quién firma por parte del cliente?' } });
    expect(r.status).toBe(200);
    expect(r.json.commentCount).toBe(1);
    expect((await ev).issue.commentCount).toBe(1);
    const d = await call(`/issues/${issue.json.id}`, { token: ana.token });
    const c = d.json.events.find((e: any) => e.kind === 'comment');
    expect(c).toMatchObject({ actorId: beto.id, payload: { body: '¿Quién firma por parte del cliente?' } });
    expect(Date.parse(c.createdAt)).toBeGreaterThan(0);
    expect((await call(`/issues/${issue.json.id}/comments`, { token: beto.token, body: { body: '   ' } })).status).toBe(400);
    expect((await call(`/issues/${issue.json.id}/comments`, { token: laura.token, body: { body: 'hola' } })).status).toBe(404);
  });
});

describe('notificaciones push', () => {
  const tok = (p: string) => `${p}-${run}-${randomUUID().slice(0, 6)}`;
  const sent = async () => (await (await fetch(`${FAKE_PUSH}/sent`)).json()) as any[];
  async function waitFor(pred: (s: any) => boolean, ms = 8000) {
    for (let t = 0; t < ms; t += 300) {
      const hit = (await sent()).find(pred);
      if (hit) return hit;
      await sleep(300);
    }
    return null;
  }
  let db: import('pg').Pool | null = null;
  beforeAll(async () => {
    if (localDb) { const pg = await import('pg'); db = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }); }
  });
  afterAll(async () => { await db?.end(); });

  it('valida el registro del token', async () => {
    expect((await call('/push/token', { token: beto.token, method: 'PUT', body: { provider: 'webpush', token: 'abcdefghij' } })).status).toBe(400);
    expect((await call('/push/token', { token: beto.token, method: 'PUT', body: { provider: 'apns', token: 'x' } })).status).toBe(400);
    expect((await call('/push/token', { method: 'PUT', body: { provider: 'apns', token: 'abcdefghij' } })).status).toBe(401);
  });

  it('APNs: grupo con título, subtítulo autor · empresa, globo con los no leídos y sin avisarle al autor', async () => {
    const betoApns = tok('apns-beto');
    const anaApns = tok('apns-ana');
    expect((await call('/push/token', { token: beto.token, method: 'PUT', body: { provider: 'apns', token: betoApns, environment: 'sandbox' } })).json).toEqual({ ok: true });
    await call('/push/token', { token: ana.token, method: 'PUT', body: { provider: 'apns', token: anaApns } });
    const m = (await send(ana, generalId, 'Hola Beto, ¿revisaste la propuesta?')).json.message;
    const hit = await waitFor((s) => s.token === betoApns && s.body.messageId === m.id);
    expect(hit).toBeTruthy();
    expect(hit.topic).toBe('com.tiecoms.app');
    expect(hit.pushType).toBe('alert');
    const unread = (await boot(beto)).conversations.filter((c: any) => !c.mutedUntil).reduce((n: number, c: any) => n + c.unread, 0);
    expect(hit.body).toMatchObject({
      aps: { alert: { title: 'General', subtitle: `Ana · Ana SAS ${run}`, body: 'Hola Beto, ¿revisaste la propuesta?' }, badge: unread, sound: 'tc_notify.caf', 'thread-id': generalId, category: 'TC_MESSAGE', 'mutable-content': 1 },
      type: 'message', conversationId: generalId, messageId: m.id, authorId: ana.id, authorName: 'Ana', authorAvatarUrl: '',
    });
    expect(unread).toBeGreaterThan(0);
    expect((await sent()).some((s) => s.token === anaApns)).toBe(false);
  });

  it('directo: el título es la persona y el texto se recorta a 180', async () => {
    const betoApns = tok('apns-beto-dm');
    await call('/push/token', { token: beto.token, method: 'PUT', body: { provider: 'apns', token: betoApns } });
    const dm = await call('/chats', { token: ana.token, body: { userIds: [beto.id] } });
    const m = (await send(ana, dm.json.id, 'x'.repeat(400))).json.message;
    const hit = await waitFor((s) => s.token === betoApns && s.body.messageId === m.id);
    expect(hit.body.aps.alert.title).toBe('Ana');
    expect(hit.body.aps.alert.subtitle).toBeUndefined();
    expect(hit.body.aps.alert.body.length).toBeLessThanOrEqual(180);
  });

  it('FCM: mensaje de datos (sin notification) con prioridad alta', async () => {
    const lauraFcm = tok('fcm-laura');
    await call('/push/token', { token: laura.token, method: 'PUT', body: { provider: 'fcm', token: lauraFcm } });
    const chat = await call('/chats', { token: ana.token, body: { userIds: [laura.id, beto.id], name: 'Lanzamiento' } });
    const m = (await send(ana, chat.json.id, 'Arrancamos el lunes')).json.message;
    const hit = await waitFor((s) => s.token === lauraFcm && s.body.message.data.messageId === m.id);
    expect(hit).toBeTruthy();
    expect(hit.project).toBe('tiecoms-test');
    expect(hit.body.message.notification).toBeUndefined();
    expect(hit.body.message.android.priority).toBe('high');
    const d = hit.body.message.data;
    expect(d).toMatchObject({ type: 'message', title: 'Lanzamiento', subtitle: `Ana · Ana SAS ${run}`, body: 'Arrancamos el lunes', conversationId: chat.json.id, authorId: ana.id, authorName: 'Ana', threadId: chat.json.id, category: 'TC_MESSAGE' });
    expect(Object.values(d).every((v) => typeof v === 'string')).toBe(true);
    expect(Number(d.badge)).toBeGreaterThan(0);
  });

  it('una conversación silenciada no avisa', async () => {
    const betoApns = tok('apns-beto-mute');
    await call('/push/token', { token: beto.token, method: 'PUT', body: { provider: 'apns', token: betoApns } });
    await call(`/conversations/${generalId}/prefs`, { token: beto.token, method: 'PUT', body: { mutedUntil: new Date(Date.now() + 3600_000).toISOString() } });
    const muted = (await send(ana, generalId, 'Esto no debe sonar')).json.message;
    const dm = await call('/chats', { token: ana.token, body: { userIds: [beto.id] } });
    const control = (await send(ana, dm.json.id, 'Esto sí')).json.message;
    expect(await waitFor((s) => s.token === betoApns && s.body.messageId === control.id)).toBeTruthy();
    await sleep(1000);
    expect((await sent()).some((s) => s.body.messageId === muted.id && s.token === betoApns)).toBe(false);
    await call(`/conversations/${generalId}/prefs`, { token: beto.token, method: 'PUT', body: { mutedUntil: null } });
  });

  it('un token inválido se borra; cerrar sesión y DELETE también lo quitan', async () => {
    const t2 = await login(laura);
    const bad = tok('fcm-bad');
    await call('/push/token', { token: t2, method: 'PUT', body: { provider: 'fcm', token: bad } });
    const good = tok('fcm-laura-ok');
    await call('/push/token', { token: laura.token, method: 'PUT', body: { provider: 'fcm', token: good } });
    const chat = await call('/chats', { token: ana.token, body: { userIds: [laura.id, beto.id] } });
    const m = (await send(ana, chat.json.id, 'Prueba de token')).json.message;
    expect(await waitFor((s) => s.token === good && s.body.message.data.messageId === m.id)).toBeTruthy();
    if (db) {
      await sleep(500);
      expect((await db.query('SELECT 1 FROM push_subscriptions WHERE token = $1', [bad])).rowCount).toBe(0);
      // El token viejo de la sesión se reemplazó al registrar otro.
      expect((await db.query("SELECT count(*)::int AS n FROM push_subscriptions ps JOIN sessions s ON s.id = ps.session_id WHERE s.user_id = $1 AND ps.token LIKE 'fcm-laura-%'", [laura.id])).rows[0].n).toBe(1);
      const t3 = await login(laura);
      const temp = tok('fcm-temp');
      await call('/push/token', { token: t3, method: 'PUT', body: { provider: 'fcm', token: temp } });
      expect((await db.query('SELECT environment, lang FROM push_subscriptions WHERE token = $1', [temp])).rows[0]).toEqual({ environment: 'production', lang: 'es' });
      await call('/auth/logout', { token: t3, method: 'POST', body: {} });
      expect((await db.query('SELECT 1 FROM push_subscriptions WHERE token = $1', [temp])).rowCount).toBe(0);
      expect((await call('/push/token', { token: laura.token, method: 'DELETE' })).json).toEqual({ ok: true });
      expect((await db.query('SELECT 1 FROM push_subscriptions WHERE token = $1', [good])).rowCount).toBe(0);
    }
  });

  it('convocatoria de reunión y recordatorio vencido', async () => {
    const betoApns = tok('apns-beto-cal');
    await call('/push/token', { token: beto.token, method: 'PUT', body: { provider: 'apns', token: betoApns, lang: 'en' } });
    const starts = new Date(Date.now() + 86400_000);
    const ev = await call(`/conversations/${generalId}/events`, { token: ana.token, body: {
      title: 'Revisión de contrato', startsAt: starts.toISOString(), endsAt: new Date(starts.getTime() + 3600_000).toISOString(), timezone: 'America/Bogota',
    } });
    expect(ev.status).toBe(200);
    const hit = await waitFor((s) => s.token === betoApns && s.body.type === 'event');
    expect(hit.body).toMatchObject({ type: 'event', eventId: ev.json.id, conversationId: generalId, aps: { alert: { title: 'General', subtitle: 'Ana' }, category: 'TC_EVENT' } });
    expect(hit.body.aps.alert.body).toMatch(/^New meeting: Revisión de contrato · /);
    const rem = await call('/reminders', { token: beto.token, body: { conversationId: generalId, messageId: anchorId, remindAt: new Date(Date.now() + 500).toISOString() } });
    expect(rem.status).toBe(200);
    const rhit = await waitFor((s) => s.token === betoApns && s.body.type === 'reminder', 25_000);
    expect(rhit.body).toMatchObject({ type: 'reminder', reminderId: rem.json.id, conversationId: generalId, messageId: anchorId, aps: { alert: { title: 'Reminder', subtitle: 'General' }, category: 'TC_REMINDER' } });
    expect(rhit.body.aps.alert.body).toContain('No tengo ni idea');
  }, 40_000);
});
