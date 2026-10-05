/** Real MCP HTTP + isolated PostgreSQL. Synthetic people/accounts; no WA bridge or external delivery. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';

const API = process.env.API_URL ?? 'http://127.0.0.1:3087';
const target = new URL(API);
const database = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['127.0.0.1', 'localhost'].includes(target.hostname)
  || !['127.0.0.1', 'localhost'].includes(database.hostname) || database.pathname !== '/chaggu_mcp_scheduled_20261004') {
  throw new Error('MCP schedules require localhost and dedicated chaggu_mcp_scheduled_20261004 database');
}

const run = randomUUID().slice(0, 8);
const timezone = 'America/Bogota';
const future = () => new Date(Date.now() + 3_600_000).toISOString();
let rpcId = 0;
type Actor = { session: string; mcp: string; tokenId: string; id: string; org: string };
let native: typeof import('../src/modules/scheduled.ts');
let scheduled: typeof import('../src/modules/mcp-scheduled.ts');

async function request(path: string, token?: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const r = await fetch(`${API}${path}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
    'x-forwarded-for': `10.105.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
}
async function rpc(token: string, method: string, params: unknown = {}) {
  const r = await request('/api/mcp', token, { jsonrpc: '2.0', id: ++rpcId, method, params });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.result;
}
const tool = (token: string, name: string, args: unknown = {}) => rpc(token, 'tools/call', { name, arguments: args });
const good = (r: any) => { expect(r.isError, JSON.stringify(r)).not.toBe(true); return r.structuredContent; };
const bad = (r: any, code?: string) => { expect(r.isError, JSON.stringify(r)).toBe(true); if (code) expect(r.structuredContent.error.code).toBe(code); };
const when = () => ({ send_at: future(), timezone, idempotency_key: randomUUID() });
async function makeToken(actor: Actor, scopes?: string[]) {
  const r = await request('/api/v1/me/mcp-tokens', actor.session, { name: `schedule fixture ${run}`, ...(scopes ? { scopes } : {}) });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as { id: string; token: string };
}
async function signup(name: string, invite?: string): Promise<Actor> {
  const r = await request('/api/v1/auth/signup', undefined, {
    name, email: `${name}.${run}@example.test`, password: 'isolated-fixture-password-123',
    ...(invite ? { orgInviteToken: invite } : { orgName: `Schedule fixture ${name} ${run}` }),
    device: { deviceId: randomUUID(), name: 'isolated schedules', platform: 'web' },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const actor = { session: r.json.accessToken, id: r.json.user.id, org: r.json.user.primaryOrgId } as Actor;
  const token = await makeToken(actor);
  return { ...actor, mcp: token.token, tokenId: token.id };
}
const row = async (table: 'scheduled_messages' | 'mcp_whatsapp_schedules', id: string) => (await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0];
const makeDue = async (table: 'scheduled_messages' | 'mcp_whatsapp_schedules', id: string) => pool.query(`UPDATE ${table} SET send_at=now()-interval '1 second' WHERE id=$1`, [id]);

describe('MCP scheduled messages through the real catalog and HTTP transport', () => {
  let ana: Actor, beto: Actor, outsider: Actor, chat: string;
  const account = randomUUID(), account2 = randomUUID();
  const jid = '573001230001@s.whatsapp.net';
  const ref = `${account}|${jid}`;
  const createNative = async (token = ana.mcp, overrides: Record<string, unknown> = {}) => good(await tool(token, 'schedule_message', { chat, text: `native ${run}`, ...when(), ...overrides }));
  const createWa = async (token = ana.mcp, overrides: Record<string, unknown> = {}) => good(await tool(token, 'schedule_whatsapp', { chat: ref, text: `wa ${run}`, ...when(), ...overrides }));
  const listed = async (channel: 'chaggu' | 'whatsapp', token = ana.mcp) => good(await tool(token, channel === 'chaggu' ? 'list_scheduled_messages' : 'list_scheduled_whatsapp', { status: 'all' })).schedules;

  beforeAll(async () => {
    // Same import order as the API resolves existing cyclic product modules. Does not start a worker/bridge.
    await import('../src/http.ts');
    native = await import('../src/modules/scheduled.ts');
    scheduled = await import('../src/modules/mcp-scheduled.ts');
    ana = await signup('ScheduleAna');
    const inv = await request(`/api/v1/organizations/${ana.org}/invitations`, ana.session, {});
    expect(inv.status).toBe(200);
    beto = await signup('ScheduleBeto', inv.json.token);
    outsider = await signup('ScheduleOutsider');
    const dm = await request('/api/v1/directs', ana.session, { userId: beto.id });
    expect(dm.status).toBe(200); chat = dm.json.id;
    for (const id of [account, account2]) {
      await pool.query(`INSERT INTO wa_accounts(id,user_id,label,phone,kind,status,send_enabled,integrations_enabled,
        privacy_synced_at,privacy_hydrated_at,lease_owner,lease_until)
        VALUES($1,$2,$3,'573000000001','personal','connected',true,true,now(),now(),'scheduled-fixture',now()+interval '1 hour')`,
      [id, ana.id, `Scheduled ${id}`]);
      await pool.query('INSERT INTO wa_chats(account_id,jid,name,is_group,integrations_shared) VALUES($1,$2,$3,false,true)', [id, jid, `Synthetic contact ${run}`]);
    }
  });
  afterAll(async () => { await pool.end(); });

  it('publishes eight scoped tools, required fields, accurate server version and no unsupported listChanged promise', async () => {
    const init = await rpc(ana.mcp, 'initialize', { protocolVersion: '2025-06-18' });
    expect(init.serverInfo.version).toBe('1.1.0');
    expect(init.capabilities.tools.listChanged).toBe(false);
    expect(init.instructions).toContain('fecha actual');
    const all = (await rpc(ana.mcp, 'tools/list')).tools;
    const names = all.map((x: any) => x.name);
    expect(names).toEqual(expect.arrayContaining(['schedule_message', 'list_scheduled_messages', 'update_scheduled_message', 'cancel_scheduled_message',
      'schedule_whatsapp', 'list_scheduled_whatsapp', 'update_scheduled_whatsapp', 'cancel_scheduled_whatsapp']));
    for (const name of ['schedule_message', 'schedule_whatsapp']) {
      expect(all.find((x: any) => x.name === name).inputSchema.required).toEqual(expect.arrayContaining(['text', 'send_at', 'timezone', 'idempotency_key']));
    }
    const limited = await makeToken(ana, ['chats:read', 'whatsapp:read']);
    const limitedNames = (await rpc(limited.token, 'tools/list')).tools.map((x: any) => x.name);
    expect(limitedNames).toContain('list_scheduled_messages');
    for (const name of names.filter((x: string) => x.includes('scheduled') || x.startsWith('schedule_'))) {
      if (name !== 'list_scheduled_messages') expect(limitedNames).not.toContain(name);
    }
    bad(await tool(limited.token, 'schedule_message', { chat, text: 'no', ...when() }), 'forbidden_scope');
    bad(await tool(limited.token, 'list_scheduled_whatsapp'), 'forbidden_scope');
    bad(await tool(limited.token, 'cancel_scheduled_whatsapp', { id: randomUUID() }), 'forbidden_scope');
  });

  it('creates, reads, edits and cancels a native schedule without publishing text early', async () => {
    const before = (await pool.query('SELECT count(*)::int n FROM messages WHERE conversation_id=$1', [chat])).rows[0].n;
    const s = await createNative();
    expect(s).toMatchObject({ channel: 'chaggu', status: 'pending', timezone, conversationId: chat });
    expect(s.id).toBeTruthy(); expect(s.localSendAt).toBeTruthy();
    expect((await listed('chaggu')).find((x: any) => x.id === s.id)?.text).toBe(`native ${run}`);
    const edited = good(await tool(ana.mcp, 'update_scheduled_message', { id: s.id, text: 'edited fixture', send_at: future(), timezone }));
    expect(edited.text).toBe('edited fixture');
    await native.sendDueScheduled();
    expect((await row('scheduled_messages', s.id)).status).toBe('pending');
    expect((await pool.query('SELECT count(*)::int n FROM messages WHERE conversation_id=$1', [chat])).rows[0].n).toBe(before);
    expect(good(await tool(ana.mcp, 'cancel_scheduled_message', { id: s.id })).status).toBe('cancelled');
    bad(await tool(ana.mcp, 'update_scheduled_message', { id: s.id, text: 'too late' }));
  });

  it('supports a DM recipient and deduplicates concurrent creates without duplicate schedules or messages', async () => {
    const args = { to: beto.id, text: 'recipient fixture', ...when() };
    const results = await Promise.all(Array.from({ length: 4 }, () => tool(ana.mcp, 'schedule_message', args).then(good)));
    expect(new Set(results.map(x => x.id)).size).toBe(1);
    expect(results[0].conversationId).toBe(chat);
    bad(await tool(ana.mcp, 'schedule_message', { ...args, text: 'different content' }), 'idempotency_mismatch');
    const s = results[0];
    good(await tool(ana.mcp, 'cancel_scheduled_message', { id: s.id }));
    expect(good(await tool(ana.mcp, 'schedule_message', args)).status).toBe('cancelled');
    expect((await pool.query('SELECT count(*)::int n FROM scheduled_messages WHERE user_id=$1 AND body=$2', [ana.id, args.text])).rows[0].n).toBe(1);
  });

  it('validates time, timezone, missing data and mutually exclusive destinations', async () => {
    const args = { chat, text: 'invalid fixture', ...when() };
    for (const overrides of [
      { send_at: '2030-01-01T10:00:00' }, { send_at: new Date(Date.now() - 60_000).toISOString() },
      { send_at: new Date(Date.now() + 400 * 86_400_000).toISOString() }, { timezone: 'Mars/Olympus' },
      { text: '' }, { to: beto.id }, { chat: undefined }, { idempotency_key: undefined }, { timezone: undefined },
    ]) bad(await tool(ana.mcp, 'schedule_message', { ...args, ...overrides }), 'bad_request');
    const s = await createNative();
    bad(await tool(ana.mcp, 'update_scheduled_message', { id: s.id }), 'bad_request');
    bad(await tool(ana.mcp, 'update_scheduled_message', { id: s.id, send_at: future() }), 'bad_request');
    good(await tool(ana.mcp, 'cancel_scheduled_message', { id: s.id }));
    bad(await tool(ana.mcp, 'schedule_whatsapp', { chat: ref, phone: '+573001230001', text: 'bad', ...when() }), 'bad_request');
  });

  it('dispatches a due native schedule exactly once and returns the persisted message ID', async () => {
    const s = await createNative();
    await makeDue('scheduled_messages', s.id);
    await Promise.all([native.sendDueScheduled(), native.sendDueScheduled(), native.sendDueScheduled()]);
    const sent = (await listed('chaggu')).find((x: any) => x.id === s.id);
    expect(sent.status).toBe('sent'); expect(sent.messageId).toBeTruthy();
    const msgs = await pool.query('SELECT id,body FROM messages WHERE conversation_id=$1 AND client_message_id=$2', [chat, native.scheduledClientId(s.id)]);
    expect(msgs.rows).toHaveLength(1); expect(msgs.rows[0].id).toBe(sent.messageId);
    bad(await tool(ana.mcp, 'cancel_scheduled_message', { id: s.id }));
  });

  it('separates tokens and owners, and redacts native schedules after membership is removed', async () => {
    const s = await createNative();
    const otherToken = await makeToken(ana);
    expect(await listed('chaggu', otherToken.token)).toEqual([]);
    expect(await listed('chaggu', outsider.mcp)).toEqual([]);
    bad(await tool(otherToken.token, 'cancel_scheduled_message', { id: s.id }));
    bad(await tool(outsider.mcp, 'update_scheduled_message', { id: s.id, text: 'not mine' }));
    await pool.query('UPDATE conversation_memberships SET removed_at=now() WHERE conversation_id=$1 AND user_id=$2', [chat, ana.id]);
    try {
      const restricted = (await listed('chaggu')).find((x: any) => x.id === s.id);
      expect(restricted).toMatchObject({ id: s.id, restricted: true });
      expect(restricted.text).toBeUndefined(); expect(restricted.conversationId).toBeUndefined();
      bad(await tool(ana.mcp, 'update_scheduled_message', { id: s.id, text: 'no access' }));
      await makeDue('scheduled_messages', s.id); await native.sendDueScheduled();
      expect((await row('scheduled_messages', s.id)).status).toBe('failed');
    } finally { await pool.query('UPDATE conversation_memberships SET removed_at=NULL WHERE conversation_id=$1 AND user_id=$2', [chat, ana.id]); }
  });

  it('creates, edits and cancels WhatsApp schedules with no early outbox row or network operation', async () => {
    const s = await createWa();
    expect(s).toMatchObject({ channel: 'whatsapp', status: 'pending', timezone, chat: ref });
    expect(s.outboxId ?? null).toBeNull();
    expect((await listed('whatsapp')).some((x: any) => x.id === s.id)).toBe(true);
    expect(good(await tool(ana.mcp, 'update_scheduled_whatsapp', { id: s.id, text: 'edited WA fixture' })).text).toBe('edited WA fixture');
    await scheduled.sendDueWhatsappSchedules();
    expect((await row('mcp_whatsapp_schedules', s.id)).status).toBe('pending');
    expect((await pool.query('SELECT count(*)::int n FROM wa_outbox WHERE account_id=$1', [account])).rows[0].n).toBe(0);
    expect(good(await tool(ana.mcp, 'cancel_scheduled_whatsapp', { id: s.id })).status).toBe('cancelled');
  });

  it('deduplicates WA concurrent retries and keeps queued distinct from sent until fake bridge completion', async () => {
    const args = { chat: ref, text: 'WA concurrent fixture', ...when() };
    const results = await Promise.all(Array.from({ length: 4 }, () => tool(ana.mcp, 'schedule_whatsapp', args).then(good)));
    expect(new Set(results.map(x => x.id)).size).toBe(1);
    bad(await tool(ana.mcp, 'schedule_whatsapp', { ...args, text: 'changed' }), 'idempotency_mismatch');
    const s = results[0];
    await makeDue('mcp_whatsapp_schedules', s.id);
    await Promise.all([scheduled.sendDueWhatsappSchedules(), scheduled.sendDueWhatsappSchedules()]);
    const queued = (await listed('whatsapp')).find((x: any) => x.id === s.id);
    expect(queued.status).toBe('queued'); expect(queued.outboxId).toBeTruthy(); expect(queued.messageId ?? null).toBeNull();
    bad(await tool(ana.mcp, 'update_scheduled_whatsapp', { id: s.id, text: 'too late' }));
    await pool.query("UPDATE wa_outbox SET status='sending' WHERE id=$1", [queued.outboxId]);
    bad(await tool(ana.mcp, 'cancel_scheduled_whatsapp', { id: s.id }));
    await scheduled.assertScheduledWaSend(queued.outboxId);
    // Fake bridge completion: no Baileys socket exists and no provider request is made.
    await pool.query("UPDATE wa_outbox SET status='sent',wa_message_id=$2,sent_at=now() WHERE id=$1", [queued.outboxId, `FAKE-${run}`]);
    const sent = (await listed('whatsapp')).find((x: any) => x.id === s.id);
    expect(sent.status).toBe('sent'); expect(sent.messageId).toBe(`FAKE-${run}`);
    await scheduled.sendDueWhatsappSchedules();
    expect((await pool.query('SELECT count(*)::int n FROM wa_outbox WHERE id=$1', [queued.outboxId])).rows[0].n).toBe(1);
  });

  it('uses an explicit allowed WA account for a new phone and prevents cross-account/key reuse', async () => {
    bad(await tool(ana.mcp, 'schedule_whatsapp', { phone: '+573001230001', text: 'ambiguous account', ...when() }), 'bad_request');
    bad(await tool(ana.mcp, 'schedule_whatsapp', { chat: ref, account: account2, text: 'mismatched account', ...when() }), 'bad_request');
    const args = { phone: '+57 300 123 0019', account: account2, text: 'new synthetic number', ...when() };
    const s = good(await tool(ana.mcp, 'schedule_whatsapp', args));
    expect(s.chat).toBe(`${account2}|573001230019@s.whatsapp.net`);
    bad(await tool(ana.mcp, 'schedule_whatsapp', { ...args, account }), 'idempotency_mismatch');
    expect(await listed('whatsapp', outsider.mcp)).toEqual([]);
    bad(await tool(outsider.mcp, 'cancel_scheduled_whatsapp', { id: s.id }));
    good(await tool(ana.mcp, 'cancel_scheduled_whatsapp', { id: s.id }));
  });

  it('cancels queued and disconnected-account schedules while preserving redaction', async () => {
    const queued = await createWa();
    await makeDue('mcp_whatsapp_schedules', queued.id); await scheduled.sendDueWhatsappSchedules();
    const outboxId = (await row('mcp_whatsapp_schedules', queued.id)).outbox_id;
    expect(outboxId).toBeTruthy();
    expect(good(await tool(ana.mcp, 'cancel_scheduled_whatsapp', { id: queued.id })).status).toBe('cancelled');
    expect((await pool.query('SELECT status,body FROM wa_outbox WHERE id=$1', [outboxId])).rows[0]).toEqual({ status: 'failed', body: '' });
    const offline = await createWa();
    await pool.query("UPDATE wa_accounts SET status='logged_out',privacy_synced_at=NULL WHERE id=$1", [account]);
    try {
      const restricted = (await listed('whatsapp')).find((x: any) => x.id === offline.id);
      expect(restricted).toMatchObject({ id: offline.id, restricted: true, status: 'pending' });
      expect(restricted.text).toBeUndefined(); expect(restricted.chat).toBeUndefined();
      const cancelled = good(await tool(ana.mcp, 'cancel_scheduled_whatsapp', { id: offline.id }));
      expect(cancelled).toMatchObject({ status: 'cancelled', restricted: true });
      expect(cancelled.text).toBeUndefined();
      expect(good(await tool(ana.mcp, 'cancel_scheduled_whatsapp', { id: offline.id })).status).toBe('cancelled');
    } finally { await pool.query("UPDATE wa_accounts SET status='connected',privacy_synced_at=now() WHERE id=$1", [account]); }
  });

  it('rechecks WA sharing, account grants, Chat Lock and send enablement without exposing scheduled text', async () => {
    const s = await createWa();
    await pool.query('UPDATE wa_accounts SET integrations_enabled=false WHERE id=$1', [account]);
    await pool.query('UPDATE wa_chats SET integrations_shared=false WHERE account_id=$1 AND jid=$2', [account, jid]);
    try {
      const restricted = (await listed('whatsapp')).find((x: any) => x.id === s.id);
      expect(restricted).toMatchObject({ id: s.id, restricted: true });
      expect(restricted.text).toBeUndefined(); expect(restricted.chat).toBeUndefined();
      bad(await tool(ana.mcp, 'update_scheduled_whatsapp', { id: s.id, text: 'no sharing' }));
      await makeDue('mcp_whatsapp_schedules', s.id); await scheduled.sendDueWhatsappSchedules();
      expect((await row('mcp_whatsapp_schedules', s.id)).status).toBe('failed');
    } finally {
      await pool.query('UPDATE wa_accounts SET integrations_enabled=true WHERE id=$1', [account]);
      await pool.query('UPDATE wa_chats SET integrations_shared=true WHERE account_id=$1 AND jid=$2', [account, jid]);
    }
    await pool.query('UPDATE wa_chats SET wa_locked=true WHERE account_id=$1 AND jid=$2', [account, jid]);
    try { bad(await tool(ana.mcp, 'schedule_whatsapp', { chat: ref, text: 'locked', ...when() })); }
    finally { await pool.query('UPDATE wa_chats SET wa_locked=false WHERE account_id=$1 AND jid=$2', [account, jid]); }
    await pool.query('UPDATE wa_chats SET integrations_shared=false WHERE account_id=$1 AND jid=$2', [account, jid]);
    await pool.query('UPDATE mcp_tokens SET wa_account_ids=$2 WHERE id=$1', [ana.tokenId, [account2]]);
    try { expect((await listed('whatsapp')).find((x: any) => x.id === s.id)).toMatchObject({ restricted: true }); }
    finally {
      await pool.query('UPDATE mcp_tokens SET wa_account_ids=NULL WHERE id=$1', [ana.tokenId]);
      await pool.query('UPDATE wa_chats SET integrations_shared=true WHERE account_id=$1 AND jid=$2', [account, jid]);
    }
    await pool.query('UPDATE wa_accounts SET send_enabled=false WHERE id=$1', [account]);
    try { bad(await tool(ana.mcp, 'schedule_whatsapp', { chat: ref, text: 'disabled', ...when() }), 'send_disabled'); }
    finally { await pool.query('UPDATE wa_accounts SET send_enabled=true WHERE id=$1', [account]); }
  });

  it('revoked and expired tokens prevent native and WhatsApp delivery, including after WA queueing', async () => {
    for (const expired of [false, true]) {
      const token = await makeToken(ana);
      const n = await createNative(token.token), w = await createWa(token.token);
      await pool.query(expired ? "UPDATE mcp_tokens SET expires_at=now()-interval '1 second' WHERE id=$1" : 'UPDATE mcp_tokens SET revoked_at=now() WHERE id=$1', [token.id]);
      const auth = await request('/api/mcp', token.token, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' });
      expect(auth.status).toBe(401);
      await makeDue('scheduled_messages', n.id); await makeDue('mcp_whatsapp_schedules', w.id);
      await native.sendDueScheduled(); await scheduled.sendDueWhatsappSchedules();
      expect((await row('scheduled_messages', n.id)).status).toBe('failed');
      expect((await row('mcp_whatsapp_schedules', w.id)).status).toBe('failed');
    }
    const token = await makeToken(ana);
    const w = await createWa(token.token); await makeDue('mcp_whatsapp_schedules', w.id); await scheduled.sendDueWhatsappSchedules();
    const queued = await row('mcp_whatsapp_schedules', w.id);
    expect(queued.status).toBe('queued');
    await pool.query("UPDATE wa_outbox SET status='sending' WHERE id=$1", [queued.outbox_id]);
    await pool.query('UPDATE mcp_tokens SET revoked_at=now() WHERE id=$1', [token.id]);
    await expect(scheduled.assertScheduledWaSend(queued.outbox_id)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rechecks send permission, Chat Lock, sharing, token scope and active user immediately before WA dispatch', async () => {
    const mutations = [
      ["UPDATE wa_accounts SET send_enabled=false WHERE id=$1", "UPDATE wa_accounts SET send_enabled=true WHERE id=$1", [account]],
      ['UPDATE wa_chats SET wa_locked=true WHERE account_id=$1 AND jid=$2', 'UPDATE wa_chats SET wa_locked=false WHERE account_id=$1 AND jid=$2', [account, jid]],
      ["UPDATE mcp_tokens SET scopes=ARRAY['chats:read'] WHERE id=$1", 'UPDATE mcp_tokens SET scopes=NULL WHERE id=$1', [ana.tokenId]],
      ['UPDATE users SET disabled_at=now() WHERE id=$1', 'UPDATE users SET disabled_at=NULL WHERE id=$1', [ana.id]],
    ] as const;
    for (const [change, restore, params] of mutations) {
      const s = await createWa(); await makeDue('mcp_whatsapp_schedules', s.id); await scheduled.sendDueWhatsappSchedules();
      const queued = await row('mcp_whatsapp_schedules', s.id);
      await pool.query("UPDATE wa_outbox SET status='sending' WHERE id=$1", [queued.outbox_id]);
      await pool.query(change, [...params]);
      try { await expect(scheduled.assertScheduledWaSend(queued.outbox_id)).rejects.toMatchObject({ code: 'forbidden' }); }
      finally {
        await pool.query(restore, [...params]);
        await pool.query("UPDATE wa_outbox SET status='failed',error='Fixture rejected before provider' WHERE id=$1", [queued.outbox_id]);
      }
    }
    const s = await createWa(); await makeDue('mcp_whatsapp_schedules', s.id); await scheduled.sendDueWhatsappSchedules();
    const queued = await row('mcp_whatsapp_schedules', s.id);
    await pool.query("UPDATE wa_outbox SET status='sending' WHERE id=$1", [queued.outbox_id]);
    await pool.query('UPDATE wa_accounts SET integrations_enabled=false WHERE id=$1', [account]);
    await pool.query('UPDATE wa_chats SET integrations_shared=false WHERE account_id=$1 AND jid=$2', [account, jid]);
    try { await expect(scheduled.assertScheduledWaSend(queued.outbox_id)).rejects.toMatchObject({ code: 'forbidden' }); }
    finally {
      await pool.query('UPDATE wa_accounts SET integrations_enabled=true WHERE id=$1', [account]);
      await pool.query('UPDATE wa_chats SET integrations_shared=true WHERE account_id=$1 AND jid=$2', [account, jid]);
      await pool.query("UPDATE wa_outbox SET status='failed',error='Fixture sharing revoked' WHERE id=$1", [queued.outbox_id]);
    }
  });

  it('retires pending and queued receipts when the WhatsApp account is removed without changing confirmed sent receipts', async () => {
    const args = { chat: `${account2}|${jid}` };
    const pending = await createWa(ana.mcp, args), queued = await createWa(ana.mcp, args), sent = await createWa(ana.mcp, args);
    await makeDue('mcp_whatsapp_schedules', queued.id); await makeDue('mcp_whatsapp_schedules', sent.id);
    await scheduled.sendDueWhatsappSchedules();
    const sentOutbox = (await row('mcp_whatsapp_schedules', sent.id)).outbox_id;
    await pool.query("UPDATE wa_outbox SET status='sent',wa_message_id=$2,sent_at=now() WHERE id=$1", [sentOutbox, `FAKE-account-delete-${run}`]);
    const removed = await request(`/api/v1/whatsapp/accounts/${account2}`, ana.session, undefined, 'DELETE');
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);
    for (const s of [pending, queued]) expect((await row('mcp_whatsapp_schedules', s.id)).status).toBe('failed');
    expect((await row('mcp_whatsapp_schedules', sent.id)).status).toBe('sent');
    const receipt = (await listed('whatsapp')).find((x: any) => x.id === queued.id);
    expect(receipt).toMatchObject({ status: 'failed', restricted: true }); expect(receipt.text).toBeUndefined();
    await pool.query('DELETE FROM wa_accounts WHERE id=$1', [account2]);
    for (const s of [pending, queued]) expect(await row('mcp_whatsapp_schedules', s.id)).toMatchObject({ status: 'failed', account_id: null });
    expect((await row('mcp_whatsapp_schedules', sent.id)).status).toBe('sent');
  });

  it('cascades token deletion across pending/sent schedules and blocks dispatch after account deletion', async () => {
    const deleting = await signup('ScheduleDelete');
    const self = await request('/api/v1/directs', deleting.session, { userId: deleting.id });
    expect(self.status).toBe(200);
    const ownAccount = randomUUID();
    await pool.query(`INSERT INTO wa_accounts(id,user_id,label,kind,status,send_enabled,integrations_enabled,
      privacy_synced_at,privacy_hydrated_at,lease_owner,lease_until)
      VALUES($1,$2,'delete fixture','personal','connected',true,true,now(),now(),'scheduled-fixture',now()+interval '1 hour')`, [ownAccount, deleting.id]);
    await pool.query('INSERT INTO wa_chats(account_id,jid,is_group) VALUES($1,$2,false)', [ownAccount, jid]);
    const n = await createNative(deleting.mcp, { chat: self.json.id });
    const w = await createWa(deleting.mcp, { chat: `${ownAccount}|${jid}` });
    await makeDue('scheduled_messages', n.id); await native.sendDueScheduled();
    await makeDue('mcp_whatsapp_schedules', w.id); await scheduled.sendDueWhatsappSchedules();
    const queued = await row('mcp_whatsapp_schedules', w.id);
    await pool.query("UPDATE wa_outbox SET status='sent',wa_message_id=$2,sent_at=now() WHERE id=$1", [queued.outbox_id, `FAKE-delete-${run}`]);
    await createNative(deleting.mcp, { chat: self.json.id });
    await createWa(deleting.mcp, { chat: `${ownAccount}|${jid}` });
    await pool.query('DELETE FROM mcp_tokens WHERE id=$1', [deleting.tokenId]);
    expect((await pool.query('SELECT count(*)::int n FROM scheduled_messages WHERE user_id=$1', [deleting.id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM mcp_whatsapp_schedules WHERE user_id=$1', [deleting.id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM mcp_schedule_keys WHERE token_id=$1', [deleting.tokenId])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM wa_outbox WHERE user_id=$1', [deleting.id])).rows[0].n).toBe(0);
    const replacement = await makeToken(deleting);
    const pending = await createNative(replacement.token, { chat: self.json.id });
    const pendingWa = await createWa(replacement.token, { chat: `${ownAccount}|${jid}` });
    const deleted = await request('/api/v1/account', deleting.session, { confirmEmail: `scheduledelete.${run}@example.test`, password: 'isolated-fixture-password-123' }, 'DELETE');
    expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
    await makeDue('scheduled_messages', pending.id); await makeDue('mcp_whatsapp_schedules', pendingWa.id);
    await native.sendDueScheduled(); await scheduled.sendDueWhatsappSchedules();
    expect((await row('scheduled_messages', pending.id)).status).toBe('failed');
    expect((await row('mcp_whatsapp_schedules', pendingWa.id)).status).toBe('failed');
  });
});
