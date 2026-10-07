/**
 * Admins de grupo (como WhatsApp) e integraciones por grupo: webhook entrante con formato Slack, API de asuntos
 * con token y webhook de salida firmado. Necesita el API (API_URL) y su worker, con INTEGRATIONS_ALLOW_LOCAL=true.
 */
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);

async function raw(path: string, opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const call = (path: string, opts: Parameters<typeof raw>[1] = {}) => raw(`/api/v1${path}`, opts);
const mail = (name: string) => `${name.toLowerCase()}.integ.${run}@example.com`;
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
const conv = async (token: string, id: string) => (await call('/bootstrap', { token })).json.conversations.find((c: any) => c.id === id);
const until = async <T>(fn: () => T | undefined, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v !== undefined) return v; if (Date.now() > end) throw new Error('tiempo agotado'); await new Promise((r) => setTimeout(r, 200)); }
};

type U = Awaited<ReturnType<typeof signup>>;

describe('admins de grupo', () => {
  let danny: U, laura: U, pedro: U, ana: U, asesor: U, group: string, ws: string;
  beforeAll(async () => {
    danny = await signup('Danny');
    laura = await colleague(danny, 'Laura');
    pedro = await colleague(danny, 'Pedro');
    ana = await colleague(danny, 'Ana');
    asesor = await signup('Asesor');
    // Laura crea el grupo (no es admin de la empresa): ella es la creadora.
    const g = await call('/groups', { token: laura.token, body: { name: 'Operaciones', target: { kind: 'org' }, memberIds: [pedro.id, ana.id] } });
    expect(g.status).toBe(200);
    group = g.json.conversationId; ws = g.json.workspaceId;
  });

  it('quien crea es admin y el bootstrap trae adminIds y createdBy', async () => {
    const c = await conv(pedro.token, group);
    expect(c.adminIds).toEqual([laura.id]);
    expect(c.createdBy).toBe(laura.id);
    expect(c.canManage).toBe(false);
  });

  it('solo un admin nombra admins; el nuevo admin puede sacar y nombrar', async () => {
    expect((await call(`/conversations/${group}/members/${ana.id}/admin`, { method: 'PUT', token: pedro.token, body: { admin: true } })).status).toBe(403);
    const r = await call(`/conversations/${group}/members/${pedro.id}/admin`, { method: 'PUT', token: laura.token, body: { admin: true } });
    expect(r.status).toBe(200);
    expect(r.json.adminIds.sort()).toEqual([laura.id, pedro.id].sort());
    const c = await conv(pedro.token, group);
    expect(c.canManage).toBe(true);
    // Pedro (admin) nombra a Ana y luego se la quita: los admins se quitan entre ellos.
    expect((await call(`/conversations/${group}/members/${ana.id}/admin`, { method: 'PUT', token: pedro.token, body: { admin: true } })).status).toBe(200);
    expect((await call(`/conversations/${group}/members/${ana.id}/admin`, { method: 'PUT', token: pedro.token, body: { admin: false } })).status).toBe(200);
    // Mensajes de sistema en el chat.
    const msgs = (await call(`/conversations/${group}/messages?limit=50`, { token: laura.token })).json.messages;
    const keys = msgs.filter((m: any) => m.kind === 'system').map((m: any) => JSON.parse(m.body).k);
    expect(keys).toContain('admin.added');
    expect(keys).toContain('admin.removed');
  });

  it('a quien creó el grupo no se le quita el admin ni se le saca', async () => {
    expect((await call(`/conversations/${group}/members/${laura.id}/admin`, { method: 'PUT', token: pedro.token, body: { admin: false } })).status).toBe(403);
    expect((await call(`/conversations/${group}/members/${laura.id}`, { method: 'DELETE', token: pedro.token })).status).toBe(403);
  });

  it('un admin saca a otro admin', async () => {
    await call(`/conversations/${group}/members/${ana.id}/admin`, { method: 'PUT', token: laura.token, body: { admin: true } });
    expect((await call(`/conversations/${group}/members/${ana.id}`, { method: 'DELETE', token: pedro.token })).status).toBe(200);
    const c = await conv(laura.token, group);
    expect(c.memberIds).not.toContain(ana.id);
    expect(c.adminIds).not.toContain(ana.id);
  });

  it('los terceros no son admins', async () => {
    const inv = await call(`/workspaces/${ws}/invitations`, { token: laura.token, body: { email: mail('Asesor'), role: 'guest', conversationIds: [group] } });
    expect(inv.status).toBe(200);
    expect((await call(`/invitations/${inv.json.token}/accept`, { token: asesor.token, body: {} })).status).toBe(200);
    expect((await call(`/conversations/${group}/members/${asesor.id}/admin`, { method: 'PUT', token: laura.token, body: { admin: true } })).status).toBe(400);
  });

  it('si sale el último admin, el miembro más antiguo que no es tercero pasa a serlo', async () => {
    const g = await call('/groups', { token: pedro.token, body: { name: 'Temporal', target: { kind: 'org' }, memberIds: [ana.id] } });
    const id = g.json.conversationId;
    expect((await call(`/conversations/${id}/members/${pedro.id}`, { method: 'DELETE', token: pedro.token })).status).toBe(200);
    const c = await conv(ana.token, id);
    expect(c.adminIds).toEqual([ana.id]);
    expect(c.canManage).toBe(true);
  });
});

