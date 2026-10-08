/**
 * La IA escucha el tablero (llamada con Lorena, 7-oct): el agente recibe task.assigned cuando se la asignan, toma la
 * tarjeta y la deja por revisar; la persona pide corrección → task.changes_requested; comenta → task.commented;
 * aprueba → task.approved. Lo que hace el propio agente no le vuelve a avisar.
 *   set -a; . ./.env; set +a; INTEGRATIONS_ALLOW_LOCAL=true API_URL=http://localhost:3482 npx vitest run test/agent-tasks.test.ts
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { createAgent, deliverAgentEvent, setAgentWebhook } from '../src/modules/agents.ts';

const API = process.env.API_URL ?? 'http://localhost:3482';
const run = randomUUID().slice(0, 8);
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), 'x-forwarded-for': ip() },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const mail = (n: string) => `${n.toLowerCase()}.agenttask.${run}@example.com`;
async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/api/v1/auth/signup', { body: {
    name, email: mail(name), password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}
const mcp = async (token: string, name: string, args: unknown) => {
  const r = await call('/api/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  expect(r.json.result?.isError, JSON.stringify(r.json)).toBeFalsy();
  return r.json.result.structuredContent;
};

const got: any[] = [];
let server: http.Server;
let agentId = '';
/** Lo que haría el worker con los jobs 'agent.deliver' de este agente. */
async function drain() {
  const { rows } = await pool.query(
    `UPDATE jobs SET done_at = now() WHERE kind = 'agent.deliver' AND done_at IS NULL
        AND payload->>'deliveryId' IN (SELECT id::text FROM agent_deliveries WHERE agent_user_id = $1) RETURNING payload`, [agentId]);
  for (const r of rows) await deliverAgentEvent(r.payload.deliveryId);
}
const until = async (type: string, taskId: string, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    await drain();
    const e = got.find((x) => x.type === type && x.task?.id === taskId);
    if (e) return e;
    if (Date.now() > end) throw new Error(`no llegó ${type}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe('la IA escucha el tablero', { timeout: 60_000 }, () => {
  let danny: Awaited<ReturnType<typeof signup>>, lorena: typeof danny, group: string, mcpToken: string, taskId: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    danny = await signup('Danny');
    const inv = await call(`/api/v1/organizations/${danny.orgId}/invitations`, { token: danny.token, body: { email: mail('Lorena'), role: 'member' } });
    lorena = await signup('Lorena', inv.json.token);
    group = (await call('/api/v1/groups', { token: danny.token, body: { name: 'tickets', target: { kind: 'org' }, memberIds: [lorena.id] } })).json.conversationId;
    const a = await createAgent(danny.id, danny.orgId, `ia${run}`, [group]);
    agentId = a.agentId; mcpToken = a.mcpToken!;
    await setAgentWebhook(danny.id, agentId, `http://localhost:${(server.address() as AddressInfo).port}/hook`);
    const t = await call(`/api/v1/conversations/${group}/issues`, { token: lorena.token, body: { title: 'No llega el certificado' } });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    taskId = t.json.id;
  });
  afterAll(() => server?.close());

  it('asignar al agente le avisa task.assigned con cómo trabajarla', async () => {
    await call(`/api/v1/issues/${taskId}`, { method: 'PATCH', token: lorena.token, body: { assigneeIds: [agentId] } });
    const e = await until('task.assigned', taskId);
    expect(e.actor.id).toBe(lorena.id);
    expect(e.task.title).toBe('No llega el certificado');
    expect(e.tools.take.tool).toBe('update_task');
  });

  it('el agente la deja por revisar; la corrección le vuelve con la nota y lo suyo no le avisa', async () => {
    await mcp(mcpToken, 'comment_task', { id: taskId, text: 'Resuelto, te dejo la evidencia' });
    await mcp(mcpToken, 'update_task', { id: taskId, review: 'pending', assignees: [lorena.id] });
    await call(`/api/v1/issues/${taskId}`, { method: 'PATCH', token: lorena.token, body: { review: 'changes', reviewNote: 'Falta actualizar el perfil' } });
    const e = await until('task.changes_requested', taskId);
    expect(e.note).toBe('Falta actualizar el perfil');
    expect(e.task.review).toBe('changes');
    // Devolver: la tarjeta vuelve sola al agente que la dejó por revisar.
    expect(e.task.assigneeIds).toEqual([agentId]);
    expect(got.some((x) => x.type === 'task.commented' && x.actor.id === agentId)).toBe(false);
  });

  it('un comentario de la persona y la aprobación también le llegan', async () => {
    await call(`/api/v1/issues/${taskId}/comments`, { token: lorena.token, body: { body: '¿Le avisaste al estudiante?' } });
    expect((await until('task.commented', taskId)).comment.body).toBe('¿Le avisaste al estudiante?');
    await mcp(mcpToken, 'update_task', { id: taskId, review: 'pending' });
    await call(`/api/v1/issues/${taskId}`, { method: 'PATCH', token: lorena.token, body: { review: 'approved' } });
    expect((await until('task.approved', taskId)).task.review).toBe('approved');
  });

  it('claim_task reserva la tarjeta: otra corrida no la toma y dejarla por revisar la suelta', async () => {
    const t = await call(`/api/v1/conversations/${group}/issues`, { token: lorena.token, body: { title: 'Reserva', assigneeIds: [agentId] } });
    const other = await createAgent(danny.id, danny.orgId, `ib${run}`, [group]);
    const claimed = await mcp(mcpToken, 'claim_task', { id: t.json.id, minutes: 10 });
    expect(claimed.task.status).toBe('in_progress');
    expect(claimed.task.claimedBy).toMatch(/\(tú\)$/);
    const r = await call('/api/mcp', { token: other.mcpToken!, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'claim_task', arguments: { id: t.json.id } } } });
    expect(r.json.result.structuredContent.error.code).toBe('task_claimed');
    await mcp(mcpToken, 'update_task', { id: t.json.id, review: 'pending', assignees: [lorena.id] });
    expect((await mcp(mcpToken, 'get_task', { id: t.json.id })).task.claimedBy).toBeUndefined();
  });

  it('open_task_chat abre (y reutiliza) el chat de la tarea y lo que escriben ahí le llega al agente', async () => {
    const first = await mcp(mcpToken, 'open_task_chat', { id: taskId, people: [lorena.id] });
    expect(first.created).toBe(true);
    const again = await mcp(mcpToken, 'open_task_chat', { id: taskId, people: [lorena.id] });
    expect(again).toEqual({ chat: first.chat, created: false });
    await call(`/api/v1/conversations/${first.chat}/messages`, { token: lorena.token, body: { clientMessageId: randomUUID(), body: 'Revisa también el perfil' } });
    const end = Date.now() + 20_000;
    let e: any;
    while (!(e = got.find((x) => x.type === 'message.created' && x.conversation?.taskId === taskId)) && Date.now() < end) { await drain(); await new Promise((r) => setTimeout(r, 200)); }
    expect(e?.message.body).toBe('Revisa también el perfil');
  });
});
