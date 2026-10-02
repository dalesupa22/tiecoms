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

describe('conector MCP: OAuth, tickets y calendario', () => {
  let danny: Awaited<ReturnType<typeof signup>>, laura: typeof danny, externo: typeof danny;
  let tDanny: string, tLaura: string, tExterno: string;
  const verifier = randomUUID() + randomUUID();
  const challenge = (v: string) => import('node:crypto').then((c) => c.createHash('sha256').update(v).digest('base64url'));
  const form = (path: string, body: Record<string, string>) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
    .then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

  async function oauth(user: typeof danny) {
    const reg = await call('/api/mcp/oauth/register', { body: { client_name: 'Claude', redirect_uris: ['http://127.0.0.1:33418/callback'] } });
    expect(reg.status).toBe(201);
    const cid = reg.json.client_id;
    const info = await call(`/api/v1/mcp-oauth/client?client_id=${cid}&redirect_uri=${encodeURIComponent('http://127.0.0.1:33418/callback')}`, { token: user.token });
    expect(info.json.name).toBe('Claude');
    const ok = await call('/api/v1/mcp-oauth/approve', { token: user.token, body: { clientId: cid, redirectUri: 'http://127.0.0.1:33418/callback', codeChallenge: await challenge(verifier), codeChallengeMethod: 'S256', state: 'xyz' } });
    const u = new URL(ok.json.redirect);
    expect(u.searchParams.get('state')).toBe('xyz');
    const code = u.searchParams.get('code')!;
    expect((await form('/api/mcp/oauth/token', { grant_type: 'authorization_code', code, client_id: cid, redirect_uri: 'http://127.0.0.1:33418/callback', code_verifier: 'otro-verificador-que-no-es-el-mismo-de-antes-xx' })).status).toBe(400);
    const tok = await form('/api/mcp/oauth/token', { grant_type: 'authorization_code', code, client_id: cid, redirect_uri: 'http://127.0.0.1:33418/callback', code_verifier: verifier });
    // El intento fallido no gasta el código, pero el éxito sí: reusar el código falla.
    expect(tok.status).toBe(200);
    expect(tok.json.access_token).toMatch(/^chgmcp_/);
    expect((await form('/api/mcp/oauth/token', { grant_type: 'authorization_code', code, client_id: cid, redirect_uri: 'http://127.0.0.1:33418/callback', code_verifier: verifier })).status).toBe(400);
    return { access: tok.json.access_token as string, refresh: tok.json.refresh_token as string, cid };
  }

  beforeAll(async () => {
    danny = await signup('Dan');
    const inv = await call(`/api/v1/organizations/${danny.orgId}/invitations`, { token: danny.token, body: { email: mail('Lau'), role: 'member' } });
    laura = await signup('Lau', inv.json.token);
    externo = await signup('Otro');
    tDanny = (await oauth(danny)).access;
    tLaura = (await oauth(laura)).access;
    tExterno = (await oauth(externo)).access;
  });

  it('descubrimiento y 401 con resource_metadata', async () => {
    const pr = await call('/.well-known/oauth-protected-resource/api/mcp');
    expect(pr.json.resource).toMatch(/\/api\/mcp$/);
    const as = await call('/.well-known/oauth-authorization-server');
    expect(as.json.code_challenge_methods_supported).toEqual(['S256']);
    const r = await call('/api/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect((await call('/api/mcp/oauth/register', { body: { redirect_uris: ['http://evil.example.com/cb'] } })).status).toBe(400);
  });

  it('el token OAuth es de quien aprobó: whoami y refresco', async () => {
    expect((await tool(tDanny, 'whoami')).structuredContent.name).toBe('Dan');
    expect((await tool(tLaura, 'whoami')).structuredContent.name).toBe('Lau');
    const o = await oauth(danny);
    const r = await form('/api/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: o.refresh, client_id: o.cid });
    expect(r.status).toBe(200);
    expect((await rpc(o.access, 'ping')).status).toBe(401);
    expect((await rpc(r.json.access_token, 'ping')).status).toBe(200);
    const list = await call('/api/v1/me/mcp-tokens', { token: danny.token });
    expect(list.json.tokens.some((t: any) => t.oauth && t.name === 'Claude')).toBe(true);
  });

  it('tickets: crear, asignar, cambiar estado, comentar; el externo no los ve', async () => {
    const chat = (await tool(tDanny, 'send_direct_message', { person: 'Lau', text: 'ticket de prueba' })).structuredContent.chatId;
    const t = await tool(tDanny, 'create_task', { chat, title: 'Logos en otro orden', assignees: ['Lau'], due_date: '2026-10-10' });
    expect(t.isError).toBeFalsy();
    const id = t.structuredContent.task.id;
    expect(t.structuredContent.task.assignees).toEqual(['Lau']);
    const mine = await tool(tLaura, 'list_tasks', { mine: true });
    expect(mine.structuredContent.tasks.map((x: any) => x.id)).toContain(id);
    const u = await tool(tLaura, 'update_task', { id, status: 'in_progress', assignees: ['Lau', 'Dan'] });
    expect(u.structuredContent.task.status).toBe('in_progress');
    expect(u.structuredContent.task.assignees).toHaveLength(2);
    expect((await tool(tLaura, 'comment_task', { id, text: 'ya quedó' })).isError).toBeFalsy();
    const d = await tool(tDanny, 'get_task', { id });
    expect(d.structuredContent.activity.some((e: any) => e.text === 'ya quedó')).toBe(true);
    expect((await tool(tExterno, 'get_task', { id })).isError).toBe(true);
    expect((await tool(tExterno, 'update_task', { id, status: 'done' })).isError).toBe(true);
    expect((await tool(tExterno, 'list_tasks')).structuredContent.tasks).toHaveLength(0);
  });

  it('calendario: crear, ver, responder y cancelar; el externo no lo ve', async () => {
    const start = new Date(Date.now() + 2 * 86400_000);
    const ev = await tool(tDanny, 'create_event', { chat: 'Lau', title: 'Revisión logos', starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 1800_000).toISOString(), invitees: ['Lau'] });
    expect(ev.isError).toBeFalsy();
    const id = ev.structuredContent.event.id;
    const agenda = await tool(tLaura, 'list_calendar');
    expect(agenda.structuredContent.events.map((e: any) => e.id)).toContain(id);
    expect((await tool(tLaura, 'rsvp_event', { id, answer: 'yes' })).structuredContent.event.invitees.find((i: any) => i.name === 'Lau (tú)').rsvp).toBe('yes');
    expect((await tool(tExterno, 'list_calendar')).structuredContent.events).toHaveLength(0);
    expect((await tool(tExterno, 'update_event', { id, cancel: true })).isError).toBe(true);
    expect((await tool(tDanny, 'update_event', { id, cancel: true })).structuredContent.event.cancelled).toBe(true);
  });

  it('sin WhatsApp ni correo conectados lo dice, y prompts/list trae responder_cliente', async () => {
    expect((await tool(tExterno, 'list_whatsapp_chats')).structuredContent.note).toBeTruthy();
    expect((await tool(tExterno, 'list_emails')).structuredContent.note).toBeTruthy();
    expect((await tool(tExterno, 'send_whatsapp', { chat: 'cualquiera', text: 'hola' })).isError).toBe(true);
    const p = await rpc(tDanny, 'prompts/list');
    expect(p.json.result.prompts[0].name).toBe('responder_cliente');
    const i = await rpc(tDanny, 'initialize', { protocolVersion: '2025-06-18' });
    expect(i.json.result.instructions).toContain('REGLA DE TICKETS');
  });
});
