import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const mail = (name: string) => `${name.toLowerCase()}.tareas.${run}@example.com`;
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
 * Tareas derivadas y visibilidad. Caso real: James (Los Andes) abre un asunto en el grupo con Xertify;
 * de ahí salen tareas «solo Xertify» para Danny, Lorena y Adriana, una privada con un tercero (Tomás,
 * de otra empresa, que no está en el grupo) y otra en un sidechat. James no ve nada de eso.
 *   API_URL=http://localhost:3073 npx vitest run test/issue-children.test.ts
 */
import { io, type Socket } from 'socket.io-client';
import { afterAll } from 'vitest';
type A = { token: string; id: string; orgId: string };
let danny: A, lorena: A, adriana: A, james: A, tomas: A;
let groupId: string, parentId: string, jamesSock: Socket;
const jamesEvents: any[] = [];
const ids = (r: any) => (r.json.issues as any[]).map((i) => i.id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  danny = await signup('Danny');
  lorena = await colleague(danny, 'Lorena');
  adriana = await colleague(danny, 'Adriana');
  james = await signup('James');
  tomas = await signup('Tomas');
  const g = await call('/groups', { token: danny.token, body: { name: 'Los Andes', target: { kind: 'company', companyName: 'Los Andes' }, memberIds: [lorena.id, adriana.id] } });
  expect(g.status).toBe(200);
  groupId = g.json.conversationId;
  const inv = await call(`/workspaces/${g.json.workspaceId}/invitations`, { token: danny.token, body: { email: mail('James'), conversationIds: [groupId] } });
  expect((await call(`/invitations/${inv.json.token}/accept`, { token: james.token, body: {} })).status).toBe(200);
  // Tomás es contacto de Danny por un grupo interno aparte, no está en el grupo con Los Andes.
  const t = await call('/groups', { token: danny.token, body: { name: 'Proveedor', target: { kind: 'company', companyName: 'Proveedor' } } });
  const inv2 = await call(`/workspaces/${t.json.workspaceId}/invitations`, { token: danny.token, body: { email: mail('Tomas'), conversationIds: [t.json.conversationId] } });
  expect((await call(`/invitations/${inv2.json.token}/accept`, { token: tomas.token, body: {} })).status).toBe(200);
  jamesSock = await new Promise((res, rej) => {
    const s = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: james.token } });
    s.on('account.event', (e) => jamesEvents.push(e)); s.on('conv.event', (e) => jamesEvents.push(e));
    s.once('ready', () => res(s)); s.once('connect_error', rej);
  });
});
afterAll(() => jamesSock?.disconnect());

