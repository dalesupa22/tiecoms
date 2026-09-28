import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);

async function call(path: string, opts: { method?: string; token?: string; body?: unknown; contract?: string } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), 'x-tiecoms-contract': opts.contract ?? '2026-09-28' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const mail = (name: string) => `${name.toLowerCase()}.tanda.${run}@example.com`;
async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/auth/signup', { body: {
    name, ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }), email: mail(name),
    password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}
async function colleague(of: { token: string; orgId: string }, name: string, role: 'member' | 'admin' = 'member') {
  const inv = await call(`/organizations/${of.orgId}/invitations`, { token: of.token, body: { email: mail(name), role } });
  expect(inv.status).toBe(200);
  return signup(name, inv.json.token);
}


/**
 * Tanda del 28-sep-2026: marcar el árbol como leído sin carreras, asuntos personales aislados y
 * reuniones contra un proveedor FALSO (test/fake-meetings.mjs: esto no prueba OAuth ni proveedores reales).
 *   node test/fake-meetings.mjs 59300 &   (y el API con las variables MEETINGS_* que indica ese archivo)
 *   API_URL=http://localhost:3077 FAKE_MEETINGS=http://localhost:59300 npx vitest run test/tanda-lectura-reuniones.test.ts
 */
import { io, type Socket } from 'socket.io-client';
import { afterAll } from 'vitest';
const FAKE = process.env.FAKE_MEETINGS ?? 'http://localhost:59300';
type A = { token: string; id: string; orgId: string };
let ana: A, beto: A, groupId: string, anaSock: Socket, betoSock: Socket;
const anaEv: any[] = [], betoEv: any[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = async (a: A, conv: string, body: string) => (await call(`/conversations/${conv}/messages`, { token: a.token, body: { clientMessageId: randomUUID(), body } })).json.message;
const conv = async (a: A, id: string) => (await call('/bootstrap', { token: a.token })).json.conversations.find((c: any) => c.id === id);
const sock = (a: A, sink: any[]) => new Promise<Socket>((res, rej) => {
  const s = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: a.token } });
  s.on('account.event', (e) => sink.push(e)); s.once('ready', () => res(s)); s.once('connect_error', rej);
});

beforeAll(async () => {
  ana = await signup('Ana');
  beto = await colleague(ana, 'Beto');
  groupId = (await call('/groups', { token: ana.token, body: { name: `General ${run}`, target: { kind: 'org' }, memberIds: [beto.id] } })).json.conversationId;
  anaSock = await sock(ana, anaEv); betoSock = await sock(beto, betoEv);
});
afterAll(() => { anaSock?.disconnect(); betoSock?.disconnect(); });

describe('marcar como leído el grupo y sus derivadas', () => {
  it('reproduce «leído el grupo, 11 pendientes en derivadas» y lo corrige sin tragarse lo nuevo', async () => {
    const m0 = await say(beto, groupId, 'Hola equipo');
    const branch = (await call(`/conversations/${groupId}/derive`, { token: beto.token, body: { messageId: m0.id, kind: 'internal', name: 'Diagnóstico' } })).json;
    const branchId = branch.id ?? branch.conversationId;
    expect(branchId).toBeTruthy();
    for (let i = 0; i < 5; i++) await say(beto, branchId, `rama ${i}`);
    // Mención antigua dentro de la rama.
    await call(`/conversations/${branchId}/messages`, { token: beto.token, body: { clientMessageId: randomUUID(), body: '@Ana mira esto', mentions: [{ userId: ana.id, start: 0, length: 4 }] } });
    // Ana lee el grupo (su cursor llega al final) pero no abre la rama: el caso de Danny.
    const g = await conv(ana, groupId);
    await call(`/conversations/${groupId}/read`, { token: ana.token, body: { seq: g.lastMessageSeq } });
    const g2 = await conv(ana, groupId), b2 = await conv(ana, branchId);
    expect(g2.unread).toBe(0);
    expect(b2.parentId).toBe(groupId);
    expect(b2.unread).toBeGreaterThanOrEqual(6);
    expect(b2.unreadMentions).toBe(1);

    // Marcar el árbol con lo que el cliente conoce; en paralelo llega un mensaje nuevo a la rama.
    const known = b2.lastMessageSeq;
    const [r] = await Promise.all([
      call(`/conversations/${groupId}/read-tree`, { token: ana.token, body: { items: [{ conversationId: groupId, seq: g2.lastMessageSeq }, { conversationId: branchId, seq: known }] } }),
      say(beto, branchId, 'llegó mientras marcabas'),
    ]);
    expect(r.status).toBe(200);
    const b3 = await conv(ana, branchId);
    expect(b3.lastReadSeq).toBe(known);
    expect(b3.unread).toBe(1); // lo nuevo sigue pendiente
    expect(b3.unreadMentions).toBe(0);
    // Otro dispositivo se entera (read.updated).
    for (let i = 0; i < 20 && !anaEv.some((e) => e.type === 'read.updated' && e.conversationId === branchId); i++) await sleep(200);
    expect(anaEv.some((e) => e.type === 'read.updated' && e.conversationId === branchId)).toBe(true);
    // Persistencia: un bootstrap nuevo (otro dispositivo o tras reiniciar) ve lo mismo.
    expect((await conv(ana, branchId)).lastReadSeq).toBe(known);
  });

  it('no deja marcar conversaciones ajenas al árbol', async () => {
    const other = (await call('/groups', { token: ana.token, body: { name: `Otro ${run}`, target: { kind: 'org' }, memberIds: [beto.id] } })).json.conversationId;
    await say(beto, other, 'aparte');
    const o = await conv(ana, other);
    const r = await call(`/conversations/${groupId}/read-tree`, { token: ana.token, body: { items: [{ conversationId: other, seq: o.lastMessageSeq }] } });
    expect(r.status).toBe(200);
    expect(r.json.marked).toEqual([]);
    expect((await conv(ana, other)).unread).toBe(1);
  });
});

