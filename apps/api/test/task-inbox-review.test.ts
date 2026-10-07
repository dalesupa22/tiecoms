/**
 * Llamada con Lorena (7-oct-2026): las tareas que llegan quedan en «Nuevas» hasta verlas, y la revisión humana
 * (la IA deja el ticket por revisar; la persona aprueba, pide corrección o marca intervención humana). Necesita el API.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
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
async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/api/v1/auth/signup', { body: {
    name, ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }), email: `${name.toLowerCase()}.inbox.${run}@example.com`,
    password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}
const mcp = async (token: string, name: string, args: unknown) => {
  const r = await call('/api/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  return r.json.result;
};

describe('bandeja de tareas y revisión humana', () => {
  let ia: Awaited<ReturnType<typeof signup>>, lorena: typeof ia, extra: typeof ia, chatId: string, taskId: string;
  beforeAll(async () => {
    ia = await signup('Ia');
    lorena = await signup('Lorena', (await call(`/api/v1/organizations/${ia.orgId}/invitations`, { token: ia.token, body: {} })).json.token);
    extra = await signup('Extra');
    chatId = (await call('/api/v1/chats', { token: ia.token, body: { userIds: [lorena.id], name: 'Tickets' } })).json.id;
  });

  it('una tarea asignada llega a «Nuevas» de la responsable, no a quien la creó ni a extraños', async () => {
    const r = await call(`/api/v1/conversations/${chatId}/issues`, { token: ia.token, body: { title: 'Ticket: cambiar logo', assigneeIds: [lorena.id] } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    taskId = r.json.id;
    const inbox = (await call('/api/v1/issues/inbox', { token: lorena.token })).json.items;
    expect(inbox).toEqual([expect.objectContaining({ issueId: taskId, reason: 'assigned', actorId: ia.id })]);
    expect((await call('/api/v1/issues/inbox', { token: ia.token })).json.items).toHaveLength(0);
    expect((await call('/api/v1/issues/inbox', { token: extra.token })).json.items).toHaveLength(0);
    expect((await call('/api/v1/issues/inbox/seen', { token: lorena.token, body: { issueIds: [taskId] } })).status).toBe(200);
    expect((await call('/api/v1/issues/inbox', { token: lorena.token })).json.items).toHaveLength(0);
  });

  it('la IA la deja por revisar (MCP); Lorena la ve en «Nuevas» y en list_tasks review=pending', async () => {
    const tIa = (await call('/api/v1/me/mcp-tokens', { token: ia.token, body: {} })).json.token;
    const up = await mcp(tIa, 'update_task', { id: taskId, review: 'pending', review_note: 'Hecho: logo cambiado, evidencia adjunta' });
    expect(up.isError, JSON.stringify(up)).toBeFalsy();
    expect(up.structuredContent.task.review).toBe('pending');
    const inbox = (await call('/api/v1/issues/inbox', { token: lorena.token })).json.items;
    expect(inbox[0]).toMatchObject({ issueId: taskId, reason: 'review' });
    const tLo = (await call('/api/v1/me/mcp-tokens', { token: lorena.token, body: {} })).json.token;
    const pend = await mcp(tLo, 'list_tasks', { review: 'pending' });
    expect(pend.structuredContent.tasks.map((t: any) => t.id)).toEqual([taskId]);
    const box = await mcp(tLo, 'list_task_inbox', { mark_seen: true });
    expect(box.structuredContent.items[0]).toMatchObject({ reason: 'review' });
    expect((await call('/api/v1/issues/inbox', { token: lorena.token })).json.items).toHaveLength(0);
  });

  it('Lorena pide corrección con comentario: la IA lo recibe y queda en el historial', async () => {
    const r = await call(`/api/v1/issues/${taskId}`, { method: 'PATCH', token: lorena.token, body: { review: 'changes', reviewNote: 'El logo quedó pixelado' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ review: 'changes', reviewBy: lorena.id });
    expect((await call('/api/v1/issues/inbox', { token: ia.token })).json.items[0]).toMatchObject({ issueId: taskId, reason: 'reviewed', actorId: lorena.id });
    const detail = (await call(`/api/v1/issues/${taskId}`, { token: ia.token })).json;
    expect(detail.events.some((e: any) => e.kind === 'comment' && e.payload.body === 'El logo quedó pixelado')).toBe(true);
    expect(detail.events.some((e: any) => e.kind === 'review' && e.payload.to === 'changes')).toBe(true);
    // Una nota sin cambio de revisión no se acepta.
    expect((await call(`/api/v1/issues/${taskId}`, { method: 'PATCH', token: lorena.token, body: { reviewNote: 'hola' } })).status).toBe(400);
  });

  it('aprobar o marcar intervención humana; quitar la revisión la deja como antes', async () => {
    expect((await call(`/api/v1/issues/${taskId}`, { method: 'PATCH', token: lorena.token, body: { review: 'human' } })).json.review).toBe('human');
    expect((await call(`/api/v1/issues/${taskId}`, { method: 'PATCH', token: lorena.token, body: { review: 'approved' } })).json.review).toBe('approved');
    const cleared = (await call(`/api/v1/issues/${taskId}`, { method: 'PATCH', token: ia.token, body: { review: null } })).json;
    expect(cleared.review).toBeUndefined();
    expect((await call(`/api/v1/issues/${taskId}`, { method: 'PATCH', token: extra.token, body: { review: 'approved' } })).status).toBe(404);
  });
});
