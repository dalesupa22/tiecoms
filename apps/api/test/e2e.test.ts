/**
 * Pruebas de extremo a extremo contra un API real (API_URL). Crean datos
 * propios con correos aleatorios; úsalas contra una base de pruebas.
 *   API_URL=http://localhost:3020 npx vitest run
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);

interface Actor { token: string; id: string; orgId: string; name: string; socket?: Socket }

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), 'x-tiecoms-client': 'test', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function signup(name: string, org: string): Promise<Actor> {
  const r = await call('/auth/signup', { body: {
    name, orgName: org, email: `${name.toLowerCase().replace(/\W/g, '')}.${run}@example.com`, password: 'clave-segura-123',
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'android' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken, id: r.json.user.id, orgId: r.json.user.primaryOrgId, name };
}

function connect(a: Actor): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: a.token } });
    s.once('ready', () => res(s));
    s.once('connect_error', rej);
    a.socket = s;
  });
}

function nextEvent(s: Socket, pred: (e: any) => boolean, ms = 5000): Promise<any> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { s.off('conv.event', h); rej(new Error('timeout esperando evento')); }, ms);
    const h = (e: any) => { if (pred(e)) { clearTimeout(t); s.off('conv.event', h); res(e); } };
    s.on('conv.event', h);
  });
}

let ana: Actor, beto: Actor, carla: Actor, tercero: Actor;
let workspaceId: string, generalId: string, internalId: string, directivoId: string;

beforeAll(async () => {
  ana = await signup('Ana Proveedor', `Proveedor ${run}`);
  beto = await signup('Beto Cliente', `Cliente ${run}`);
  carla = await signup('Carla Cliente', `Cliente B ${run}`);
  tercero = await signup('Tomas Tercero', `Independiente ${run}`);
});

afterAll(() => { for (const a of [ana, beto, carla, tercero]) a?.socket?.disconnect(); });

describe('espacios entre empresas', () => {
  it('crea un espacio con General y grupo interno', async () => {
    const r = await call('/workspaces', { token: ana.token, body: { name: `Proyecto ${run}` } });
    expect(r.status).toBe(200);
    workspaceId = r.json.id;
    generalId = r.json.generalConversationId;
    const b = await call('/bootstrap', { token: ana.token });
    const convs = b.json.conversations.filter((c: any) => c.workspaceId === workspaceId);
    expect(convs.map((c: any) => c.kind).sort()).toEqual(['group', 'internal']);
    internalId = convs.find((c: any) => c.kind === 'internal').id;
  });

  it('invita a otra empresa; al aceptar su empresa se suma al espacio y ve solo lo nuevo', async () => {
    await call(`/conversations/${generalId}/messages`, { token: ana.token, body: { clientMessageId: randomUUID(), body: 'mensaje previo a Beto' } });
    const inv = await call(`/workspaces/${workspaceId}/invitations`, { token: ana.token, body: { role: 'member', conversationIds: [generalId] } });
    expect(inv.status).toBe(200);
    const pre = await call(`/invitations/${inv.json.token}`);
    expect(pre.json.valid).toBe(true);
    const acc = await call(`/invitations/${inv.json.token}/accept`, { token: beto.token, body: {} });
    expect(acc.status).toBe(200);
    const again = await call(`/invitations/${inv.json.token}/accept`, { token: carla.token, body: {} });
    expect(again.status).toBe(409); // un solo uso
    const b = await call('/bootstrap', { token: beto.token });
    const ws = b.json.workspaces.find((w: any) => w.id === workspaceId);
    expect(ws.organizationIds).toContain(beto.orgId);
    // No ve el grupo interno de la otra empresa, ni siquiera su nombre.
    expect(b.json.conversations.some((c: any) => c.id === internalId)).toBe(false);
    const msgs = await call(`/conversations/${generalId}/messages`, { token: beto.token });
    expect(msgs.json.messages.some((m: any) => m.body === 'mensaje previo a Beto')).toBe(false);
  });

  it('niega acceso al grupo interno a quien no pertenece', async () => {
    const r = await call(`/conversations/${internalId}/messages`, { token: beto.token });
    expect(r.status).toBe(404);
    const w = await call(`/conversations/${internalId}/messages`, { token: beto.token, body: { clientMessageId: randomUUID(), body: 'intruso' } });
    expect(w.status).toBe(404);
  });
});

describe('mensajería durable', () => {
  it('entrega en tiempo real y el reintento con el mismo clientMessageId no duplica', async () => {
    await connect(ana);
    await connect(beto);
    const cid = randomUUID();
    const wait = nextEvent(beto.socket!, (e) => e.type === 'message.created' && e.message.clientMessageId === cid);
    const r1 = await call(`/conversations/${generalId}/messages`, { token: ana.token, body: { clientMessageId: cid, body: 'hola Beto' } });
    expect(r1.status).toBe(201);
    const ev = await wait;
    expect(ev.message.id).toBe(r1.json.message.id);
    const r2 = await call(`/conversations/${generalId}/messages`, { token: ana.token, body: { clientMessageId: cid, body: 'hola Beto' } });
    expect(r2.status).toBe(200);
    expect(r2.json.message.id).toBe(r1.json.message.id);
    const r3 = await call(`/conversations/${generalId}/messages`, { token: ana.token, body: { clientMessageId: cid, body: 'otro texto' } });
    expect(r3.status).toBe(409);
  });

  it('envío por socket con ACK tras persistir', async () => {
    const cid = randomUUID();
    const ack: any = await beto.socket!.timeout(5000).emitWithAck('message.send', { conversationId: generalId, clientMessageId: cid, body: 'desde socket' });
    expect(ack.ok).toBe(true);
    expect(ack.message.seq).toBeGreaterThan(0);
  });

  it('envíos concurrentes quedan con seq únicos y consecutivos', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      call(`/conversations/${generalId}/messages`, { token: i % 2 ? ana.token : beto.token, body: { clientMessageId: randomUUID(), body: `ráfaga ${i}` } })));
    const seqs = results.map((r) => r.json.message.seq).sort((a: number, b: number) => a - b);
    expect(new Set(seqs).size).toBe(12);
    expect(seqs[11] - seqs[0]).toBe(11);
  });

  it('recupera eventos desde un cursor sin huecos', async () => {
    const page = await call(`/conversations/${generalId}/events?after=0`, { token: beto.token });
    const seqs = page.json.events.map((e: any) => e.eventSeq);
    seqs.forEach((s: number, i: number) => i && expect(s).toBe(seqs[i - 1] + 1));
    expect(page.json.lastEventSeq).toBe(seqs[seqs.length - 1]);
    // Eventos anteriores a su llegada no revelan contenido.
    expect(page.json.events.some((e: any) => e.message?.body === 'mensaje previo a Beto')).toBe(false);
  });

  it('marca leído y lo refleja en el snapshot', async () => {
    const b1 = await call('/bootstrap', { token: beto.token });
    const c = b1.json.conversations.find((x: any) => x.id === generalId);
    await call(`/conversations/${generalId}/read`, { token: beto.token, body: { seq: c.lastMessageSeq } });
    const b2 = await call('/bootstrap', { token: beto.token });
    expect(b2.json.conversations.find((x: any) => x.id === generalId).unread).toBe(0);
  });
});

describe('terceros y permisos', () => {
  it('un tercero entra solo a grupos concretos y no ve el directorio completo', async () => {
    const g = await call(`/workspaces/${workspaceId}/conversations`, { token: ana.token, body: { name: 'Decisión directiva', level: 'directivo', memberIds: [beto.id] } });
    expect(g.status).toBe(200);
    directivoId = g.json.id;
    const legal = await call(`/workspaces/${workspaceId}/conversations`, { token: ana.token, body: { name: 'Revisión legal', memberIds: [] } });
    const until = new Date(Date.now() + 7 * 86400_000).toISOString();
    const inv = await call(`/workspaces/${workspaceId}/invitations`, { token: ana.token, body: { role: 'guest', conversationIds: [legal.json.id], accessUntil: until } });
    expect(inv.status).toBe(200);
    expect((await call(`/invitations/${inv.json.token}/accept`, { token: tercero.token, body: {} })).status).toBe(200);
    const b = await call('/bootstrap', { token: tercero.token });
    expect(b.json.conversations.map((c: any) => c.id)).toEqual([legal.json.id]);
    const ws = b.json.workspaces.find((w: any) => w.id === workspaceId);
    expect(ws.myRole).toBe('guest');
    expect(ws.memberIds).toEqual([]);
    expect(b.json.people.some((p: any) => p.id === beto.id)).toBe(false);
    // Su empresa no se suma al espacio.
    expect(ws.organizationIds).not.toContain(tercero.orgId);
    // No puede crear grupos, invitar, ni leer el directivo.
    expect((await call(`/workspaces/${workspaceId}/conversations`, { token: tercero.token, body: { name: 'Grupo del tercero' } })).status).toBe(403);
    expect((await call(`/workspaces/${workspaceId}/invitations`, { token: tercero.token, body: { role: 'member', conversationIds: [] } })).status).toBe(403);
    expect((await call(`/conversations/${directivoId}/messages`, { token: tercero.token })).status).toBe(404);
    // No puede abrir directos con quien no comparte... sí comparte espacio con Ana, pero no con Carla.
    expect((await call('/directs', { token: tercero.token, body: { userId: carla.id } })).status).toBe(403);
  });

  it('quitar a alguien de un grupo corta lectura y escritura de inmediato', async () => {
    expect((await call(`/conversations/${directivoId}/messages`, { token: beto.token })).status).toBe(200);
    expect((await call(`/conversations/${directivoId}/members/${beto.id}`, { method: 'DELETE', token: ana.token })).status).toBe(200);
    expect((await call(`/conversations/${directivoId}/messages`, { token: beto.token })).status).toBe(404);
    expect((await call(`/conversations/${directivoId}/messages`, { token: beto.token, body: { clientMessageId: randomUUID(), body: 'ya no' } })).status).toBe(404);
  });

  it('directo entre empresas del mismo espacio es único', async () => {
    const d1 = await call('/directs', { token: ana.token, body: { userId: beto.id } });
    const d2 = await call('/directs', { token: beto.token, body: { userId: ana.id } });
    expect(d1.json.id).toBe(d2.json.id);
  });
});

describe('sesiones', () => {
  it('revocar una sesión desconecta sus sockets', async () => {
    const s = await call('/sessions', { token: beto.token });
    const disconnected = new Promise<void>((res) => beto.socket!.once('disconnect', () => res()));
    await call(`/sessions/${s.json.current}`, { method: 'DELETE', token: beto.token });
    await disconnected;
  });
});

describe('colegas de la misma empresa', () => {
  it('un colega se une con invitación de empresa, queda en la misma empresa y aparece en el directorio', async () => {
    const inv = await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: { email: `colega.${run}@example.com` } });
    expect(inv.status).toBe(200);
    expect((await call(`/org-invitations/${inv.json.token}`)).json.valid).toBe(true);
    // Otro correo no puede usarla.
    const wrong = await call('/auth/signup', { body: { name: 'Intruso', email: `otro.${run}@example.com`, password: 'clave-segura-123', orgInviteToken: inv.json.token, device: { deviceId: randomUUID(), platform: 'ios' } } });
    expect(wrong.status).toBe(403);
    const ok = await call('/auth/signup', { body: { name: 'Colega Ana', email: `colega.${run}@example.com`, password: 'clave-segura-123', orgInviteToken: inv.json.token, device: { deviceId: randomUUID(), platform: 'ios' } } });
    expect(ok.status).toBe(200);
    expect(ok.json.user.primaryOrgId).toBe(ana.orgId);
    const b = await call('/bootstrap', { token: ana.token });
    expect(b.json.people.some((p: any) => p.id === ok.json.user.id)).toBe(true);
    // Un miembro sin rol de administración no puede invitar colegas.
    expect((await call(`/organizations/${ana.orgId}/invitations`, { token: ok.json.accessToken, body: {} })).status).toBe(403);
    // Y la invitación ya no sirve otra vez.
    expect((await call('/auth/signup', { body: { name: 'Otra', email: `colega.${run}@example.com`, password: 'clave-segura-123', orgInviteToken: inv.json.token, device: { deviceId: randomUUID(), platform: 'ios' } } })).status).toBe(409);
  });
});
