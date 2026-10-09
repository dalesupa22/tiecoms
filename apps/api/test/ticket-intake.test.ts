/**
 * Al llegar un ticket (pedido de Danny 9-oct): manual por defecto (llega sin responsable y una persona decide si se lo
 * pasa a la IA) o automático por grupo (se asigna solo a una persona o agente, en su estado y con sus valores).
 *   set -a; . ./.env; set +a; INTEGRATIONS_ALLOW_LOCAL=true API_URL=http://localhost:3482 npx vitest run test/ticket-intake.test.ts
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { createAgent, deliverAgentEvent, setAgentWebhook } from '../src/modules/agents.ts';

const API = process.env.API_URL ?? 'http://localhost:3482';
const run = randomUUID().slice(0, 8);
async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const mail = (n: string) => `${n.toLowerCase()}.intake.${run}@example.com`;
async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/api/v1/auth/signup', { body: {
    name, ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }), email: mail(name),
    password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}
let rpc = 0;
const tool = async (token: string, name: string, args: unknown = {}) => {
  const r = await call('/api/mcp', { token, body: { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } } });
  expect(r.status).toBe(200);
  return r.json.result as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
};

const got: any[] = [];
let server: http.Server;
let agentId = '';
async function drain() {
  const { rows } = await pool.query(
    `UPDATE jobs SET done_at = now() WHERE kind = 'agent.deliver' AND done_at IS NULL
        AND payload->>'deliveryId' IN (SELECT id::text FROM agent_deliveries WHERE agent_user_id = $1) RETURNING payload`, [agentId]);
  for (const r of rows) await deliverAgentEvent(r.payload.deliveryId);
}

describe('al llegar un ticket', { timeout: 60_000 }, () => {
  let danny: Awaited<ReturnType<typeof signup>>, lorena: typeof danny, group: string, hook: string, agentMcp: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    danny = await signup('Danny');
    const inv = await call(`/api/v1/organizations/${danny.orgId}/invitations`, { token: danny.token, body: { email: mail('Lorena'), role: 'member' } });
    lorena = await signup('Lorena', inv.json.token);
    group = (await call('/api/v1/groups', { token: danny.token, body: { name: 'tickets-rosario', target: { kind: 'org' }, memberIds: [lorena.id] } })).json.conversationId;
    const a = await createAgent(danny.id, danny.orgId, `xf${run}`, [group]);
    agentId = a.agentId; agentMcp = a.mcpToken!;
    await setAgentWebhook(danny.id, agentId, `http://localhost:${(server.address() as AddressInfo).port}/hook`);
    const i = await call(`/api/v1/conversations/${group}/integrations`, { token: danny.token, body: { name: 'Mesa de ayuda' } });
    hook = new URL(i.json.webhookUrlWithToken).pathname;
    await call(`/api/v1/conversations/${group}/task-columns`, { method: 'PUT', token: danny.token, body: { columns: [{ name: 'Estado', type: 'select', options: ['Ticket nuevo', 'En testing', 'Verificado'] }] } });
  });
  afterAll(() => server?.close());

  it('manual por defecto: llega sin responsable, avisa al grupo y la persona se lo pasa a la IA', async () => {
    expect((await call(`/api/v1/conversations/${group}/ticket-intake`, { token: lorena.token })).json).toEqual({ intake: null, canEdit: false });
    const r = await call(`${hook}/tasks`, { body: { title: 'No carga el certificado', externalId: `M-${run}` } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.issue.assigneeIds ?? []).toEqual([]);
    expect(r.json.issue.status).toBe('open');
    const inbox = (await call('/api/v1/issues/inbox', { token: lorena.token })).json.items;
    expect(inbox.some((x: any) => x.issueId === r.json.issue.id && x.reason === 'ticket')).toBe(true);
    // Lorena decide: «Pasar a la IA».
    const p = await call(`/api/v1/issues/${r.json.issue.id}`, { method: 'PATCH', token: lorena.token, body: { assigneeIds: [agentId] } });
    expect(p.json.assigneeIds).toEqual([agentId]);
    await drain();
    expect(got.some((e) => e.type === 'task.assigned' && e.task?.id === r.json.issue.id)).toBe(true);
  });

  it('solo quien administra el grupo la cambia, y quien recibe debe estar en el grupo', async () => {
    expect((await call(`/api/v1/conversations/${group}/ticket-intake`, { method: 'PUT', token: lorena.token, body: { intake: { assigneeIds: [agentId] } } })).status).toBe(403);
    const outsider = await signup('Externo');
    expect((await call(`/api/v1/conversations/${group}/ticket-intake`, { method: 'PUT', token: danny.token, body: { intake: { assigneeIds: [outsider.id] } } })).status).toBe(400);
    expect((await call(`/api/v1/conversations/${group}/ticket-intake`, { method: 'PUT', token: danny.token, body: { intake: { assigneeIds: [agentId], fields: { Estado: 'Inventado' } } } })).status).toBe(400);
  });

  it('automático: apenas llega queda asignado al agente, en su estado y con «Estado: Ticket nuevo»; el agente se entera', async () => {
    const put = await call(`/api/v1/conversations/${group}/ticket-intake`, { method: 'PUT', token: danny.token, body: { intake: { assigneeIds: [agentId], status: 'open', fields: { estado: 'ticket nuevo' } } } });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json.intake).toEqual({ assigneeIds: [agentId], status: 'open', fields: { Estado: 'Ticket nuevo' } });
    const r = await call(`${hook}/tasks`, { body: { title: 'Falla la firma', externalId: `A-${run}` } });
    expect(r.json.issue.assigneeIds).toEqual([agentId]);
    expect(r.json.issue.fields).toEqual({ Estado: 'Ticket nuevo' });
    expect(r.json.issue.status).toBe('open');
    // Nadie más recibe «Llegó un ticket»: ya tiene responsable.
    const inbox = (await call('/api/v1/issues/inbox', { token: lorena.token })).json.items;
    expect(inbox.some((x: any) => x.issueId === r.json.issue.id)).toBe(false);
    await drain();
    expect(got.some((e) => e.type === 'task.assigned' && e.task?.id === r.json.issue.id)).toBe(true);
    // El agente la ve en sus tareas con el nombre claro del estado.
    const l = await tool(agentMcp, 'list_tasks', { mine: true });
    const mine = l.structuredContent.tasks.find((x: any) => x.id === r.json.issue.id);
    expect(mine.stateLabel).toBe('Asignada a la IA · por empezar');
    // Lo que manda la integración gana sobre la regla.
    const own = await call(`${hook}/tasks`, { body: { title: 'Con responsable', externalId: `B-${run}`, assigneeEmails: [mail('Lorena')], fields: { Estado: 'En testing' } } });
    expect(own.json.issue.assigneeIds).toEqual([lorena.id]);
    expect(own.json.issue.fields).toEqual({ Estado: 'En testing' });
  });

  it('a una persona y en proceso; si sale del grupo vuelve a manual', async () => {
    await call(`/api/v1/conversations/${group}/ticket-intake`, { method: 'PUT', token: danny.token, body: { intake: { assigneeIds: [lorena.id], status: 'in_progress' } } });
    const r = await call(`${hook}/tasks`, { body: { title: 'Revisar plantilla', externalId: `C-${run}` } });
    expect(r.json.issue.assigneeIds).toEqual([lorena.id]);
    expect(r.json.issue.status).toBe('in_progress');
    await pool.query('UPDATE conversation_memberships SET removed_at = now() WHERE conversation_id = $1 AND user_id = $2', [group, lorena.id]);
    const r2 = await call(`${hook}/tasks`, { body: { title: 'Sin quién', externalId: `D-${run}` } });
    expect(r2.json.issue.assigneeIds ?? []).toEqual([]);
    expect(r2.json.issue.status).toBe('open');
    await pool.query('UPDATE conversation_memberships SET removed_at = NULL WHERE conversation_id = $1 AND user_id = $2', [group, lorena.id]);
  });

  it('corrección y «Aprobar y desplegar»: vuelve a la IA, la toma, despliega y la deja otra vez por revisar', async () => {
    const t = (await call(`/api/v1/conversations/${group}/issues`, { token: lorena.token, body: { title: 'Ajustar el flujo de becas', assigneeIds: [agentId] } })).json;
    const lab = async () => (await tool(agentMcp, 'get_task', { id: t.id })).structuredContent.task.stateLabel;
    // La IA lo resuelve y lo deja por revisar con el plan de despliegue.
    let u = await tool(agentMcp, 'update_task', { id: t.id, review: 'pending', assignees: [lorena.id], review_note: 'Requiere despliegue: rama x' });
    expect(u.isError, u.content?.[0]?.text).toBeFalsy();
    expect(await lab()).toBe('Revisión de Lorena');
    // Lorena pide corrección: vuelve a la IA.
    await call(`/api/v1/issues/${t.id}`, { method: 'PATCH', token: lorena.token, body: { review: 'changes', reviewNote: 'Falta el correo' } });
    expect(await lab()).toBe('Corrección pedida a la IA');
    u = await tool(agentMcp, 'update_task', { id: t.id, review: 'pending', assignees: [lorena.id], review_note: 'Corregido. Requiere despliegue' });
    // Aprueba y pide desplegar: vuelve sola al agente, sin cerrarse, y le llega task.deploy_approved.
    const d = await call(`/api/v1/issues/${t.id}`, { method: 'PATCH', token: lorena.token, body: { review: 'deploy', reviewNote: 'Dale' } });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json.assigneeIds).toEqual([agentId]);
    expect(d.json.status).not.toBe('done');
    expect(await lab()).toBe('Aprobada · la IA despliega');
    await drain();
    expect(got.some((e) => e.type === 'task.deploy_approved' && e.task?.id === t.id && e.note === 'Dale')).toBe(true);
    const c = await tool(agentMcp, 'claim_task', { id: t.id });
    expect(c.isError, c.content?.[0]?.text).toBeFalsy();
    expect(await lab()).toBe('La IA está desplegando');
    u = await tool(agentMcp, 'update_task', { id: t.id, review: 'pending', assignees: [lorena.id], review_note: 'Desplegado: verifica' });
    expect(u.structuredContent.task.review).toBe('pending');
    expect(u.structuredContent.task.claimedBy).toBeUndefined();
    const fin = await call(`/api/v1/issues/${t.id}`, { method: 'PATCH', token: lorena.token, body: { review: 'approved' } });
    expect(fin.json.status).toBe('done');
  });

  it('el MCP la consulta y la cambia por nombre', async () => {
    const mcp = (await call('/api/v1/me/mcp-tokens', { token: danny.token, body: { name: 'Claude' } })).json.token;
    const s = await tool(mcp, 'set_ticket_intake', { chat: group, mode: 'auto', assignees: [`xf${run}`], fields: { Estado: 'Ticket nuevo' } });
    expect(s.isError, s.content?.[0]?.text).toBeFalsy();
    expect(s.structuredContent.intake.assigneeIds).toEqual([agentId]);
    const g = await tool(mcp, 'get_ticket_intake', { chat: group });
    expect(g.structuredContent).toMatchObject({ mode: 'auto', status: 'open', fields: { Estado: 'Ticket nuevo' }, canEdit: true });
    const m = await tool(mcp, 'set_ticket_intake', { chat: group, mode: 'manual' });
    expect(m.structuredContent).toEqual({ mode: 'manual', intake: null });
  });
});
