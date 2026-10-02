/**
 * Pantalla «Agentes»: alta desde la web (solo administración), lista con grupos y tareas visibles, token que
 * sirve en el MCP, rotación y apagado (administración o dueño). Necesita el API (API_URL).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const mail = (name: string) => `${name.toLowerCase()}.agents.${run}@example.com`;
async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/api/v1/auth/signup', { body: {
    name, ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }), email: mail(name),
    password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}
const whoami = (token: string) => call('/api/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } } });

describe('pantalla Agentes', () => {
  let danny: Awaited<ReturnType<typeof signup>>, laura: typeof danny, externo: typeof danny;
  let groupId: string, secretGroupId: string, agentId: string, agentToken: string;
  beforeAll(async () => {
    danny = await signup('Danny');
    const inv = await call(`/api/v1/organizations/${danny.orgId}/invitations`, { token: danny.token, body: { email: mail('Laura'), role: 'member' } });
    laura = await signup('Laura', inv.json.token);
    externo = await signup('Externo');
    groupId = (await call('/api/v1/groups', { token: danny.token, body: { name: `tickets ${run}`, target: { kind: 'org' }, memberIds: [laura.id] } })).json.conversationId;
    secretGroupId = (await call('/api/v1/groups', { token: danny.token, body: { name: `solo danny ${run}`, target: { kind: 'org' }, memberIds: [] } })).json.conversationId;
    expect(groupId).toBeTruthy();
    expect(secretGroupId).toBeTruthy();
  });

  it('solo la administración crea; el token entra al MCP como el agente', async () => {
    expect((await call(`/api/v1/organizations/${danny.orgId}/agents`, { token: laura.token, body: { name: 'pirata' } })).status).toBe(403);
    const r = await call(`/api/v1/organizations/${danny.orgId}/agents`, { token: danny.token, body: { name: '@claude', title: 'Soporte', conversationIds: [groupId, secretGroupId] } });
    expect(r.status).toBe(200);
    expect(r.json.name).toBe('claude');
    expect(r.json.groups.every((g: any) => g.ok)).toBe(true);
    expect(r.json.token).toMatch(/^chgmcp_/);
    agentId = r.json.agentId; agentToken = r.json.token;
    const w = await whoami(agentToken);
    expect(w.json.result.structuredContent.name).toBe('claude');
    expect((await call(`/api/v1/organizations/${danny.orgId}/agents`, { token: danny.token, body: { name: 'Claude' } })).status).toBe(400);
    expect((await call(`/api/v1/organizations/${danny.orgId}/agents`, { token: danny.token, body: { name: 'Laura' } })).status).toBe(400);
  });

  it('la lista muestra dueño, grupos y tareas que quien mira puede ver', async () => {
    const issue = await call(`/api/v1/conversations/${groupId}/issues`, { token: danny.token, body: { title: `Ticket ${run}`, assigneeIds: [agentId] } });
    expect(issue.status).toBe(200);
    const mine = (await call(`/api/v1/organizations/${danny.orgId}/agents`, { token: danny.token })).json;
    expect(mine.canCreate).toBe(true);
    const a = mine.agents.find((x: any) => x.id === agentId);
    expect(a.owner.id).toBe(danny.id);
    expect(a.title).toBe('Soporte');
    expect(a.connected).toBe(true);
    expect(a.lastUsedAt).toBeTruthy();
    expect(a.groups.map((g: any) => g.id).sort()).toEqual([groupId, secretGroupId].sort());
    expect(a.tasks.open).toBe(1);
    expect(a.tasks.recent[0].title).toBe(`Ticket ${run}`);
    expect(a.canManage).toBe(true);
    // Laura no está en el grupo privado de Danny: no lo ve por nombre, solo cuenta.
    const hers = (await call(`/api/v1/organizations/${danny.orgId}/agents`, { token: laura.token })).json;
    const b = hers.agents.find((x: any) => x.id === agentId);
    expect(hers.canCreate).toBe(false);
    expect(b.groups.map((g: any) => g.id)).toEqual([groupId]);
    expect(b.hiddenGroups).toBe(1);
    expect(b.canManage).toBe(false);
    expect((await call(`/api/v1/organizations/${danny.orgId}/agents`, { token: externo.token })).status).toBe(404);
  });

  it('rotar invalida el token anterior; apagar lo saca de la lista', async () => {
    expect((await call(`/api/v1/organizations/${danny.orgId}/agents/${agentId}/token`, { token: laura.token, body: {} })).status).toBe(403);
    const r = await call(`/api/v1/organizations/${danny.orgId}/agents/${agentId}/token`, { token: danny.token, body: {} });
    expect(r.status).toBe(200);
    expect((await whoami(agentToken)).status).toBe(401);
    expect((await whoami(r.json.token)).status).toBe(200);
    expect((await call(`/api/v1/organizations/${danny.orgId}/agents/${agentId}`, { method: 'DELETE', token: laura.token })).status).toBe(403);
    expect((await call(`/api/v1/organizations/${danny.orgId}/agents/${agentId}`, { method: 'DELETE', token: danny.token })).status).toBe(200);
    expect((await whoami(r.json.token)).status).toBe(401);
    const after = (await call(`/api/v1/organizations/${danny.orgId}/agents`, { token: danny.token })).json;
    expect(after.agents.some((x: any) => x.id === agentId)).toBe(false);
  });
});
