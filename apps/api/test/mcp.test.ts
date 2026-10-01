/**
 * Conector MCP: tokens personales y herramientas (leer, enviar, buscar) con los permisos de la persona.
 * Necesita el API (API_URL).
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
  return { status: res.status, headers: res.headers, json: (await res.json().catch(() => ({}))) as any };
}
const mail = (name: string) => `${name.toLowerCase()}.mcp.${run}@example.com`;
async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/api/v1/auth/signup', { body: {
    name, ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }), email: mail(name),
    password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}
let rpcId = 0;
const rpc = (token: string, method: string, params?: unknown) => call('/api/mcp', { token, body: { jsonrpc: '2.0', id: ++rpcId, method, params } });
const tool = async (token: string, name: string, args: unknown = {}) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  expect(r.status).toBe(200);
  return r.json.result as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
};

describe('conector MCP', () => {
  let danny: Awaited<ReturnType<typeof signup>>, laura: typeof danny, externo: typeof danny, mcpDanny: string, mcpExterno: string;
  beforeAll(async () => {
    danny = await signup('Danny');
    const inv = await call(`/api/v1/organizations/${danny.orgId}/invitations`, { token: danny.token, body: { email: mail('Laura'), role: 'member' } });
    laura = await signup('Laura', inv.json.token);
    externo = await signup('Externo');
    const t = await call('/api/v1/me/mcp-tokens', { token: danny.token, body: { name: 'Claude Code' } });
    expect(t.status).toBe(200);
    expect(t.json.token).toMatch(/^chgmcp_/);
    mcpDanny = t.json.token;
    mcpExterno = (await call('/api/v1/me/mcp-tokens', { token: externo.token, body: {} })).json.token;
  });

  it('sin token o con un token de sesión responde 401', async () => {
    expect((await call('/api/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(401);
    const r = await rpc(danny.token, 'ping');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('initialize, notificación y tools/list', async () => {
    const i = await rpc(mcpDanny, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } });
    expect(i.json.result.protocolVersion).toBe('2025-06-18');
    expect(i.json.result.serverInfo.name).toBe('chaggu');
    const n = await call('/api/mcp', { token: mcpDanny, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    expect(n.status).toBe(202);
    const l = await rpc(mcpDanny, 'tools/list');
    const names = l.json.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['whoami', 'list_chats', 'read_messages', 'send_message', 'send_direct_message', 'search_messages', 'unread_summary', 'mark_read', 'list_people']));
    expect(l.json.result.tools.find((t: any) => t.name === 'send_message').inputSchema.required).toContain('text');
  });

  it('envía un directo por nombre, Laura lo ve sin leer y lo lee por MCP', async () => {
    const s = await tool(mcpDanny, 'send_direct_message', { person: 'laura', text: `hola desde la IA ${run}` });
    expect(s.isError).toBeFalsy();
    expect(s.structuredContent.to).toBe('Laura');
    const mcpLaura = (await call('/api/v1/me/mcp-tokens', { token: laura.token, body: {} })).json.token;
    const u = await tool(mcpLaura, 'unread_summary');
    const chat = u.structuredContent.chats.find((c: any) => c.name === 'Danny');
    expect(chat.messages.at(-1).text).toBe(`hola desde la IA ${run}`);
    const r = await tool(mcpLaura, 'read_messages', { chat: 'Danny', mark_as_read: true });
    expect(r.structuredContent.messages.at(-1).author).toBe('Danny');
    const reply = await tool(mcpLaura, 'send_message', { chat: chat.id, text: 'recibido', reply_to: r.structuredContent.messages.at(-1).id });
    expect(reply.isError).toBeFalsy();
    expect((await tool(mcpLaura, 'list_chats', { unread_only: true })).structuredContent.chats.find((c: any) => c.id === chat.id)).toBeUndefined();
    const found = await tool(mcpDanny, 'search_messages', { query: 'recibido' });
    expect(found.structuredContent.results[0].message.author).toBe('Laura');
  });

  it('no escribe ni lee fuera de su alcance', async () => {
    const s = await tool(mcpExterno, 'send_direct_message', { person: laura.id, text: 'hola' });
    expect(s.isError).toBe(true);
    const dannyChats = (await tool(mcpDanny, 'list_chats')).structuredContent.chats;
    const r = await tool(mcpExterno, 'read_messages', { chat: dannyChats[0].id });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain(run);
  });

  it('un token revocado deja de servir', async () => {
    const t = await call('/api/v1/me/mcp-tokens', { token: danny.token, body: { name: 'temporal' } });
    expect((await rpc(t.json.token, 'ping')).status).toBe(200);
    const list = await call('/api/v1/me/mcp-tokens', { token: danny.token });
    expect(JSON.stringify(list.json)).not.toContain(t.json.token);
    expect((await call(`/api/v1/me/mcp-tokens/${t.json.id}`, { method: 'DELETE', token: danny.token })).status).toBe(200);
    expect((await rpc(t.json.token, 'ping')).status).toBe(401);
  });
});
