/**
 * Conector MCP: temas del chat (docs/TEMAS.md). list_topics, leer un tema, escribir dentro de un tema (send_message y
 * send_direct_message) y el tema en búsqueda y no leídos. Necesita el API (API_URL).
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
const mail = (name: string) => `${name.toLowerCase()}.temas.${run}@example.com`;
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

describe('conector MCP: temas', () => {
  let danny: Awaited<ReturnType<typeof signup>>, laura: typeof danny, externo: typeof danny;
  let mcpDanny: string, mcpLaura: string, mcpExterno: string, chatId: string, latam: string, viejo: string;

  beforeAll(async () => {
    danny = await signup('Danny');
    const inv = await call(`/api/v1/organizations/${danny.orgId}/invitations`, { token: danny.token, body: { email: mail('Laura'), role: 'member' } });
    laura = await signup('Laura', inv.json.token);
    externo = await signup('Externo');
    mcpDanny = (await call('/api/v1/me/mcp-tokens', { token: danny.token, body: { name: 'Claude Code' } })).json.token;
    mcpLaura = (await call('/api/v1/me/mcp-tokens', { token: laura.token, body: {} })).json.token;
    mcpExterno = (await call('/api/v1/me/mcp-tokens', { token: externo.token, body: {} })).json.token;
    const s = await tool(mcpDanny, 'send_direct_message', { person: 'Laura', text: `general ${run}` });
    expect(s.isError).toBeFalsy();
    chatId = s.structuredContent.chatId;
    latam = (await call(`/api/v1/conversations/${chatId}/topics`, { token: danny.token, body: { name: 'LATAM ACC' } })).json.topic.id;
    viejo = (await call(`/api/v1/conversations/${chatId}/topics`, { token: danny.token, body: { name: 'Viejo' } })).json.topic.id;
    expect((await call(`/api/v1/topics/${viejo}`, { method: 'PATCH', token: danny.token, body: { archived: true } })).status).toBe(200);
  });

  it('list_topics trae id, nombre, color y archivado', async () => {
    const r = await tool(mcpDanny, 'list_topics', { chat: chatId });
    expect(r.isError).toBeFalsy();
    const byName = Object.fromEntries(r.structuredContent.topics.map((t: any) => [t.name, t]));
    expect(byName['LATAM ACC']).toMatchObject({ id: latam, archived: false });
    expect(byName['LATAM ACC'].color).toBeTruthy();
    expect(byName.Viejo).toMatchObject({ id: viejo, archived: true });
    // Quien no está en el chat no ve sus temas.
    expect((await tool(mcpExterno, 'list_topics', { chat: chatId })).isError).toBe(true);
  });

  it('send_message con topic por nombre etiqueta el mensaje como en la app', async () => {
    const r = await tool(mcpDanny, 'send_message', { chat: chatId, text: `reporte ${run}`, topic: 'latam acc' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.topic).toMatchObject({ id: latam, name: 'LATAM ACC' });
    expect(r.structuredContent.message.topic).toMatchObject({ id: latam, name: 'LATAM ACC' });
    // Laura lo recibe con el tema por la API de la app (mensajes y eventos en tiempo real).
    const page = (await call(`/api/v1/conversations/${chatId}/messages`, { token: laura.token })).json;
    expect(page.messages.find((m: any) => m.id === r.structuredContent.messageId).topicId).toBe(latam);
    const events = (await call(`/api/v1/conversations/${chatId}/events?after=0`, { token: laura.token })).json.events;
    expect(events.find((e: any) => e.type === 'message.created' && e.message?.id === r.structuredContent.messageId)?.message.topicId).toBe(latam);
  });

  it('send_message con adjuntos e idempotency_key respeta el tema y no duplica', async () => {
    const key = `temas-${run}-idem`;
    const a = await tool(mcpDanny, 'send_message', { chat: chatId, text: `idem ${run}`, topic: latam, idempotency_key: key });
    const b = await tool(mcpDanny, 'send_message', { chat: chatId, text: `idem ${run}`, topic: latam, idempotency_key: key });
    expect(a.isError).toBeFalsy();
    expect(b.structuredContent.messageId).toBe(a.structuredContent.messageId);
    // La misma llave con otro tema es otra operación: se rechaza en vez de reutilizar el envío.
    const other = await tool(mcpDanny, 'send_message', { chat: chatId, text: `idem ${run}`, idempotency_key: key });
    expect(other.isError).toBe(true);
  });

  it('send_direct_message con topic', async () => {
    const r = await tool(mcpDanny, 'send_direct_message', { person: 'Laura', text: `directo en tema ${run}`, topic: 'LATAM ACC' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.chatId).toBe(chatId);
    expect(r.structuredContent.message.topic.name).toBe('LATAM ACC');
  });

  it('errores claros: tema inexistente, archivado o ambiguo', async () => {
    const none = await tool(mcpDanny, 'send_message', { chat: chatId, text: 'x', topic: 'no existe' });
    expect(none.isError).toBe(true);
    expect(none.content[0]!.text).toContain('LATAM ACC');
    const archived = await tool(mcpDanny, 'send_message', { chat: chatId, text: 'x', topic: 'Viejo' });
    expect(archived.isError).toBe(true);
    expect(archived.content[0]!.text).toContain('archivado');
    await call(`/api/v1/conversations/${chatId}/topics`, { token: danny.token, body: { name: 'LATAM Ventas' } });
    const ambiguous = await tool(mcpDanny, 'send_message', { chat: chatId, text: 'x', topic: 'latam' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0]!.text).toContain('usa el id');
    // Ninguno de los intentos fallidos dejó un mensaje.
    const page = (await call(`/api/v1/conversations/${chatId}/messages`, { token: danny.token })).json;
    expect(page.messages.filter((m: any) => m.body === 'x')).toHaveLength(0);
  });

  it('read_messages filtra por tema y marca el tema de cada mensaje', async () => {
    const only = await tool(mcpLaura, 'read_messages', { chat: chatId, topic: 'LATAM ACC' });
    expect(only.isError).toBeFalsy();
    expect(only.structuredContent.topic.id).toBe(latam);
    const texts = only.structuredContent.messages.map((m: any) => m.text);
    expect(texts).toContain(`reporte ${run}`);
    expect(texts).not.toContain(`general ${run}`);
    expect(only.structuredContent.messages.every((m: any) => m.topic?.id === latam)).toBe(true);
    const all = await tool(mcpLaura, 'read_messages', { chat: chatId });
    const general = all.structuredContent.messages.find((m: any) => m.text === `general ${run}`);
    expect(general.topic).toBeUndefined();
    expect(all.structuredContent.messages.find((m: any) => m.text === `reporte ${run}`).topic.name).toBe('LATAM ACC');
    // Leer un solo tema no puede marcar todo el chat como leído.
    expect((await tool(mcpLaura, 'read_messages', { chat: chatId, topic: latam, mark_as_read: true })).isError).toBe(true);
    // Un tema archivado se puede leer.
    expect((await tool(mcpLaura, 'read_messages', { chat: chatId, topic: viejo })).isError).toBeFalsy();
  });

  it('unread_summary y search_messages traen el tema', async () => {
    const u = await tool(mcpLaura, 'unread_summary');
    const chat = u.structuredContent.chats.find((c: any) => c.id === chatId);
    expect(chat.messages.find((m: any) => m.text === `reporte ${run}`).topic.name).toBe('LATAM ACC');
    const found = await tool(mcpDanny, 'search_messages', { query: `reporte ${run}` });
    expect(found.structuredContent.results[0].message.topic).toMatchObject({ id: latam, name: 'LATAM ACC' });
  });
});
