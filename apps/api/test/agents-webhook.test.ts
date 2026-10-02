/**
 * Agentes miembro (docs/AGENTES.md): webhook firmado cuando le escriben por directo, lo mencionan o le responden;
 * nada por mensajes que no van para él ni por lo que escribe el propio agente.
 *   API con la misma base; las entregas las hace la prueba con la función del worker (drain), así no depende de él:
 *   set -a; . ./.env; set +a; INTEGRATIONS_ALLOW_LOCAL=true API_URL=http://localhost:3482 npx vitest run test/agents-webhook.test.ts
 */
import { createHmac, randomUUID } from 'node:crypto';
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
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const mail = (n: string) => `${n.toLowerCase()}.agentwh.${run}@example.com`;
async function signup(name: string, orgInviteToken?: string) {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: mail(name), password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken as string, id: j.user.id as string, orgId: j.user.primaryOrgId as string };
}
const send = (token: string, conv: string, body: string, extra: object = {}) =>
  call(`/api/v1/conversations/${conv}/messages`, { token, body: { clientMessageId: randomUUID(), body, ...extra } });

const got: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let server: http.Server;
let agentForDrain = '';
/** Lo que haría el worker con los jobs 'agent.deliver' de este agente. */
async function drain() {
  const { rows } = await pool.query(
    `UPDATE jobs SET done_at = now() WHERE kind = 'agent.deliver' AND done_at IS NULL
        AND payload->>'deliveryId' IN (SELECT id::text FROM agent_deliveries WHERE agent_user_id = $1) RETURNING payload`, [agentForDrain]);
  for (const r of rows) await deliverAgentEvent(r.payload.deliveryId);
}
const until = async <T>(fn: () => T | undefined, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) { await drain(); const v = fn(); if (v !== undefined) return v; if (Date.now() > end) throw new Error('tiempo agotado'); await new Promise((r) => setTimeout(r, 200)); }
};
const events = () => got.map((g) => JSON.parse(g.body));

describe("webhook de agentes miembro", { timeout: 60_000 }, () => {
  let danny: Awaited<ReturnType<typeof signup>>, laura: typeof danny, group: string, agentId: string, mcpToken: string, secret: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { got.push({ headers: req.headers, body }); res.end('ok'); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    danny = await signup('Danny');
    const inv = await call(`/api/v1/organizations/${danny.orgId}/invitations`, { token: danny.token, body: { email: mail('Laura'), role: 'member' } });
    laura = await signup('Laura', inv.json.token);
    const g = await call('/api/v1/groups', { token: danny.token, body: { name: 'ventas', target: { kind: 'org' }, memberIds: [laura.id] } });
    expect(g.status).toBe(200);
    group = g.json.conversationId;
    const a = await createAgent(danny.id, danny.orgId, `bot${run}`, [group], 'Agente de prueba');
    expect(a.isNew).toBe(true);
    expect((a.groups as any)[group].added).toEqual([a.agentId]);
    agentId = a.agentId; mcpToken = a.mcpToken!; agentForDrain = agentId;
    // Idempotente: no duplica ni emite otro token.
    const again = await createAgent(danny.id, danny.orgId, `BOT${run}`, [group]);
    expect(again.agentId).toBe(agentId);
    expect(again.mcpToken).toBeUndefined();
    const w = await setAgentWebhook(danny.id, agentId, `http://localhost:${(server.address() as AddressInfo).port}/hook`);
    secret = w.secret!;
    expect(secret).toMatch(/^whsec_/);
  });
  afterAll(async () => { server?.close(); await pool.end(); });

  it('mensaje que no va para el agente: nada; mención escrita a mano: message.mention firmado', async () => {
    expect((await send(laura.token, group, 'hola equipo')).status).toBeLessThan(300);
    expect((await send(laura.token, group, `@bot${run} pospón UCatólica al martes`)).status).toBeLessThan(300);
    const e = await until(() => events().find((x) => x.type === 'message.mention'));
    expect(events().some((x) => x.message.body === 'hola equipo')).toBe(false);
    expect(e.agent.id).toBe(agentId);
    expect(e.conversation).toMatchObject({ id: group, kind: 'group', name: 'ventas' });
    expect(e.message.author).toMatchObject({ id: laura.id, name: 'Laura' });
    expect(e.reply).toEqual({ tool: 'send_message', arguments: { chat: group, reply_to: e.message.id } });
    const g = got.find((x) => JSON.parse(x.body).id === e.id)!;
    const [t, v1] = String(g.headers['x-chaggu-signature']).split(',').map((p) => p.split('=')[1]);
    expect(v1).toBe(createHmac('sha256', secret).update(`${t}.${g.body}`).digest('hex'));
    expect(g.headers['x-chaggu-event']).toBe('message.mention');
  });

  it('el agente responde por el MCP (sin webhook de vuelta) y responderle a él es message.reply', async () => {
    const before = got.length;
    const r = await call('/api/mcp', { token: mcpToken, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { chat: group, text: 'Listo, quedó para el martes' } } } });
    expect(r.json.result.isError).toBeFalsy();
    const mine = r.json.result.structuredContent.message.id as string;
    expect((await send(laura.token, group, 'gracias', { replyTo: mine })).status).toBeLessThan(300);
    const e = await until(() => events().find((x) => x.type === 'message.reply'));
    expect(e.message.replyTo).toBe(mine);
    expect(got.slice(before).every((x) => JSON.parse(x.body).message.author.id !== agentId)).toBe(true);
  });

  it('directo con el agente: message.direct', async () => {
    const d = await call('/api/v1/directs', { token: laura.token, body: { userId: agentId } });
    expect(d.status).toBe(200);
    const conv = d.json.conversationId ?? d.json.id;
    expect((await send(laura.token, conv, '¿qué tengo hoy?')).status).toBeLessThan(300);
    const e = await until(() => events().find((x) => x.type === 'message.direct'));
    expect(e.conversation).toMatchObject({ id: conv, kind: 'direct', name: null });
  });

  it('apagado: ya no avisa', async () => {
    await setAgentWebhook(danny.id, agentId, null);
    const before = got.length;
    expect((await send(laura.token, group, `@bot${run} ¿sigues?`)).status).toBeLessThan(300);
    await drain();
    await new Promise((r) => setTimeout(r, 500));
    expect(got.length).toBe(before);
  });
});
