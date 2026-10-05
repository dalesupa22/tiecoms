/** Real PostgreSQL, synthetic accounts only. No WhatsApp network or production data. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import type { McpCtx } from '../src/modules/mcp-wa.ts';

const database = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.pathname !== '/mcp_attachments_test') {
  throw new Error('WhatsApp MCP history tests require isolated local mcp_attachments_test');
}
let wa: typeof import('../src/modules/mcp-wa.ts');
const user = randomUUID(), outsider = randomUUID(), account = randomUUID(), secondAccount = randomUUID(), foreignAccount = randomUUID();
const accounts = [account, secondAccount, foreignAccount];
const PN = '573001234567@s.whatsapp.net', LID = '888811112222@lid', PRIVATE_LID = '888811113333@lid';
const OTHER = '573001111111@s.whatsapp.net', GROUP = '120363111111111@g.us';
const ctx: McpCtx = { userId: user, tokenId: randomUUID(), scopes: ['whatsapp:read'], waAccountIds: null, clientName: 'Fixture history' };
const ref = (jid = PN, acc = account) => `${acc}|${jid}`;
const since = '2026-10-01T00:00:00.000000Z';
const until = '2026-10-01T00:00:01.000040Z';

async function addChat(acc: string, jid: string, name: string, shared = true, group = false, at = '2026-10-01T00:00:01Z') {
  await pool.query(`INSERT INTO wa_chats (account_id,jid,name,is_group,integrations_shared,last_message_at,last_preview,unread)
    VALUES($1,$2,$3,$4,$5,$6,$7,3)`, [acc, jid, name, group, shared, at, `preview:${name}`]);
}

beforeAll(async () => {
  // Initialize cyclic product imports in the same order as the server, without starting HTTP.
  await import('../src/http.ts');
  wa = await import('../src/modules/mcp-wa.ts');
  await pool.query('INSERT INTO users(id,email,name) VALUES($1,$2,$3),($4,$5,$6)',
    [user, `wa-history-${user}@example.test`, 'History owner', outsider, `wa-history-${outsider}@example.test`, 'Other owner']);
  for (const acc of accounts) await pool.query(`INSERT INTO wa_accounts(id,user_id,label,kind,status,integrations_enabled,
    privacy_synced_at,privacy_hydrated_at,lease_owner,lease_until) VALUES($1,$2,$3,'personal','connected',false,now(),now(),'fixture',now()+interval '1 hour')`,
  [acc, acc === foreignAccount ? outsider : user, `Fixture ${acc}`]);
  await addChat(account, PN, 'James');
  await addChat(account, LID, 'James AliasOnly', true, false, '2026-10-01T01:00:00Z');
  await addChat(account, PRIVATE_LID, 'Secret alias', false, false, '2028-01-01T00:00:00Z');
  await addChat(account, OTHER, 'Other contact');
  await addChat(account, GROUP, 'History group', true, true);
  await addChat(secondAccount, PN, 'James second account');
  await addChat(foreignAccount, PN, 'James foreign owner');
  await pool.query('INSERT INTO wa_jid_alias(account_id,lid,pn) VALUES($1,$2,$3),($1,$4,$3)', [account, LID, PN, PRIVATE_LID]);
  // 490 PN + 45 LID = 535 logical messages, including ties at microsecond precision.
  await pool.query(`INSERT INTO wa_messages(account_id,chat_jid,id,kind,body,sent_at,author_jid)
    SELECT $1,CASE WHEN n<490 THEN $2 ELSE $3 END,'m'||lpad(n::text,4,'0'),CASE WHEN n%5=0 THEN 'image' ELSE 'text' END,
      'history fixture '||n, '2026-10-01T00:00:01Z'::timestamptz+(n/7)*interval '1 microsecond',CASE WHEN n<490 THEN $2 ELSE $3 END
    FROM generate_series(0,534) n`, [account, PN, LID]);
  // Same ID on another authorized alias is one message; pick the latest copy BEFORE paging/filtering.
  await pool.query(`INSERT INTO wa_messages(account_id,chat_jid,id,kind,body,sent_at,author_jid)
    VALUES($1,$2,'m0009','text','history fixture duplicate latest','2026-10-01T01:00:00Z',$2),
      ($1,$3,'private-only','text','PRIVATE ALIAS MUST STAY HIDDEN','2028-01-01T00:00:00Z',$3),
      ($1,$4,'m0009','text','history fixture OTHER contact','2026-10-01T02:00:00Z',$4),
      ($1,$5,'m0009','text','history fixture GROUP','2026-10-01T03:00:00Z',$4),
      ($6,$7,'m0009','text','history fixture SECOND account','2026-10-01T04:00:00Z',$7),
      ($8,$7,'foreign-only','text','FOREIGN OWNER MUST STAY HIDDEN','2026-10-01T04:00:00Z',$7)`,
  [account, LID, PRIVATE_LID, OTHER, GROUP, secondAccount, PN, foreignAccount]);
});
afterAll(async () => {
  await pool.query("DELETE FROM jobs WHERE kind='wa.transcribe' AND payload->>'accountId'=ANY($1::text[])", [accounts]);
  await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[user, outsider]]);
  await pool.end();
});

async function allPages(direction: 'before' | 'since', kinds?: string[]) {
  let boundary = direction === 'since' ? since : undefined;
  const pages: any[][] = [];
  for (let n = 0; n < 100; n++) {
    const page = await wa.readChat(ctx, ref(n % 2 ? LID : PN), { limit: 37, [direction]: boundary, ...(n === 0 && kinds ? { kinds } : {}) });
    pages.push(page.messages);
    if (!page.hasMore) return (direction === 'before' ? pages.reverse() : pages).flat();
    boundary = direction === 'before' ? page.nextBefore : page.nextSince;
    expect(boundary).toMatch(/^wa1\./);
  }
  throw new Error('Pagination never completed');
}

describe('authorized logical WhatsApp history', () => {
  it('returns all 535 IDs once in both directions despite timestamp ties and microseconds', async () => {
    const ascending = await allPages('since'), descending = await allPages('before');
    expect(ascending).toHaveLength(535);
    expect(new Set(ascending.map((m) => m.id)).size).toBe(535);
    expect(descending.map((m) => m.id)).toEqual(ascending.map((m) => m.id));
    expect(ascending.at(-1).text).toBe('history fixture duplicate latest');
    expect(JSON.stringify(ascending)).not.toContain('PRIVATE');
  });

  it('collapses authorized aliases for phone, name and list, without combining accounts or changing explicit targets', async () => {
    const found = await wa.findByPhone(ctx, '+57 300 123 4567');
    expect(found.chats).toHaveLength(2);
    expect(found.chats.find((c) => c.chat === ref())?.aliasCount).toBe(2);
    expect((await wa.findChat(ctx, 'James AliasOnly')).jid).toBe(PN);
    expect((await wa.findChat(ctx, ref(LID))).jid).toBe(LID); // legacy sends/webhooks keep the explicit address.
    const listed = await wa.listChats(ctx, { query: 'James', includePreview: true, limit: 100 });
    expect(listed.chats).toHaveLength(2);
    const james = listed.chats.find((c) => c.chat === ref())!;
    expect(james.preview).toBe('preview:James AliasOnly');
    expect(james.lastMessageAt).toBe('2026-10-01T01:00:00.000Z');
    expect(james.unread).toBe(3); // duplicate provider alias counters must not be summed.
    expect(JSON.stringify(listed)).not.toContain('Secret');
    await expect(wa.findChat(ctx, 'Secret alias')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not inherit sharing across aliases, accounts, owners, or group membership', async () => {
    await expect(wa.readChat(ctx, ref(PRIVATE_LID), { limit: 100 })).rejects.toMatchObject({ code: 'not_found' });
    await expect(wa.readChat(ctx, ref(PN, foreignAccount), { limit: 100 })).rejects.toMatchObject({ code: 'not_found' });
    const another = await wa.readChat(ctx, ref(PN, secondAccount), { limit: 100 });
    expect(another.messages).toHaveLength(1);
    const group = await wa.readChat(ctx, ref(GROUP), { limit: 100 });
    expect(group.messages).toHaveLength(1);
    expect(group.chat.isGroup).toBe(true);
    await pool.query('UPDATE wa_chats SET integrations_shared=false WHERE account_id=$1 AND jid=$2', [account, LID]);
    try {
      // The second page explicitly uses now-revoked LID, which cannot borrow the PN grant.
      await expect(allPages('since')).rejects.toMatchObject({ code: 'not_found' });
    }
    finally { await pool.query('UPDATE wa_chats SET integrations_shared=true WHERE account_id=$1 AND jid=$2', [account, LID]); }
  });

  it('rechecks alias sharing and Chat Lock on every page', async () => {
    const first = await wa.readChat(ctx, ref(), { limit: 5 });
    await pool.query('UPDATE wa_chats SET integrations_shared=false WHERE account_id=$1 AND jid=$2', [account, LID]);
    try {
      const next = await wa.readChat(ctx, ref(), { limit: 200, before: first.nextBefore });
      expect(next.chat.aliasCount).toBe(1);
      expect(next.messages.every((m) => Number(m.id.slice(1)) < 490)).toBe(true);
    } finally { await pool.query('UPDATE wa_chats SET integrations_shared=true WHERE account_id=$1 AND jid=$2', [account, LID]); }
    await pool.query('UPDATE wa_chats SET wa_locked=true WHERE account_id=$1 AND jid=$2', [account, LID]);
    try {
      await expect(wa.readChat(ctx, ref(), { limit: 5, before: first.nextBefore })).rejects.toMatchObject({ code: 'not_found' });
      expect((await wa.findByPhone(ctx, PN.split('@')[0]!)).chats.map((c) => c.chat)).not.toContain(ref());
      expect((await wa.search(ctx, { query: 'duplicate latest', limit: 10 })).results).toHaveLength(0);
    } finally { await pool.query('UPDATE wa_chats SET wa_locked=false WHERE account_id=$1 AND jid=$2', [account, LID]); }
  });

  it('paginates chat rows across equal JIDs/timestamps in different accounts without losing microseconds', async () => {
    await pool.query("UPDATE wa_chats SET last_message_at='2026-10-01T00:00:01.123456Z' WHERE account_id=ANY($1::uuid[]) AND jid=ANY($2::text[])", [[account, secondAccount], [PN, LID]]);
    try {
      const first = await wa.listChats(ctx, { query: 'James', limit: 1 });
      expect(first.hasMore).toBe(true);
      const second = await wa.listChats(ctx, { query: 'James', limit: 1, cursor: first.nextCursor });
      expect(second.hasMore).toBe(false);
      expect(new Set([...first.chats, ...second.chats].map((c) => c.chat))).toEqual(new Set([ref(), ref(PN, secondAccount)]));
    } finally {
      await pool.query("UPDATE wa_chats SET last_message_at=CASE WHEN jid=$3 THEN '2026-10-01T01:00:00Z'::timestamptz ELSE '2026-10-01T00:00:01Z'::timestamptz END WHERE account_id=ANY($1::uuid[]) AND jid=ANY($2::text[])", [[account, secondAccount], [PN, LID], LID]);
    }
  });

  it('deduplicates search within a contact while keeping identical IDs from distinct contacts/accounts/groups', async () => {
    const result = await wa.search(ctx, { query: 'history fixture', limit: 1000 });
    expect(result.results).toHaveLength(538);
    expect(result.results.filter((m) => m.messageId === 'm0009')).toHaveLength(4);
    expect(new Set(result.results.map((m) => `${m.chat}|${m.messageId}`)).size).toBe(538);
    expect(JSON.stringify(result)).not.toContain('FOREIGN');
  });

  it('preserves kinds and opposite ISO boundaries, and rejects mismatched or malformed cursors', async () => {
    const images = await allPages('since', ['image']);
    expect(images).toHaveLength(107);
    expect(images.every((m) => m.kind === 'image')).toBe(true);
    const first = await wa.readChat(ctx, ref(), { limit: 5, since, before: until, kinds: ['image'] });
    const second = await wa.readChat(ctx, ref(), { limit: 200, since: first.nextSince });
    expect(second.messages).toHaveLength(51);
    expect(second.messages.every((m) => m.kind === 'image' && Number(m.id.slice(1)) < 280)).toBe(true);
    await expect(wa.readChat(ctx, ref(), { limit: 5, before: first.nextSince })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(wa.readChat(ctx, ref(PN, secondAccount), { limit: 5, since: first.nextSince })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(wa.readChat(ctx, ref(), { limit: 5, since: first.nextSince, kinds: ['text'] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(wa.readChat(ctx, ref(), { limit: 5, since: first.nextSince, before: '2026-10-03T00:00:00Z' })).rejects.toMatchObject({ code: 'bad_request' });
    for (const boundary of ['wa1.!bad', 'wa1.eyJ2IjoyfQ', 'tomorrow', 'wa1.' + 'a'.repeat(5000)]) {
      await expect(wa.readChat(ctx, ref(), { limit: 5, before: boundary })).rejects.toMatchObject({ code: 'bad_request' });
    }
    // Deduplicate first: an older alias copy cannot reappear inside an older ISO window.
    const oldWindow = await wa.readChat(ctx, ref(), { limit: 1000, before: '2026-10-01T00:30:00Z' });
    expect(oldWindow.messages).toHaveLength(534);
    expect(oldWindow.messages.some((m) => m.id === 'm0009')).toBe(false);
  });

  it('queues voice transcription using each selected message actual JID', async () => {
    await pool.query(`INSERT INTO wa_messages(account_id,chat_jid,id,kind,body,sent_at,media_state,media_info)
      VALUES($1,$2,'voice-pn','audio','voice','2026-10-01T05:00:00Z','ready','{"kind":"voice"}'),
        ($1,$3,'voice-lid','audio','voice','2026-10-01T05:01:00Z','ready','{"kind":"voice"}')`, [account, PN, LID]);
    try {
      await wa.readChat(ctx, ref(), { limit: 10, kinds: ['audio'] });
      const jobs = await pool.query("SELECT payload FROM jobs WHERE kind='wa.transcribe' AND payload->>'accountId'=$1", [account]);
      expect(jobs.rows.map((r) => `${r.payload.jid}|${r.payload.id}`).sort()).toEqual([`${PN}|voice-pn`, `${LID}|voice-lid`].sort());
    } finally { await pool.query("DELETE FROM wa_messages WHERE account_id=$1 AND id IN ('voice-pn','voice-lid')", [account]); }
  });
});