describe('asuntos personales', () => {
  let pid: string;
  it('solo los ve su dueño (API, por id, tiempo real, contadores)', async () => {
    const p = await call('/issues', { token: ana.token, body: { title: 'Renovar el pasaporte', dueDate: '2026-10-15' } });
    expect(p.status).toBe(200);
    pid = p.json.id;
    expect(p.json).toMatchObject({ conversationId: null, workspaceId: null, visibility: 'private', ownerId: ana.id, viewerIds: [ana.id] });
    expect((await call('/issues', { token: ana.token })).json.issues.map((i: any) => i.id)).toContain(pid);
    // Las apps anteriores (contrato viejo) no lo reciben.
    expect((await call('/issues', { token: ana.token, contract: '2026-09-26' })).json.issues.map((i: any) => i.id)).not.toContain(pid);
    // Un compañero de la misma empresa no lo ve de ninguna forma.
    expect((await call('/issues', { token: beto.token })).json.issues.map((i: any) => i.id)).not.toContain(pid);
    expect((await call(`/issues/${pid}`, { token: beto.token })).status).toBe(404);
    expect((await call(`/issues/${pid}`, { token: beto.token, method: 'PATCH', body: { status: 'done' } })).status).toBe(404);
    expect((await call(`/issues/${pid}/comments`, { token: beto.token, body: { body: 'hola' } })).status).toBe(404);
    expect((await call(`/issues/${pid}/children`, { token: beto.token, body: { title: 'Sacar cita' } })).status).toBe(404);
    await sleep(600);
    expect(JSON.stringify(betoEv)).not.toContain('pasaporte');
    expect(anaEv.some((e) => e.type === 'issue.personal' && e.issue.id === pid)).toBe(true);
    // Sin conversación: no cuenta en ningún chat.
    const boot = (await call('/bootstrap', { token: ana.token })).json;
    expect(boot.conversations.reduce((n: number, c: any) => n + (c.openIssues ?? 0), 0)).toBe(0);
  });

  it('sigue siendo personal: no se reasigna, no se comparte y no tiene tareas', async () => {
    expect((await call(`/issues/${pid}`, { token: ana.token, method: 'PATCH', body: { ownerId: beto.id } })).status).toBe(400);
    expect((await call(`/issues/${pid}`, { token: ana.token, method: 'PATCH', body: { visibility: 'all' } })).status).toBe(400);
    expect((await call(`/issues/${pid}`, { token: ana.token, method: 'PATCH', body: { viewerIds: [beto.id] } })).status).toBe(400);
    expect((await call(`/issues/${pid}/children`, { token: ana.token, body: { title: 'Sacar cita' } })).status).toBe(400);
    const d = await call(`/issues/${pid}`, { token: ana.token, method: 'PATCH', body: { status: 'done', title: 'Renovar pasaporte y visa' } });
    expect(d.json).toMatchObject({ status: 'done', title: 'Renovar pasaporte y visa', conversationId: null });
    expect((await call(`/conversations/${groupId}/messages?limit=100`, { token: beto.token })).json.messages.some((m: any) => m.body.includes('pasaporte'))).toBe(false);
  });
});