describe('integraciones por grupo', () => {
  let danny: U, laura: U, pedro: U, group: string;
  let hook: { id: string; token: string; urlWithToken: string; secret: string };
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let server: http.Server; let port = 0; let failNext = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (failNext > 0) { failNext--; res.statusCode = 500; res.end('fallo'); return; }
        received.push({ headers: req.headers, body }); res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    danny = await signup('Dora'); // owner de su empresa
    laura = await colleague(danny, 'Lina');
    pedro = await colleague(danny, 'Pablo');
    const g = await call('/groups', { token: laura.token, body: { name: 'Mesa de ayuda', target: { kind: 'org' }, memberIds: [danny.id, pedro.id] } });
    group = g.json.conversationId;
  });
  afterAll(() => server?.close());

  it('solo quien administra la empresa o el espacio crea una integración', async () => {
    // Laura es admin del grupo (lo creó), pero no de la empresa ni del espacio.
    expect((await call(`/conversations/${group}/integrations`, { token: pedro.token, body: { name: 'Mesa Xertify' } })).status).toBe(403);
    expect((await call(`/conversations/${group}/integrations`, { token: laura.token, body: { name: 'Mesa Xertify' } })).status).toBe(403);
    const r = await call(`/conversations/${group}/integrations`, { token: danny.token, body: { name: 'Mesa Xertify', outgoingUrl: `http://127.0.0.1:${port}/chaggu` } });
    expect(r.status).toBe(200);
    expect(r.json.token).toMatch(/^chg_/);
    expect(r.json.outgoingSecret).toMatch(/^whsec_/);
    expect(r.json.integration.webhookUrl).toContain(`/api/hooks/${r.json.integration.id}`);
    hook = { id: r.json.integration.id, token: r.json.token, urlWithToken: r.json.webhookUrlWithToken, secret: r.json.outgoingSecret };
    // El bot es participante del grupo; Laura (admin del grupo) ve la integración, sin secretos y sin poder configurarla.
    const c = await conv(laura.token, group);
    expect(c.memberIds).toContain(r.json.integration.botUserId);
    const list = await call(`/conversations/${group}/integrations`, { token: laura.token });
    expect(list.status).toBe(200);
    expect(list.json.canConfigure).toBe(false);
    expect(list.json.integrations[0].outgoingUrl).toBe(`http://127.0.0.1:${port}`); // no secret destination path/query for group-only admins
    expect(JSON.stringify(list.json)).not.toContain(hook.token);
    expect((await call(`/conversations/${group}/integrations`, { token: pedro.token })).status).toBe(403);
  });

  it('el webhook entrante acepta el formato de Slack (token en cabecera o en la URL)', async () => {
    const a = await raw(`/api/hooks/${hook.id}`, { token: hook.token, body: { text: '*LEAD XERTIFLOW*\n*Nombre:* Ana <https://x.co|sitio>' } });
    expect(a.status).toBe(200);
    expect(a.json.ok).toBe(true);
    const path = new URL(hook.urlWithToken).pathname;
    const b = await raw(path, { body: { blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Ticket 12' } },
      { type: 'section', fields: [{ type: 'mrkdwn', text: '*Cliente:* Uniandes' }, { type: 'mrkdwn', text: '*Prioridad:* Alta' }] },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Completar' } }] },
    ] } });
    expect(b.status).toBe(200);
    const msgs = (await call(`/conversations/${group}/messages?limit=20`, { token: pedro.token })).json.messages.filter((m: any) => m.kind === 'text');
    const bodies = msgs.map((m: any) => m.body);
    expect(bodies).toContain('LEAD XERTIFLOW\nNombre: Ana sitio (https://x.co)');
    expect(bodies).toContain('TICKET 12\nCliente: Uniandes\nPrioridad: Alta');
  });

  it('la idempotencia no duplica y un token malo no entra', async () => {
    const key = randomUUID();
    const one = await raw(`/api/hooks/${hook.id}`, { token: hook.token, body: { text: 'una vez' }, headers: { 'idempotency-key': key } });
    const two = await raw(`/api/hooks/${hook.id}`, { token: hook.token, body: { text: 'una vez' }, headers: { 'idempotency-key': key } });
    expect(two.json.messageId).toBe(one.json.messageId);
    expect((await raw(`/api/hooks/${hook.id}`, { token: 'chg_falso', body: { text: 'x' } })).status).toBe(401);
    expect((await raw(`/api/hooks/${randomUUID()}`, { token: hook.token, body: { text: 'x' } })).status).toBe(401);
    expect((await raw(`/api/hooks/${hook.id}`, { body: { text: 'x' } })).status).toBe(401);
    expect((await raw(`/api/hooks/${hook.id}`, { token: hook.token, body: {} })).status).toBe(400);
  });

  let issueId = '';
  it('crea un asunto por ticket (idempotente por externalId) y lo comenta', async () => {
    const body = {
      title: 'Ticket XT-0001 · Wallet - Consulta certificado', externalId: 'XT-0001', description: 'No veo mi certificado',
      externalMeta: { Cliente: 'Uniandes', Correo: 'ana@uniandes.edu.co', Prioridad: 'Alta' },
      history: [{ author: 'Ana (cliente)', body: 'Sigo esperando', at: '2026-09-27' }],
    };
    const a = await raw('/api/integration/v1/issues', { token: hook.token, body });
    expect(a.status).toBe(200);
    expect(a.json.created).toBe(true);
    const b = await raw('/api/integration/v1/issues', { token: hook.token, body });
    expect(b.json.created).toBe(false);
    expect(b.json.issue.id).toBe(a.json.issue.id);
    issueId = a.json.issue.id;
    expect(a.json.issue).toMatchObject({ integrationId: hook.id, externalId: 'XT-0001', status: 'open', ownerId: null });
    const found = await raw('/api/integration/v1/issues?externalId=XT-0001', { token: hook.token });
    expect(found.json.issue.id).toBe(issueId);
    expect(found.json.events.filter((e: any) => e.kind === 'comment').length).toBe(2);
    // La gente del grupo lo ve como un asunto normal.
    const seen = await call(`/issues/${issueId}`, { token: pedro.token });
    expect(seen.status).toBe(200);
    expect(seen.json.issue.externalMeta.Cliente).toBe('Uniandes');
    // Sin responsable: entra a «Nuevas» de la gente del grupo (una sola vez aunque el ticket se reenvíe).
    const inbox = (await call('/issues/inbox', { token: pedro.token })).json.items.filter((x: any) => x.issueId === issueId);
    expect(inbox).toEqual([expect.objectContaining({ reason: 'ticket' })]);
    const c = await raw(`/api/integration/v1/issues/${issueId}/comments`, { token: hook.token, body: { body: '¿Alguna novedad?', author: 'Ana (cliente)' } });
    expect(c.status).toBe(200);
    // Lo que hace el propio bot no se avisa de vuelta.
    await new Promise((r) => setTimeout(r, 1500));
    expect(received.length).toBe(0);
  });

  it('cambios de estado y comentarios de la gente llegan al webhook de salida, firmados', async () => {
    expect((await call(`/issues/${issueId}`, { method: 'PATCH', token: pedro.token, body: { status: 'in_progress' } })).status).toBe(200);
    expect((await call(`/issues/${issueId}/comments`, { token: pedro.token, body: { body: 'Ya lo estamos revisando' } })).status).toBe(200);
    await until(() => (received.length >= 2 ? true : undefined));
    const events = received.map((r) => {
      const [t, v1] = String(r.headers['x-chaggu-signature']).split(',').map((p) => p.split('=')[1]);
      expect(createHmac('sha256', hook.secret).update(`${t}.${r.body}`).digest('hex')).toBe(v1);
      return JSON.parse(r.body);
    });
    expect(events.find((e) => e.type === 'issue.status_changed')).toMatchObject({ from: 'open', to: 'in_progress', issue: { externalId: 'XT-0001' }, actor: { id: pedro.id } });
    expect(events.find((e) => e.type === 'issue.commented')).toMatchObject({ comment: { body: 'Ya lo estamos revisando' } });
  });

  it('reintenta si el sistema externo falla', async () => {
    received.length = 0;
    failNext = 1;
    await call(`/issues/${issueId}`, { method: 'PATCH', token: pedro.token, body: { status: 'done' } });
    await until(() => (received.length ? true : undefined), 25_000);
    expect(JSON.parse(received[0]!.body)).toMatchObject({ type: 'issue.status_changed', to: 'done' });
  });

  it('otra integración no toca los asuntos de esta', async () => {
    const other = await call(`/conversations/${group}/integrations`, { token: danny.token, body: { name: 'Landing' } });
    expect((await raw(`/api/integration/v1/issues/${issueId}`, { token: other.json.token })).status).toBe(404);
    expect((await raw(`/api/integration/v1/issues/${issueId}`, { method: 'PATCH', token: other.json.token, body: { status: 'open' } })).status).toBe(404);
  });

  it('rotar invalida el token anterior y revocar saca al bot', async () => {
    const r = await call(`/integrations/${hook.id}/rotate`, { token: danny.token, body: {} });
    expect(r.status).toBe(200);
    expect((await raw(`/api/hooks/${hook.id}`, { token: hook.token, body: { text: 'viejo' } })).status).toBe(401);
    expect((await raw(`/api/hooks/${hook.id}`, { token: r.json.token, body: { text: 'nuevo' } })).status).toBe(200);
    const bot = r.json.integration.botUserId;
    expect((await call(`/integrations/${hook.id}`, { method: 'DELETE', token: laura.token })).status).toBe(403);
    expect((await call(`/integrations/${hook.id}`, { method: 'DELETE', token: danny.token })).status).toBe(200);
    expect((await raw(`/api/hooks/${hook.id}`, { token: r.json.token, body: { text: 'x' } })).status).toBe(401);
    const c = await conv(pedro.token, group);
    expect(c.memberIds).not.toContain(bot);
    // El asunto sigue ahí.
    expect((await call(`/issues/${issueId}`, { token: pedro.token })).status).toBe(200);
  });
});
