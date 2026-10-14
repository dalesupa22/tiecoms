/**
 * Llevar varios mensajes de WhatsApp juntos (POST /whatsapp/share con messageIds): una sola tarjeta con wa.items en
 * orden de envío. Necesita el API (API_URL) y su misma base (DATABASE_URL). Solo texto: no toca S3.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
async function call(path: string, token: string, body?: unknown) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

let token = '', userId = '', notes = '', acc = '';
const jid = `5730000${run.replace(/\D/g, '0').slice(0, 5)}@s.whatsapp.net`;

beforeAll(async () => {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name: 'Ana Varios', email: `ana.wa.${run}@example.com`, password: 'clave-segura-123', orgName: `Ana SAS ${run}`, device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  token = j.accessToken; userId = j.user.id;
  notes = (await call('/me/notes', token, {})).json.id;
  acc = (await pool.query("INSERT INTO wa_accounts (user_id, label, kind, status, privacy_synced_at,lease_owner,lease_until) VALUES ($1,'Personal','personal','connected',now(),'fixture',now()+interval '1 hour') RETURNING id", [userId])).rows[0].id;
  await pool.query("INSERT INTO wa_chats (account_id, jid, name, is_group) VALUES ($1,$2,'Proveedor',false)", [acc, jid]);
  // Llegan desordenados a propósito: la tarjeta va en orden de envío.
  await pool.query(`INSERT INTO wa_messages (account_id, chat_jid, id, from_me, author_name, body, sent_at) VALUES
    ($1,$2,'B2',true,null,'Perfecto, mándame la cotización', now() - interval '2 minutes'),
    ($1,$2,'B1',false,'Jorge','Hola, ya tengo los precios', now() - interval '3 minutes'),
    ($1,$2,'B3',false,'Jorge','Va adjunta, vence el viernes', now() - interval '1 minute')`, [acc, jid]);
});

describe('WhatsApp: varios mensajes en una tarjeta', () => {
  it('una sola tarjeta con wa.items en orden de envío', async () => {
    const r = await call('/whatsapp/share', token, { accountId: acc, jid, messageIds: ['B3', 'B1', 'B2'], conversationIds: [notes], comment: 'Mira esto', clientMessageId: `bundle-${run}` });
    expect(r.status).toBe(201);
    expect(r.json.emails).toHaveLength(1);
    const e = r.json.emails[0];
    expect(e.wa.items.map((x: any) => x.waMessageId)).toEqual(['B1', 'B2', 'B3']);
    expect(e.wa.items[0]).toMatchObject({ author: 'Jorge', fromMe: false, text: 'Hola, ya tengo los precios', attachmentId: null });
    expect(e.wa.items[1]).toMatchObject({ author: 'Ana Varios', fromMe: true });
    expect(e.wa.items[0].sentAt).toMatch(/Z$/);
    expect(e).toMatchObject({ provider: 'whatsapp', subject: 'Proveedor', direction: 'in', comment: 'Mira esto' });
    expect(e.from.name).toBe('Jorge, Ana Varios');
    // Un solo mensaje de sistema; los clientes viejos leen el texto completo.
    const sys = ((await call(`/conversations/${notes}/messages?limit=50`, token)).json.messages as any[]).filter((m) => m.kind === 'system' && m.body.startsWith('{"k":"wa.shared"'));
    expect(sys).toHaveLength(1);
    const b = JSON.parse(sys[0].body);
    expect(b).toMatchObject({ emailId: e.id, count: 3, waMessageId: 'B1', fromMe: false });
    expect(b.text).toBe('Jorge: Hola, ya tengo los precios\nAna Varios: Perfecto, mándame la cotización\nJorge: Va adjunta, vence el viernes');
    // La tarjeta completa trae lo mismo.
    expect((await call(`/mail/shared/${e.id}`, token)).json.wa.items).toHaveLength(3);
  });

  it('reintentar con la misma clave no duplica; con otros mensajes es un error', async () => {
    const body = { accountId: acc, jid, messageIds: ['B1', 'B2', 'B3'], conversationIds: [notes], comment: 'Mira esto', clientMessageId: `bundle-${run}` };
    const again = await call('/whatsapp/share', token, body);
    expect(again.status).toBe(201);
    const count = (await pool.query("SELECT count(*)::int AS n FROM shared_emails WHERE conversation_id=$1 AND share_client_id=$2", [notes, `bundle-${run}`])).rows[0].n;
    expect(count).toBe(1);
    expect((await call('/whatsapp/share', token, { ...body, messageIds: ['B1', 'B2'] })).status).toBe(400);
  });

  it('un solo mensaje sigue como antes (sin items), por messageId o messageIds', async () => {
    for (const body of [{ messageId: 'B1' }, { messageIds: ['B2'] }]) {
      const r = await call('/whatsapp/share', token, { accountId: acc, jid, ...body, conversationIds: [notes] });
      expect(r.status).toBe(201);
      expect(r.json.emails[0].wa.items).toBeUndefined();
    }
  });

  it('mensajes de otro chat o inexistentes: 404; más de 10 archivos: 400; sin mensajes: 400', async () => {
    expect((await call('/whatsapp/share', token, { accountId: acc, jid, messageIds: ['B1', 'NOPE'], conversationIds: [notes] })).status).toBe(404);
    const values = Array.from({ length: 11 }, (_, i) => `($1,$2,'F${i}',false,'Jorge','',now(),'image','ready','{"key":"x","name":"f.jpg","contentType":"image/jpeg","sizeBytes":1}'::jsonb)`).join(',');
    await pool.query(`INSERT INTO wa_messages (account_id, chat_jid, id, from_me, author_name, body, sent_at, kind, media_state, media_info) VALUES ${values}`, [acc, jid]);
    const many = await call('/whatsapp/share', token, { accountId: acc, jid, messageIds: Array.from({ length: 11 }, (_, i) => `F${i}`), conversationIds: [notes] });
    expect(many.status).toBe(400);
    expect(JSON.stringify(many.json)).toContain('Máximo 10');
    expect((await call('/whatsapp/share', token, { accountId: acc, jid, conversationIds: [notes] })).status).toBe(400);
  });
});
