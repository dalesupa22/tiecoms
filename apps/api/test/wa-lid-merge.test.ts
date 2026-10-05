/**
 * Chats 1:1 por LID (103_wa_lid_merge.sql): un directo que WhatsApp entrega con LID entra al chat de siempre
 * (el del número) y los duplicados que ya existían se unen sin perder mensajes, bandeja ni privacidad.
 * API (API_URL) y su misma base (DATABASE_URL). Datos sintéticos; nunca toca WhatsApp.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { storeAliases, storeMessages, storeReaction, upsertChats, type MsgRow, type Session } from '../src/modules/wa-sync.ts';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
const n = () => String(Math.floor(1e9 + Math.random() * 9e9));
let s: Session;

async function call(path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.body ? 'POST' : 'GET',
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const msg = (chat: string, body: string, o: Partial<MsgRow> = {}): MsgRow =>
  ({ chat, id: randomUUID().slice(0, 16), fromMe: false, authorJid: chat, authorName: 'Danny', kind: 'text', body, sentAt: new Date(), ...o });
const chats = async (jids: string[]) =>
  (await pool.query('SELECT * FROM wa_chats WHERE account_id = $1 AND jid = ANY($2) ORDER BY jid', [s.id, jids])).rows;
const messages = async (jid: string) =>
  (await pool.query('SELECT id, body, reactions FROM wa_messages WHERE account_id = $1 AND chat_jid = $2 ORDER BY sent_at', [s.id, jid])).rows;

beforeAll(async () => {
  const r = await call('/api/v1/auth/signup', { body: { name: 'Cesar', orgName: `Cesar SAS ${run}`, email: `cesar.lid.${run}@example.com`, password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' } } });
  expect(r.status).toBe(200);
  const account = (await call('/api/v1/whatsapp/accounts', { token: r.json.accessToken, body: { label: 'Personal', kind: 'personal' } })).json.id;
  await pool.query(`UPDATE wa_accounts SET status='connected', privacy_synced_at=now(), lease_owner='fixture', lease_until=now()+interval '1 hour' WHERE id=$1`, [account]);
  s = { id: account, userId: r.json.user.id, kind: 'personal', pairPhone: null, sock: null, stopping: false, retries: 0, registered: true, me: null, notifyTimer: null, leaseOwner: 'fixture' } as Session;
});
afterAll(async () => { await pool.end(); });

describe('chats 1:1 con LID', () => {
  it('un directo que llega por LID entra al chat del número cuando ya se conoce la equivalencia', async () => {
    const pn = `57${n()}@s.whatsapp.net`, lid = `${n()}${n()}@lid`;
    await upsertChats(s, [{ jid: pn, name: 'Danny Suárez', isGroup: false }]);
    await storeMessages(s, [msg(pn, 'hola de antes', { sentAt: new Date(Date.now() - 60_000) })], false);
    await storeAliases(s, [{ lid, pn }]);
    const inserted = await storeMessages(s, [msg(lid, 'Prueba chaggu')], true);
    await upsertChats(s, [{ jid: lid, name: null, isGroup: false, lastAt: new Date() }]);
    expect(inserted.map((m) => m.chat)).toEqual([pn]);
    expect((await chats([pn, lid])).map((c) => c.jid)).toEqual([pn]);
    expect((await messages(pn)).map((m) => m.body)).toEqual(['hola de antes', 'Prueba chaggu']);
    const [c] = await chats([pn]);
    expect(c.name).toBe('Danny Suárez');
    expect(c.unread).toBe(1);
    expect(c.last_preview).toBe('Prueba chaggu');
  });

  it('las reacciones a un mensaje del chat LID se guardan en el chat del número', async () => {
    const pn = `57${n()}@s.whatsapp.net`, lid = `${n()}${n()}@lid`;
    await storeAliases(s, [{ lid, pn }]);
    const [m] = await storeMessages(s, [msg(lid, 'reacciona aquí')], true);
    await storeReaction(s, { key: { remoteJid: lid, fromMe: false, id: randomUUID() }, pushName: 'Danny',
      message: { reactionMessage: { key: { remoteJid: lid, id: m!.id }, text: '👍' } } } as any);
    expect(Object.values((await messages(pn))[0].reactions ?? {})).toEqual([{ emoji: '👍', name: 'Danny' }]);
  });

  it('cuando la equivalencia llega después, une el chat LID con el del número sin perder nada', async () => {
    const pn = `57${n()}@s.whatsapp.net`, lid = `${n()}${n()}@lid`, other = `${n()}${n()}@lid`;
    await upsertChats(s, [{ jid: pn, name: 'Laura', isGroup: false }]);
    const shared = msg(pn, 'mismo mensaje', { sentAt: new Date(Date.now() - 120_000) });
    await storeMessages(s, [msg(pn, 'por número', { sentAt: new Date(Date.now() - 180_000) }), shared], true);
    await storeMessages(s, [msg(lid, 'por LID'), { ...shared, chat: lid }], true);
    await pool.query(`UPDATE wa_messages SET reactions = '{"x@lid":{"emoji":"❤️","name":"Laura"}}' WHERE account_id=$1 AND chat_jid=$2 AND id=$3`, [s.id, lid, shared.id]);
    await pool.query(`UPDATE wa_chats SET inbox_place='dms', inbox_pinned_at=now(), reading_list=true, reading_since=now() WHERE account_id=$1 AND jid=$2`, [s.id, lid]);
    await pool.query(`INSERT INTO wa_drafts (user_id, account_id, jid, body) VALUES ($1,$2,$3,'borrador')`, [s.userId, s.id, lid]);
    await pool.query(`INSERT INTO gg_side_state (user_id, source, pending_count) VALUES ($1,$2,2),($1,$3,1)`, [s.userId, `wa:${s.id}:${lid}`, `wa:${s.id}:${pn}`]);
    // Un chat LID sin chat de número: se renombra.
    await storeMessages(s, [msg(other, 'solo LID')], true);

    await storeAliases(s, [{ lid, pn }, { lid: other, pn: `57${n()}@s.whatsapp.net` }]);

    expect((await chats([lid, other]))).toEqual([]);
    expect((await messages(pn)).map((m) => m.body)).toEqual(['por número', 'mismo mensaje', 'por LID']);
    expect((await messages(pn))[1].reactions).toEqual({ 'x@lid': { emoji: '❤️', name: 'Laura' } });
    const [c] = await chats([pn]);
    expect(c).toMatchObject({ name: 'Laura', unread: 4, inbox_place: 'dms', reading_list: true, last_preview: 'por LID' });
    expect((await pool.query('SELECT jid FROM wa_drafts WHERE account_id=$1', [s.id])).rows.map((r) => r.jid)).toEqual([pn]);
    expect((await pool.query('SELECT source, pending_count FROM gg_side_state WHERE user_id=$1', [s.userId])).rows)
      .toEqual([{ source: `wa:${s.id}:${pn}`, pending_count: 3 }]);
    const renamed = (await pool.query(`SELECT c.jid FROM wa_chats c JOIN wa_jid_alias al ON al.account_id=c.account_id AND al.pn=c.jid WHERE al.lid=$1`, [other])).rows;
    expect(renamed).toHaveLength(1);
  });

  it('si cualquiera de los dos estaba bloqueado, el chat unido sigue oculto', async () => {
    const pn = `57${n()}@s.whatsapp.net`, lid = `${n()}${n()}@lid`;
    await upsertChats(s, [{ jid: pn, name: 'Privado', isGroup: false }]);
    await storeMessages(s, [msg(pn, 'secreto')], true);
    await storeMessages(s, [msg(lid, 'secreto por LID')], true);
    await pool.query('UPDATE wa_chats SET wa_locked=true, wa_lock_revision=5 WHERE account_id=$1 AND jid=$2', [s.id, lid]);
    await storeAliases(s, [{ lid, pn }]);
    const [c] = await chats([pn]);
    expect(c.wa_locked).toBe(true);
    expect((await pool.query('SELECT wa_chat_visible($1,$2) AS v', [s.id, pn])).rows[0].v).toBe(false);
  });
});