describe('reuniones (proveedor FALSO: no prueba OAuth real)', () => {
  const connect = async (a: A, provider: string) => {
    const s = await call(`/meetings/connect/${provider}`, { token: a.token, body: { platform: 'web' } });
    expect(s.status).toBe(200);
    // El «consentimiento» del proveedor falso redirige a la callback del API con code y state.
    const r1 = await fetch(s.json.url, { redirect: 'manual' });
    const cb = r1.headers.get('location')!;
    const r2 = await fetch(cb, { redirect: 'manual' });
    return r2.headers.get('location')!;
  };

  it('conectar Google por la callback del login, crear Meet ahora y compartir sin duplicar', async () => {
    const before = await call('/meetings/connections', { token: ana.token });
    expect(before.json.connections.find((c: any) => c.provider === 'google')).toMatchObject({ status: 'none', available: true });
    const back = await connect(ana, 'google');
    expect(back).toContain('/ajustes?');
    expect(back).toContain('connected=1');
    const conn = (await call('/meetings/connections', { token: ana.token })).json.connections.find((c: any) => c.provider === 'google');
    expect(conn).toMatchObject({ status: 'active', accountEmail: 'mock.google@example.com' });
    // Beto no ve la conexión de Ana.
    expect((await call('/meetings/connections', { token: beto.token })).json.connections.find((c: any) => c.provider === 'google').status).toBe('none');

    const stats0: any = await (await fetch(`${FAKE}/stats`)).json();
    const key = randomUUID();
    const input = { provider: 'google', conversationId: groupId, idempotencyKey: key, title: 'Urgente: caída del envío', durationMin: 30, timezone: 'America/Bogota', share: true };
    const [a, b] = await Promise.all([call('/meetings', { token: ana.token, body: input }), call('/meetings', { token: ana.token, body: input })]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.json.id).toBe(b.json.id);
    expect(a.json.joinUrl).toMatch(/^https:\/\/meet\.google\.com\/mock-/);
    const stats1: any = await (await fetch(`${FAKE}/stats`)).json();
    expect(stats1.google - stats0.google).toBe(1);
    // Compartido: mensaje con el enlace y reunión en el calendario del grupo.
    const msgs = (await call(`/conversations/${groupId}/messages?limit=100`, { token: beto.token })).json.messages;
    expect(msgs.filter((m: any) => m.body.includes(a.json.joinUrl))).toHaveLength(1);
    const from = new Date(Date.now() - 3600_000).toISOString(), to = new Date(Date.now() + 3 * 3600_000).toISOString();
    const evs = (await call(`/events?from=${from}&to=${to}`, { token: beto.token })).json.events ?? [];
    expect(evs.some((e: any) => e.location === a.json.joinUrl)).toBe(true);
    // Un tercer reintento con la misma llave devuelve lo mismo.
    expect((await call('/meetings', { token: ana.token, body: input })).json.joinUrl).toBe(a.json.joinUrl);
  });

  it('Teams: sin licencia no inventa enlace; permiso revocado pide reconectar; cancelar no conecta', async () => {
    await connect(ana, 'microsoft');
    await fetch(`${FAKE}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msNoTeams: true }) });
    const n = await call('/meetings', { token: ana.token, body: { provider: 'microsoft', conversationId: groupId, idempotencyKey: randomUUID(), title: 'Revisión', durationMin: 30, timezone: 'America/Bogota', share: true } });
    expect(n.status).toBe(409);
    expect(n.json.error.code).toBe('no_teams');
    await fetch(`${FAKE}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msNoTeams: false }) });
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const ok = await call('/meetings', { token: ana.token, body: { provider: 'microsoft', conversationId: groupId, idempotencyKey: randomUUID(), title: 'Revisión', startsAt: at, durationMin: 45, timezone: 'America/Bogota', share: false } });
    expect(ok.status).toBe(200);
    expect(ok.json.joinUrl).toMatch(/^https:\/\/teams\.microsoft\.com\//);
    expect(ok.json.messageId).toBeNull(); // share:false = solo el enlace para copiar
    // Revocado en el proveedor: el siguiente intento pide reconectar y no deja enlace.
    await fetch(`${FAKE}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revokeAll: true }) });
    const rv = await call('/meetings', { token: ana.token, body: { provider: 'microsoft', conversationId: groupId, idempotencyKey: randomUUID(), title: 'Otra', durationMin: 30, timezone: 'America/Bogota', share: true } });
    expect(rv.json).toMatchObject({ error: { code: 'reconnect_required' } });
    expect(rv.json.error.code).toBe('reconnect_required');
    expect((await call('/meetings/connections', { token: ana.token })).json.connections.find((c: any) => c.provider === 'microsoft').status).toBe('reconnect');
    await fetch(`${FAKE}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revokeAll: false }) });
    // Sin conectar: Beto recibe not_connected.
    const nc = await call('/meetings', { token: beto.token, body: { provider: 'google', conversationId: groupId, idempotencyKey: randomUUID(), title: 'Llamada', durationMin: 30, timezone: 'America/Bogota', share: true } });
    expect(nc.json.error.code).toBe('not_connected');
    // Cancelar el consentimiento vuelve con error y no conecta.
    const s = await call('/meetings/connect/zoom', { token: beto.token, body: { platform: 'ios', redirectScheme: 'chaggu' } });
    const r1 = await fetch(`${s.json.url}&deny=1`, { redirect: 'manual' });
    const r2 = await fetch(r1.headers.get('location')!, { redirect: 'manual' });
    expect(r2.headers.get('location')).toMatch(/^chaggu:\/\/meetings\/connected\?provider=zoom&error=cancelled/);
    expect((await call('/meetings/connections', { token: beto.token })).json.connections.find((c: any) => c.provider === 'zoom').status).toBe('none');
    // Desconectar.
    expect((await call('/meetings/connections/google', { token: ana.token, method: 'DELETE' })).status).toBe(200);
    expect((await call('/meetings/connections', { token: ana.token })).json.connections.find((c: any) => c.provider === 'google').status).toBe('none');
  });
});
