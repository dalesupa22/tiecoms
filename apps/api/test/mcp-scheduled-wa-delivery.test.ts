/** Dedicated local PostgreSQL + fake provider functions. No WhatsApp session, socket or real recipient. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db.ts';
import { deliverScheduledWaOutbox } from '../src/modules/mcp-scheduled-wa-guard.ts';

const url = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/chaggu_mcp_scheduled_20261004') throw new Error('Requires dedicated local schedule fixture database');
const user = randomUUID(), token = randomUUID(), account = randomUUID();
const jid = '573001239999@s.whatsapp.net';
async function sending() {
  const id = randomUUID(), outbox = randomUUID();
  await pool.query(`INSERT INTO mcp_whatsapp_schedules(id,user_id,mcp_token_id,account_id,account_label,jid,target_label,body,send_at,timezone)
    VALUES($1,$2,$3,$4,'Fake provider',$5,'Fake recipient','synthetic only',now(),'America/Bogota')`, [id, user, token, account, jid]);
  await pool.query(`INSERT INTO wa_outbox(id,account_id,user_id,jid,body,mcp_schedule_id,status,claimed_at)
    VALUES($1,$2,$3,$4,'synthetic only',$5,'sending',now())`, [outbox, account, user, jid, id]);
  return { id, outbox };
}
const state = async (id: string) => (await pool.query('SELECT status,message_id,error FROM mcp_whatsapp_schedules WHERE id=$1', [id])).rows[0];

describe('scheduled WhatsApp provider boundary', () => {
  beforeAll(async () => {
    await pool.query('INSERT INTO users(id,email,name) VALUES($1,$2,$3)', [user, `${user}@example.test`, 'Synthetic schedule sender']);
    await pool.query('INSERT INTO mcp_tokens(id,user_id,name,token_hash,token_hint,scopes) VALUES($1,$2,$3,$4,$5,$6)',
      [token, user, 'synthetic', Buffer.from(randomUUID()), 'fixture', ['whatsapp:send']]);
    await pool.query(`INSERT INTO wa_accounts(id,user_id,label,kind,status,send_enabled,integrations_enabled,privacy_synced_at,privacy_hydrated_at,lease_owner,lease_until)
      VALUES($1,$2,'Fake provider','personal','connected',true,true,now(),now(),'fake-provider-fixture',now()+interval '1 hour')`, [account, user]);
    await pool.query('INSERT INTO wa_chats(account_id,jid,name,is_group,integrations_shared) VALUES($1,$2,$3,false,true)', [account, jid, 'Fake recipient']);
  });
  afterAll(async () => { await pool.query('DELETE FROM users WHERE id=$1', [user]); await pool.end(); });

  it('keeps a confirmed sent receipt when local bookkeeping throws afterward', async () => {
    const row = await sending();
    const provider = vi.fn(async () => ({ key: { id: `FAKE-${randomUUID()}` } }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await deliverScheduledWaOutbox(row.outbox, provider, async () => { throw new Error('synthetic history failure'); });
      expect(provider).toHaveBeenCalledTimes(1);
      expect(await state(row.id)).toMatchObject({ status: 'sent', message_id: result.key.id, error: null });
      await expect(deliverScheduledWaOutbox(row.outbox, provider)).rejects.toThrow(/disponible/);
      expect(provider).toHaveBeenCalledTimes(1);
      expect((await state(row.id)).status).toBe('sent');
    } finally { log.mockRestore(); }
  });

  it('fails an uncertain provider result without automatically calling the provider again', async () => {
    const row = await sending();
    const provider = vi.fn(async () => undefined);
    await expect(deliverScheduledWaOutbox(row.outbox, provider)).rejects.toThrow(/no confirmó/);
    expect(await state(row.id)).toMatchObject({ status: 'failed', message_id: null });
    const firstError = (await state(row.id)).error;
    await expect(deliverScheduledWaOutbox(row.outbox, provider)).rejects.toThrow(/disponible/);
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await state(row.id)).error).toBe(firstError);
  });

  it('never replays after a provider throws with an uncertain send result', async () => {
    const row = await sending();
    const provider = vi.fn(async () => { throw new Error('synthetic connection lost after send'); });
    await expect(deliverScheduledWaOutbox(row.outbox, provider)).rejects.toThrow(/connection lost/);
    expect((await state(row.id)).status).toBe('failed');
    await expect(deliverScheduledWaOutbox(row.outbox, provider)).rejects.toThrow(/disponible/);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('rechecks token revocation at the final boundary and never calls the provider', async () => {
    const row = await sending();
    const provider = vi.fn(async () => ({ key: { id: 'MUST-NOT-SEND' } }));
    await pool.query('UPDATE mcp_tokens SET revoked_at=now() WHERE id=$1', [token]);
    try {
      await expect(deliverScheduledWaOutbox(row.outbox, provider)).rejects.toThrow(/revocada/);
      expect(provider).not.toHaveBeenCalled();
      expect((await state(row.id)).status).toBe('failed');
    } finally { await pool.query('UPDATE mcp_tokens SET revoked_at=NULL WHERE id=$1', [token]); }
  });
});
