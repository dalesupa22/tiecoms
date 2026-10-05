/**
 * MCP para integraciones (docs/MCP.md): permisos por token, doble llave de WhatsApp (número y chat), lectura
 * incremental, teléfono, grupos, búsqueda, envío idempotente a número nuevo, borradores, avisos y bitácora.
 * Necesita el API (API_URL) con INTEGRATIONS_ALLOW_LOCAL=true y la misma base (DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { storeGroupMembers, storeMessages, upsertChats, type MsgRow, type Session } from '../src/modules/wa-sync.ts';
import { queueWaWebhooks } from '../src/modules/mcp-wa.ts';

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
const mail = (n: string) => `${n.toLowerCase()}.int.${run}@example.com`;
async function signup(name: string) {
  const r = await call('/api/v1/auth/signup', { body: { name, orgName: `${name} SAS ${run}`, email: mail(name), password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' } } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string };
}
let rpcId = 0;
const rpc = (token: string, method: string, params?: unknown) => call('/api/mcp', { token, body: { jsonrpc: '2.0', id: ++rpcId, method, params } });
const tool = async (token: string, name: string, args: unknown = {}) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  expect(r.status).toBe(200);
  return r.json.result as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
};
const mkToken = async (user: { token: string }, body: object) => (await call('/api/v1/me/mcp-tokens', { token: user.token, body })).json.token as string;

async function waAccount(user: { token: string; id: string }, label: string, kind: 'personal' | 'business') {
  const acc = (await call('/api/v1/whatsapp/accounts', { token: user.token, body: { label, kind } })).json.id as string;
  await pool.query(`UPDATE wa_accounts SET status='connected', send_enabled=true, privacy_synced_at=now(), lease_owner='fixture', lease_until=now()+interval '1 hour' WHERE id=$1`, [acc]);
  const s: Session = { id: acc, userId: user.id, kind, pairPhone: null, sock: null, stopping: false, retries: 0, registered: true, me: null, notifyTimer: null };
  return { id: acc, s };
}
const msg = (chat: string, body: string, opts: Partial<MsgRow> = {}): MsgRow => ({
  chat, id: `m-${randomUUID().slice(0, 12)}`, fromMe: false, authorJid: chat.endsWith('@g.us') ? '573150000001@s.whatsapp.net' : chat, authorName: 'Cliente', kind: 'text', body, sentAt: new Date(), ...opts,
});

const BIZ_CLIENT = '573001110001@s.whatsapp.net';
const LID_CLIENT = '99887766554433@lid';
const LID_PHONE = '573234418536';
const GROUP = '120363000000000001@g.us';
const MOM = '573009990000@s.whatsapp.net';

let danny: Awaited<ReturnType<typeof signup>>, eva: typeof danny;
let biz: Awaited<ReturnType<typeof waAccount>>, personal: typeof biz, evaBiz: typeof biz;

beforeAll(async () => {
  danny = await signup('Dan');
  eva = await signup('Eva');
  biz = await waAccount(danny, 'Xertify', 'business');
  personal = await waAccount(danny, 'Personal', 'personal');
  evaBiz = await waAccount(eva, 'Eva biz', 'business');
  await upsertChats(biz.s, [{ jid: BIZ_CLIENT, name: 'Coopcentral', isGroup: false }, { jid: LID_CLIENT, name: null, isGroup: false }, { jid: GROUP, name: 'Sember Xertify', isGroup: true, participants: 3 }]);
  await pool.query('INSERT INTO wa_jid_alias (account_id, lid, pn) VALUES ($1,$2,$3)', [biz.id, LID_CLIENT, `${LID_PHONE}@s.whatsapp.net`]);
  await pool.query('INSERT INTO wa_contacts (account_id, jid, push_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [biz.id, `${LID_PHONE}@s.whatsapp.net`, 'César Lead']);
  await storeMessages(biz.s, [
    msg(BIZ_CLIENT, 'Hola, sobre el convenio secretaría del trabajo', { sentAt: new Date(Date.now() - 3600_000) }),
    msg(BIZ_CLIENT, 'Le confirmo mañana', { fromMe: true, authorJid: null, authorName: null, sentAt: new Date(Date.now() - 1800_000) }),
    msg(BIZ_CLIENT, '🎤 Nota de voz', { kind: 'audio', id: `voz-${run}`, sentAt: new Date(Date.now() - 600_000) }),
    msg(LID_CLIENT, 'Buenas, me interesa', { sentAt: new Date(Date.now() - 500_000) }),
    msg(GROUP, 'Reunión el lunes', { sentAt: new Date(Date.now() - 400_000) }),
  ], true);
  await pool.query(`UPDATE wa_messages SET transcript = '{"status":"done","text":"necesito la propuesta del diplomado en IA"}' WHERE account_id = $1 AND id = $2`, [biz.id, `voz-${run}`]);
  await storeGroupMembers(biz.s, [{ id: GROUP, subject: 'Sember Xertify', participants: [
    { id: '573150000001@s.whatsapp.net', admin: 'admin' }, { id: '11122233344455@lid', phoneNumber: '573150000002@s.whatsapp.net' }, { id: '573150000003@s.whatsapp.net' },
  ] } as any]);
  await upsertChats(personal.s, [{ jid: MOM, name: 'Mamá', isGroup: false }]);
  await storeMessages(personal.s, [msg(MOM, 'Mijo, ¿vienes a almorzar?')], true);
  await upsertChats(evaBiz.s, [{ jid: '573005550000@s.whatsapp.net', name: 'Cliente de Eva', isGroup: false }]);
  await storeMessages(evaBiz.s, [msg('573005550000@s.whatsapp.net', `secreto de Eva ${run}`)], true);
});
afterAll(async () => { await pool.end(); });

describe('permisos por token', () => {
  it('solo whatsapp:read: no ve tareas en tools/list y enviar da forbidden_scope', async () => {
    const t = await mkToken(danny, { name: 'Semillero', scopes: ['whatsapp:read'] });
    const names = (await rpc(t, 'tools/list')).json.result.tools.map((x: any) => x.name);
    expect(names).toContain('read_whatsapp');
    expect(names).not.toContain('create_task');
    expect(names).not.toContain('send_whatsapp');
    const r = await tool(t, 'send_whatsapp', { chat: 'Coopcentral', text: 'hola' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe('forbidden_scope');
  });

  it('un token vencido da 401', async () => {
    const t = await mkToken(danny, { name: 'Viejo', expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect((await rpc(t, 'ping')).status).toBe(401);
  });
});

describe('doble llave de WhatsApp', () => {
  it('por defecto: el número de empresa sí, el personal no, y nunca los de otra persona', async () => {
    const t = await mkToken(danny, { name: 'Claude' });
    const list = (await tool(t, 'list_whatsapp_chats')).structuredContent;
    const names = list.chats.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Coopcentral', 'Sember Xertify']));
    expect(names).not.toContain('Mamá');
    expect(names).not.toContain('Cliente de Eva');
    // 3. Sin vista previa salvo que se pida.
    expect(list.chats[0].preview).toBeUndefined();
    expect((await tool(t, 'list_whatsapp_chats', { include_preview: true })).structuredContent.chats[0].preview).toBeTruthy();
    expect((await tool(t, 'read_whatsapp', { chat: `${personal.id}|${MOM}` })).structuredContent.error.code).toBe('not_found');
    expect(JSON.stringify(await tool(t, 'search_whatsapp', { query: 'secreto de Eva' }))).not.toContain(run);
    expect(JSON.stringify(await tool(t, 'search_whatsapp', { query: 'almorzar' }))).not.toContain('Mamá');
  });

  it('compartir un chat suelto del personal lo hace visible; apagarlo lo oculta otra vez', async () => {
    const t = await mkToken(danny, { name: 'Claude 2' });
    const share = (on: boolean) => call(`/api/v1/whatsapp/chats/${personal.id}/${encodeURIComponent(MOM)}`, { method: 'PATCH', token: danny.token, body: { integrationsShared: on } });
    expect((await share(true)).status).toBe(200);
    expect((await tool(t, 'read_whatsapp', { chat: 'Mamá' })).structuredContent.messages[0].text).toContain('almorzar');
    await share(false);
    expect((await tool(t, 'read_whatsapp', { chat: 'Mamá' })).isError).toBe(true);
  });

  it('un token con números elegidos ve exactamente esos (el personal para encargos personales)', async () => {
    const t = await mkToken(danny, { name: 'ChatGPT', waAccountIds: [personal.id] });
    const names = (await tool(t, 'list_whatsapp_chats')).structuredContent.chats.map((c: any) => c.name);
    expect(names).toEqual(['Mamá']);
    // No puede elegir números de otra persona.
    const t2 = await mkToken(danny, { name: 'Trampa', waAccountIds: [evaBiz.id] });
    expect((await tool(t2, 'list_whatsapp_chats')).structuredContent.chats).toHaveLength(0);
  });

  it('apagar «Compartir con integraciones» en el número de empresa lo oculta', async () => {
    const t = await mkToken(danny, { name: 'Claude 3' });
    await call(`/api/v1/whatsapp/accounts/${biz.id}`, { method: 'PATCH', token: danny.token, body: { integrationsEnabled: false } });
    expect((await tool(t, 'list_whatsapp_chats')).structuredContent.chats).toHaveLength(0);
    const accounts = (await call('/api/v1/whatsapp/accounts', { token: danny.token })).json;
    expect((Array.isArray(accounts) ? accounts : accounts.accounts).find((a: any) => a.id === biz.id).integrationsEnabled).toBe(false);
    await call(`/api/v1/whatsapp/accounts/${biz.id}`, { method: 'PATCH', token: danny.token, body: { integrationsEnabled: true } });
  });
});

describe('datos completos', () => {
  let t: string;
  beforeAll(async () => { t = await mkToken(danny, { name: 'CRM' }); });

  it('read_whatsapp trae fromMe, kind, teléfono y transcripción; since devuelve solo lo nuevo', async () => {
    const r = (await tool(t, 'read_whatsapp', { chat: 'Coopcentral' })).structuredContent;
    expect(r.messages.map((m: any) => m.fromMe)).toEqual([false, true, false]);
    expect(r.messages[2].kind).toBe('audio');
    expect(r.messages[2].transcript).toContain('diplomado');
    expect(r.messages[2].text).toMatch(/^🎤 \(transcrito\)/);
    expect(r.messages[0].senderPhone).toBe('+573001110001');
    const since = (await tool(t, 'read_whatsapp', { chat: 'Coopcentral', since: new Date(Date.now() - 1000_000).toISOString() })).structuredContent;
    expect(since.messages).toHaveLength(1);
    expect(since.messages[0].kind).toBe('audio');
  });

  it('pagina por cursor y conserva fechas ISO para conectores con esquema anterior', async () => {
    const first = (await tool(t, 'read_whatsapp', { chat: 'Coopcentral', limit: 1 })).structuredContent;
    expect(first.nextBefore).toMatch(/^\d{4}-.*Z$/);
    expect(first.nextCursor).toMatch(/^wa1\./);
    const next = (await tool(t, 'read_whatsapp', { chat: 'Coopcentral', limit: 1, cursor: first.nextCursor })).structuredContent;
    const legacy = (await tool(t, 'read_whatsapp', { chat: 'Coopcentral', limit: 1, before: first.nextBefore })).structuredContent;
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].id).not.toBe(first.messages[0].id);
    expect(legacy.messages[0].id).toBe(next.messages[0].id);
  });

  it('lista con teléfono del 1 a 1, quién habló de último y paginación', async () => {
    const p1 = (await tool(t, 'list_whatsapp_chats', { limit: 2 })).structuredContent;
    expect(p1.hasMore).toBe(true);
    const p2 = (await tool(t, 'list_whatsapp_chats', { limit: 2, cursor: p1.nextCursor })).structuredContent;
    const all = [...p1.chats, ...p2.chats];
    expect(new Set(all.map((c: any) => c.chat)).size).toBe(3);
    const coop = all.find((c: any) => c.name === 'Coopcentral');
    expect(coop.phone).toBe('+573001110001');
    expect(coop.lastMessageKind).toBe('audio');
    expect(coop.lastMessageFromMe).toBe(false);
    expect(all.find((c: any) => c.chat.endsWith(LID_CLIENT)).phone).toBe(`+${LID_PHONE}`);
  });

  it('find_whatsapp_chat encuentra un @lid por su teléfono con el nombre con que se presenta', async () => {
    const r = (await tool(t, 'find_whatsapp_chat', { phone: '+57 323 4418536' })).structuredContent;
    expect(r.chats).toHaveLength(1);
    expect(r.chats[0].pushName).toBe('César Lead');
  });

  it('get_whatsapp_group trae participantes con teléfono y admin', async () => {
    const r = (await tool(t, 'get_whatsapp_group', { chat: 'Sember Xertify' })).structuredContent;
    expect(r.members).toHaveLength(3);
    expect(r.members.map((m: any) => m.phone)).toEqual(expect.arrayContaining(['+573150000001', '+573150000002']));
    expect(r.members.some((m: any) => m.admin)).toBe(true);
  });

  it('search_whatsapp busca en texto y transcripciones', async () => {
    expect((await tool(t, 'search_whatsapp', { query: 'convenio secretaria' })).structuredContent.results[0].name).toBe('Coopcentral');
    expect((await tool(t, 'search_whatsapp', { query: 'diplomado en IA' })).structuredContent.results[0].snippet).toContain('transcrito');
  });
});

describe('enviar mejor', () => {
  it('send_whatsapp a un número nuevo con idempotency_key envía una sola vez', async () => {
    const t = await mkToken(danny, { name: 'ChatGPT ferreterías', waAccountIds: [personal.id] });
    const args = { phone: '+57 310 000 1234', text: 'Hola, quisiera una cotización de 10 bultos de cemento', idempotency_key: `ferre-${run}` };
    const a = await tool(t, 'send_whatsapp', args);
    expect(a.isError).toBeFalsy();
    expect(a.structuredContent.chat).toBe(`${personal.id}|573100001234@s.whatsapp.net`);
    const b = await tool(t, 'send_whatsapp', args);
    expect(b.structuredContent.duplicate).toBe(true);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM wa_outbox WHERE account_id = $1 AND jid = '573100001234@s.whatsapp.net'", [personal.id]);
    expect(rows[0].n).toBe(1);
    expect((await tool(t, 'send_whatsapp', { ...args, text: 'otro texto' })).structuredContent.error.code).toBe('idempotency_mismatch');
    expect((await tool(t, 'send_whatsapp', { phone: '123456', text: 'x' })).structuredContent.error.code).toBe('invalid_phone');
  }, 40_000);

  it('send_whatsapp devuelve outboxId y, cuando sale, el messageId de WhatsApp', async () => {
    const t = await mkToken(danny, { name: 'Semillero ids' });
    const pending = tool(t, 'send_whatsapp', { chat: 'Coopcentral', text: `seguimiento ${run}` });
    // Hace de puente: toma el envío de la cola y lo marca enviado con el id que daría WhatsApp.
    let outbox: string | undefined;
    for (let i = 0; i < 40 && !outbox; i++) {
      outbox = (await pool.query("SELECT id FROM wa_outbox WHERE account_id = $1 AND body = $2 AND status = 'queued'", [biz.id, `seguimiento ${run}`])).rows[0]?.id;
      if (!outbox) await new Promise((r) => setTimeout(r, 100));
    }
    await pool.query("UPDATE wa_outbox SET status = 'sent', sent_at = now(), body = '', wa_message_id = $2 WHERE id = $1", [outbox, `3EB0${run}`]);
    const r = (await pending).structuredContent;
    expect(r.status).toBe('sent');
    expect(r.outboxId).toBe(outbox);
    expect(r.messageId).toBe(`3EB0${run}`);
  });

  it('send_disabled con código cuando el número es de solo lectura', async () => {
    await pool.query('UPDATE wa_accounts SET send_enabled = false WHERE id = $1', [biz.id]);
    const t = await mkToken(danny, { name: 'X' });
    expect((await tool(t, 'send_whatsapp', { chat: 'Coopcentral', text: 'hola' })).structuredContent.error.code).toBe('send_disabled');
    await pool.query('UPDATE wa_accounts SET send_enabled = true WHERE id = $1', [biz.id]);
  });

  it('borradores: la integración los crea, la persona los ve y descarta; el aviso lleva external_ref', async () => {
    const t = await mkToken(danny, { name: 'Semillero', scopes: ['whatsapp:read', 'whatsapp:draft'] });
    const hook = await tool(t, 'set_whatsapp_webhook', { url: 'http://127.0.0.1:59999/hook', chats: ['Coopcentral'] });
    expect(hook.structuredContent.secret).toMatch(/^whsec_/);
    const d = await tool(t, 'create_whatsapp_draft', { chat: 'Coopcentral', text: 'Seguimiento de la propuesta', external_ref: `crm-${run}` });
    expect(d.structuredContent.status).toBe('pending');
    const pending = (await call('/api/v1/whatsapp/drafts', { token: danny.token })).json.drafts;
    expect(pending.find((x: any) => x.id === d.structuredContent.draft).source).toBe('Semillero');
    expect((await call(`/api/v1/whatsapp/drafts/${d.structuredContent.draft}`, { method: 'DELETE', token: danny.token })).status).toBe(200);
    expect((await tool(t, 'list_whatsapp_drafts', { status: 'discarded' })).structuredContent.drafts[0].externalRef).toBe(`crm-${run}`);
    const ev = await pool.query("SELECT payload FROM mcp_webhook_deliveries d JOIN mcp_webhooks h ON h.id = d.webhook_id WHERE h.user_id = $1 AND d.event_type = 'whatsapp.draft.discarded'", [danny.id]);
    expect(ev.rows[0].payload.data.externalRef).toBe(`crm-${run}`);
  });

  it('avisos al instante solo de los chats listados', async () => {
    const t = await mkToken(danny, { name: 'Webhooks' });
    await tool(t, 'set_whatsapp_webhook', { url: 'http://127.0.0.1:59999/hook2', chats: ['Coopcentral'], events: ['whatsapp.message.received'] });
    const inCoop = msg(BIZ_CLIENT, 'nuevo en coop');
    const inGroup = msg(GROUP, 'nuevo en grupo');
    await storeMessages(biz.s, [inCoop, inGroup], true);
    await queueWaWebhooks(biz.id, [inCoop, inGroup]);
    const { rows } = await pool.query(
      `SELECT d.payload FROM mcp_webhook_deliveries d JOIN mcp_webhooks h ON h.id = d.webhook_id JOIN mcp_tokens tk ON tk.id = h.token_id
        WHERE tk.name = 'Webhooks' AND h.user_id = $1`, [danny.id]);
    expect(rows.map((r) => r.payload.data.message.text)).toEqual(['nuevo en coop']);
    expect(rows[0].payload.scope).toBeTruthy();
  });

  it('la bitácora muestra qué hizo cada app, sin contenido', async () => {
    const act = (await call('/api/v1/me/mcp-activity', { token: danny.token })).json.activity;
    expect(act.some((a: any) => a.app === 'ChatGPT ferreterías' && a.tool === 'send_whatsapp' && a.ok)).toBe(true);
    expect(act.some((a: any) => a.app === 'Semillero' && a.error === 'forbidden_scope')).toBe(true);
    expect(JSON.stringify(act)).not.toContain('cemento');
    const list = (await call('/api/v1/me/mcp-tokens', { token: danny.token })).json.tokens;
    expect(list.find((x: any) => x.name === 'ChatGPT ferreterías').whatsapp).toEqual({ mode: 'chosen', numbers: ['Personal'] });
  });
});
