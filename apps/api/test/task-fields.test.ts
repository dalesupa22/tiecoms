/**
 * Campos dinámicos de las tareas y webhook de tareas por grupo (docs/TAREAS-CAMPOS.md).
 * Necesita el API (API_URL).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);

async function call(path: string, opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const mail = (name: string) => `${name.toLowerCase()}.campos.${run}@example.com`;
async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/api/v1/auth/signup', { body: {
    name, ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }), email: mail(name),
    password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}
let rpcId = 0;
const tool = async (token: string, name: string, args: unknown = {}) => {
  const r = await call('/api/mcp', { token, body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } } });
  expect(r.status).toBe(200);
  return r.json.result as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
};

describe('campos dinámicos y webhook de tareas', () => {
  let danny: Awaited<ReturnType<typeof signup>>, laura: typeof danny, group: string, hookUrl: string, hookId: string, token: string;
  beforeAll(async () => {
    danny = await signup('Danny');
    const inv = await call(`/api/v1/organizations/${danny.orgId}/invitations`, { token: danny.token, body: { email: mail('Laura'), role: 'member' } });
    laura = await signup('Laura', inv.json.token);
    const g = await call('/api/v1/groups', { token: danny.token, body: { name: 'xertiflow-dev', target: { kind: 'org' }, memberIds: [laura.id] } });
    expect(g.status).toBe(200);
    group = g.json.conversationId;
    const i = await call(`/api/v1/conversations/${group}/integrations`, { token: danny.token, body: { name: 'Xertiflow' } });
    expect(i.status).toBe(200);
    hookUrl = i.json.webhookUrlWithToken; hookId = i.json.integration.id; token = i.json.token;
  });

  it('el webhook de tareas crea una tarea con campos, responsable por correo y aviso en el chat', async () => {
    const path = new URL(hookUrl).pathname;
    const r = await call(`${path}/tasks`, { body: {
      title: 'No pude emitir el certificado', description: 'Falta implementar estos servicios.',
      fields: { Resultado: 'No pudo', Servicios: 'firma-otp, reportes-pdf', Intentos: 3, Bloqueante: true, Vacio: null },
      assigneeEmails: [mail('Laura'), 'nadie@example.com'], dueDate: '2026-10-09', status: 'waiting',
      cualquierOtraCosa: 'se ignora',
    } });
    expect(r.status).toBe(200);
    expect(r.json.created).toBe(true);
    expect(r.json.ignoredAssignees).toEqual(['nadie@example.com']);
    const t = r.json.issue;
    expect(t.fields).toEqual({ Resultado: 'No pudo', Servicios: 'firma-otp, reportes-pdf', Intentos: 3, Bloqueante: true });
    expect(t.assigneeIds).toEqual([laura.id]);
    expect(t.status).toBe('waiting');
    expect(t.dueDate).toBe('2026-10-09');
    const detail = await call(`/api/v1/issues/${t.id}`, { token: laura.token });
    expect(detail.json.issue.fields.Servicios).toBe('firma-otp, reportes-pdf');
    expect(detail.json.events.some((e: any) => e.kind === 'comment' && e.payload.body === 'Falta implementar estos servicios.')).toBe(true);
    const msgs = (await call(`/api/v1/conversations/${group}/messages?limit=20`, { token: laura.token })).json.messages;
    expect(msgs.some((m: any) => m.kind === 'text' && m.body.includes('Resultado: No pudo') && m.body.includes('Bloqueante: sí'))).toBe(true);
  });

  it('con Bearer y con Idempotency-Key no se duplica; con externalId devuelve la misma', async () => {
    const a = await call(`/api/hooks/${hookId}/tasks`, { token, headers: { 'idempotency-key': `k-${run}` }, body: { title: 'Reintento', text: 'cuerpo' } });
    const b = await call(`/api/hooks/${hookId}/tasks`, { token, headers: { 'idempotency-key': `k-${run}` }, body: { title: 'Reintento', text: 'cuerpo' } });
    expect(a.status).toBe(200);
    expect(b.json.issue.id).toBe(a.json.issue.id);
    const c = await call(`/api/hooks/${hookId}/tasks`, { token, body: { title: 'Ticket', externalId: 'XF-1', fields: { Ambiente: 'dev' } } });
    const d = await call(`/api/hooks/${hookId}/tasks`, { token, body: { title: 'Ticket', externalId: 'XF-1' } });
    expect(d.json.created).toBe(false);
    expect(d.json.issue.id).toBe(c.json.issue.id);
    // Token equivocado.
    expect((await call(`/api/hooks/${hookId}/chg_malo/tasks`, { body: { title: 'x x' } })).status).toBe(401);
    // La API de integraciones mezcla campos (null borra).
    const p = await call(`/api/integration/v1/issues/${c.json.issue.id}`, { method: 'PATCH', token, body: { fields: { Ambiente: null, Versión: '1.2' } } });
    expect(p.status).toBe(200);
    expect(p.json.issue.fields).toEqual({ 'Versión': '1.2' });
  });

  it('una persona edita los campos (se mezclan y quedan en el historial)', async () => {
    const t = (await call(`/api/v1/conversations/${group}/issues`, { token: danny.token, body: { title: 'Manual', fields: { Cliente: 'URosario' } } })).json;
    expect(t.fields).toEqual({ Cliente: 'URosario' });
    const u = await call(`/api/v1/issues/${t.id}`, { method: 'PATCH', token: laura.token, body: { fields: { Prioridad: 2, Cliente: '' } } });
    expect(u.status).toBe(200);
    expect(u.json.fields).toEqual({ Prioridad: 2 });
    const ev = (await call(`/api/v1/issues/${t.id}`, { token: danny.token })).json.events.find((e: any) => e.kind === 'fields');
    expect(ev.payload).toEqual({ changed: ['Prioridad'], removed: ['Cliente'] });
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, k) => [`c${k}`, 'v']));
    expect((await call(`/api/v1/issues/${t.id}`, { method: 'PATCH', token: laura.token, body: { fields: many } })).status).toBe(400);
  });

  it('el MCP crea, filtra y cambia campos', async () => {
    const mcp = (await call('/api/v1/me/mcp-tokens', { token: danny.token, body: { name: 'Claude' } })).json.token;
    const c = await tool(mcp, 'create_task', { chat: group, title: 'Desde Claude', description: 'detalle', fields: { Resultado: 'No pudo', Servicio: 'notificaciones' } });
    expect(c.isError).toBeFalsy();
    const id = c.structuredContent.task.id;
    expect(c.structuredContent.task.fields).toEqual({ Resultado: 'No pudo', Servicio: 'notificaciones' });
    const l = await tool(mcp, 'list_tasks', { chat: group, field: 'resultado', field_value: 'no pudo' });
    expect(l.structuredContent.tasks.map((x: any) => x.title).sort()).toEqual(['Desde Claude', 'No pude emitir el certificado']);
    expect(l.structuredContent.columns).toContain('Servicios');
    const u = await tool(mcp, 'update_task', { id, fields: { Resultado: 'Hecho', Servicio: null } });
    expect(u.structuredContent.task.fields).toEqual({ Resultado: 'Hecho' });
  });

  it('columnas del grupo: lista desplegable que solo acepta sus opciones (web, webhook y MCP)', async () => {
    const cols = { columns: [{ name: 'Tipo', type: 'select', options: ['Bug', 'Funcionalidad nueva', 'Mejora'] }, { name: 'Puntos', type: 'number' }] };
    expect((await call(`/api/v1/conversations/${group}/task-columns`, { method: 'PUT', token: laura.token, body: cols })).status).toBe(403);
    const put = await call(`/api/v1/conversations/${group}/task-columns`, { method: 'PUT', token: danny.token, body: cols });
    expect(put.status).toBe(200);
    expect((await call(`/api/v1/conversations/${group}/task-columns`, { token: laura.token })).json).toEqual({ columns: cols.columns, canEdit: false });
    const path = new URL(hookUrl).pathname;
    const ok = await call(`${path}/tasks`, { body: { title: 'Falla el login', fields: { tipo: 'bug', Puntos: '3' } } });
    expect(ok.status).toBe(200);
    expect(ok.json.issue.fields).toEqual({ Tipo: 'Bug', Puntos: 3 });
    const bad = await call(`${path}/tasks`, { body: { title: 'Otra', fields: { Tipo: 'Urgente' } } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain('Funcionalidad nueva');
    const u = await call(`/api/v1/issues/${ok.json.issue.id}`, { method: 'PATCH', token: laura.token, body: { fields: { Tipo: 'Mejora' } } });
    expect(u.json.fields.Tipo).toBe('Mejora');
    const mcp = (await call('/api/v1/me/mcp-tokens', { token: danny.token, body: { name: 'Claude 2' } })).json.token;
    const g = await tool(mcp, 'get_task_columns', { chat: group });
    expect(g.structuredContent.columns[0].options).toContain('Mejora');
    const s2 = await tool(mcp, 'set_task_columns', { chat: group, columns: [...cols.columns, { name: 'Ambiente', type: 'select', options: ['dev', 'prod'] }] });
    expect(s2.structuredContent.columns).toHaveLength(3);
  });
});