describe('tareas derivadas y visibilidad', () => {
  it('James abre el asunto; Xertify deriva tareas que James no ve', async () => {
    const p = await call(`/conversations/${groupId}/issues`, { token: james.token, body: { title: 'Los certificados no llegan a los estudiantes', ownerId: danny.id } });
    expect(p.status).toBe(200);
    parentId = p.json.id;
    expect(p.json.visibility).toBe('all');

    const mk = (who: A, title: string, ownerId: string, visibility?: string, extra: object = {}) =>
      call(`/issues/${parentId}/children`, { token: who.token, body: { title, ownerId, ...(visibility ? { visibility } : {}), ...extra } });
    const t1 = await mk(danny, 'Revisar logs del envío', danny.id, 'org');
    const t2 = await mk(danny, 'Revisar plantilla', lorena.id, 'org');
    const t3 = await mk(danny, 'Llamar al proveedor de correo', tomas.id, 'private');
    const t4 = await mk(danny, 'Responderle a James', adriana.id); // todo el chat
    for (const t of [t1, t2, t3, t4]) expect(t.status).toBe(200);
    expect(t1.json).toMatchObject({ parentIssueId: parentId, visibility: 'org', visibleOrgId: danny.orgId });
    expect(t3.json.viewerIds.sort()).toEqual([danny.id, tomas.id].sort());
    // Un responsable fuera del chat solo en tareas restringidas.
    expect((await mk(danny, 'Mal', tomas.id)).status).toBe(400);
    // Sin subtareas de subtareas.
    expect((await call(`/issues/${t1.json.id}/children`, { token: danny.token, body: { title: 'Nieta' } })).status).toBe(400);

    const jl = ids(await call(`/issues?conversationId=${groupId}`, { token: james.token }));
    expect(jl).toContain(parentId); expect(jl).toContain(t4.json.id);
    expect(jl).not.toContain(t1.json.id); expect(jl).not.toContain(t2.json.id); expect(jl).not.toContain(t3.json.id);
    expect((await call(`/issues/${t1.json.id}`, { token: james.token })).status).toBe(404);
    expect((await call(`/issues/${t1.json.id}`, { token: james.token, method: 'PATCH', body: { status: 'done' } })).status).toBe(404);
    const jd = await call(`/issues/${parentId}`, { token: james.token });
    expect(jd.json.children.map((x: any) => x.id)).toEqual([t4.json.id]);

    // Lorena (Xertify) ve las «solo Xertify» y la de todo el chat, no la privada con Tomás.
    const ll = ids(await call(`/issues?conversationId=${groupId}`, { token: lorena.token }));
    expect(ll).toEqual(expect.arrayContaining([parentId, t1.json.id, t2.json.id, t4.json.id]));
    expect(ll).not.toContain(t3.json.id);
    // Tomás ve solo su tarea privada, aunque no esté en el grupo; puede comentarla y cerrarla.
    const tl = ids(await call('/issues', { token: tomas.token }));
    expect(tl).toContain(t3.json.id); expect(tl).not.toContain(parentId); expect(tl).not.toContain(t1.json.id);
    expect((await call(`/issues/${t3.json.id}/comments`, { token: tomas.token, body: { body: 'Ya los llamé' } })).status).toBe(200);
    expect((await call(`/issues/${t3.json.id}`, { token: tomas.token, method: 'PATCH', body: { status: 'done' } })).json.status).toBe('done');
    // Tomás no puede leer el chat.
    expect((await call(`/conversations/${groupId}/messages`, { token: tomas.token })).status).toBeGreaterThanOrEqual(403);

    // Nada restringido llegó a James en vivo ni quedó en el chat.
    await sleep(800);
    const leaked = JSON.stringify(jamesEvents);
    for (const t of ['Revisar logs', 'Revisar plantilla', 'proveedor de correo']) expect(leaked).not.toContain(t);
    const msgs = (await call(`/conversations/${groupId}/messages?limit=100`, { token: james.token })).json.messages.map((m: any) => m.body).join(' ');
    expect(msgs).not.toContain('Revisar logs');
    const ev = (await call(`/conversations/${groupId}/events?after=0`, { token: james.token })).json.events;
    expect(JSON.stringify(ev)).not.toContain('Revisar logs');
    // Los contadores del bootstrap tampoco cuentan lo restringido (1 asunto + 1 tarea para todos).
    const conv = (await call('/bootstrap', { token: james.token })).json.conversations.find((c: any) => c.id === groupId);
    expect(conv.openIssues).toBe(2);
  });

  it('cambiar a restringido saca el asunto a quien pierde acceso (issue.hidden) y lo borra de su historial', async () => {
    const t = await call(`/issues/${parentId}/children`, { token: danny.token, body: { title: 'Borrador público', ownerId: danny.id } });
    expect((await call(`/issues?conversationId=${groupId}`, { token: james.token })).json.issues.some((i: any) => i.id === t.json.id)).toBe(true);
    // Solo quien la creó cambia la visibilidad.
    expect((await call(`/issues/${t.json.id}`, { token: lorena.token, method: 'PATCH', body: { visibility: 'org' } })).status).toBe(403);
    expect((await call(`/issues/${t.json.id}`, { token: danny.token, method: 'PATCH', body: { visibility: 'org' } })).json.visibility).toBe('org');
    let hidden: any = null;
    for (let i = 0; i < 30 && !hidden; i++) { await sleep(200); hidden = jamesEvents.find((e) => e.type === 'issue.hidden' && e.issueId === t.json.id); }
    expect(hidden).toBeTruthy();
    expect((await call(`/issues/${t.json.id}`, { token: james.token })).status).toBe(404);
    const ev = (await call(`/conversations/${groupId}/events?after=0`, { token: james.token })).json.events;
    expect(ev.some((e: any) => e.type === 'issue.updated' && e.issue?.id === t.json.id)).toBe(false);
  });

  it('sidechat desde el asunto: sus tareas son hijas del asunto y solo las ve el sidechat', async () => {
    const side = await call(`/conversations/${groupId}/side`, { token: danny.token, body: { issueId: parentId, userIds: [lorena.id] } });
    expect(side.status).toBe(200);
    const boot = (await call('/bootstrap', { token: lorena.token })).json.conversations.find((c: any) => c.id === side.json.id);
    expect(boot.sideIssueId).toBe(parentId);
    const t = await call(`/conversations/${side.json.id}/issues`, { token: lorena.token, body: { title: 'Probar reenvío', ownerId: lorena.id, parentIssueId: parentId } });
    expect(t.status).toBe(200);
    expect(t.json).toMatchObject({ parentIssueId: parentId, conversationId: side.json.id, visibility: 'all' });
    const dd = await call(`/issues/${parentId}`, { token: danny.token });
    expect(dd.json.children.map((x: any) => x.id)).toContain(t.json.id);
    const jd = await call(`/issues/${parentId}`, { token: james.token });
    expect(jd.json.children.map((x: any) => x.id)).not.toContain(t.json.id);
    expect((await call(`/issues/${t.json.id}`, { token: adriana.token })).status).toBe(404);
    // Un chat que no salió del grupo del asunto no puede tener hijas de él.
    const other = (await call('/groups', { token: danny.token, body: { name: 'Otro', target: { kind: 'org' } } })).json.conversationId;
    expect((await call(`/conversations/${other}/issues`, { token: danny.token, body: { title: 'Fuera', parentIssueId: parentId } })).status).toBe(400);
  });
});
