/**
 * Conectar WhatsApp: API de cuentas y chats + guardado del puente (sin hablar con
 * WhatsApp). Necesita el API corriendo (API_URL) y su misma base (DATABASE_URL):
 *   set -a; . ./.env; set +a; API_URL=http://localhost:3020 npx vitest run test/whatsapp.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { bridgeToTieComs, rememberSenders, storeAliases, storeMessages, upsertChats, upsertContacts, type MsgRow, type Session } from '../src/modules/wa-sync.ts';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

async function signup(name: string) {
  const r = await call('/auth/signup', { body: {
    name, orgName: `${name} ${run}`, email: `${name.toLowerCase()}.${run}@example.com`, password: 'clave-segura-123',
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string };
}

let ana: { token: string; id: string }, beto: { token: string; id: string };
let personal: any, business: any, generalId: string;
const session = (acc: any): Session => ({ id: acc.id, userId: ana.id, kind: acc.kind, pairPhone: null, sock: null, stopping: false, retries: 0, registered: true, me: '573000000000@s.whatsapp.net', notifyTimer: null });

beforeAll(async () => {
  ana = await signup('Ana');
  beto = await signup('Beto');
  const ws = await call('/workspaces', { token: ana.token, body: { name: `Proyecto ${run}` } });
  generalId = ws.json.generalConversationId;
});
afterAll(async () => { await pool.end(); });

describe('cuentas', () => {
  it('conecta la personal y la Business de la misma persona', async () => {
    const a = await call('/whatsapp/accounts', { token: ana.token, body: { label: 'Personal', kind: 'personal' } });
    const b = await call('/whatsapp/accounts', { token: ana.token, body: { label: 'Negocio', kind: 'business', pairPhone: '+57 (300) 123-4567' } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.json.status).toBe('pending');
    personal = a.json; business = b.json;
    // Synthetic provider fixture: no real socket or app-state hydration.
    await pool.query(`UPDATE wa_accounts SET privacy_synced_at=now(),lease_owner='fixture',lease_until=now()+interval '1 hour' WHERE id=ANY($1)`,[[personal.id,business.id]]);
    const { rows } = await pool.query('SELECT pair_phone FROM wa_accounts WHERE id = $1', [business.id]);
    expect(rows[0].pair_phone).toBe('573001234567');
    const list = await call('/whatsapp/accounts', { token: ana.token });
    expect(list.json.accounts.map((x: any) => x.label)).toEqual(['Personal', 'Negocio']);
  });

  it('rechaza un número inválido y no deja pasar el límite', async () => {
    const bad = await call('/whatsapp/accounts', { token: beto.token, body: { label: 'X', kind: 'personal', pairPhone: '123' } });
    expect(bad.status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await call('/whatsapp/accounts', { token: beto.token, body: { label: `B${i}`, kind: 'personal' } })).status).toBe(200);
    expect((await call('/whatsapp/accounts', { token: beto.token, body: { label: 'B6', kind: 'personal' } })).status).toBe(409);
  });

  it('nadie más ve ni toca las cuentas de otra persona', async () => {
    expect((await call(`/whatsapp/accounts/${personal.id}`, { token: beto.token, method: 'DELETE' })).status).toBe(404);
    const list = await call('/whatsapp/accounts', { token: beto.token });
    expect(list.json.accounts.some((x: any) => x.id === personal.id)).toBe(false);
  });
});

describe('chats y organización', () => {
  it('guarda grupos, sugiere categoría y cuenta no leídos', async () => {
    const s = session(personal);
    await upsertChats(s, [
      { jid: '1@g.us', name: 'Equipo de producto', isGroup: true, participants: 8 },
      { jid: '2@g.us', name: 'Familia López', isGroup: true, participants: 12 },
      { jid: '573111@s.whatsapp.net', name: null, isGroup: false },
    ]);
    await upsertContacts(s, [{ id: '573111@s.whatsapp.net', name: 'Mamá' }]);
    const msgs: MsgRow[] = [
      { chat: '1@g.us', id: 'a1', fromMe: false, authorJid: '5731@s.whatsapp.net', authorName: 'Laura', kind: 'text', body: 'Hola equipo', sentAt: new Date() },
      { chat: '1@g.us', id: 'a2', fromMe: false, authorJid: '5731@s.whatsapp.net', authorName: 'Laura', kind: 'text', body: '¿Revisamos?', sentAt: new Date(Date.now() + 1000) },
      { chat: '9@g.us', id: 'z1', fromMe: false, authorJid: '5732@s.whatsapp.net', authorName: 'Pedro', kind: 'text', body: 'grupo nuevo', sentAt: new Date() },
    ];
    const ins = await storeMessages(s, msgs, true);
    expect(ins).toHaveLength(3);
    // Repetir no duplica.
    expect(await storeMessages(s, msgs, true)).toHaveLength(0);

    const r = await call('/whatsapp/chats', { token: ana.token });
    const by = Object.fromEntries(r.json.chats.map((c: any) => [c.jid, c]));
    expect(by['1@g.us'].category).toBe('trabajo');
    expect(by['1@g.us'].unread).toBe(2);
    expect(by['1@g.us'].lastPreview).toBe('Laura: ¿Revisamos?');
    expect(by['2@g.us'].category).toBe('familia');
    expect(by['9@g.us']).toBeTruthy();
    expect(by['573111@s.whatsapp.net'].name).toBe('Mamá');
    const org = await call('/whatsapp/organize', { token: ana.token, body: {} });
    expect(org.json.changed).toBeGreaterThanOrEqual(1);
    const after = await call('/whatsapp/chats?groups=0', { token: ana.token });
    expect(after.json.chats.find((c: any) => c.jid === '573111@s.whatsapp.net').category).toBe('familia');
  });

  it('lo que se mueve a mano no lo vuelve a tocar el organizador', async () => {
    const p = await call(`/whatsapp/chats/${personal.id}/${encodeURIComponent('2@g.us')}`, { token: ana.token, method: 'PATCH', body: { category: 'amigos' } });
    expect(p.json.categoryManual).toBe(true);
    await call('/whatsapp/organize', { token: ana.token, body: {} });
    const r = await call('/whatsapp/chats?category=amigos', { token: ana.token });
    expect(r.json.chats.map((c: any) => c.jid)).toContain('2@g.us');
    expect((await call(`/whatsapp/chats/${personal.id}/${encodeURIComponent('2@g.us')}`, { token: beto.token, method: 'PATCH', body: { pinned: true } })).status).toBe(404);
  });

  it('leer los mensajes los marca como leídos solo en Chaggu', async () => {
    const m = await call(`/whatsapp/chats/${personal.id}/${encodeURIComponent('1@g.us')}/messages`, { token: ana.token });
    expect(m.json.messages.map((x: any) => x.body)).toEqual(['Hola equipo', '¿Revisamos?']);
    const r = await call('/whatsapp/chats', { token: ana.token });
    expect(r.json.chats.find((c: any) => c.jid === '1@g.us').unread).toBe(0);
  });
});

describe('nombres de quienes escriben', () => {
  it('resuelve LID → número → contacto, usa el pushName y si no, el número', async () => {
    const s = session(personal);
    const g = '77@g.us';
    await upsertChats(s, [{ jid: g, name: 'Clientes', isGroup: true }, { jid: '111@lid', name: null, isGroup: false }]);
    await storeAliases(s, [{ lid: '111@lid', pn: '573005550001@s.whatsapp.net' }, { lid: '333@lid', pn: '573005550003@s.whatsapp.net' }]);
    await upsertContacts(s, [{ id: '573005550001@s.whatsapp.net', name: 'Laura Libreta' }]);
    // pushName de un mensaje en vivo (no pisa la libreta) y par LID ↔ número desde la llave del mensaje.
    await rememberSenders(s, [
      { key: { remoteJid: g, id: 'x1', participant: '222@lid', participantAlt: '573005550002@s.whatsapp.net' } as any, pushName: 'Mateo' },
      { key: { remoteJid: g, id: 'x2', participant: '111@lid' } as any, pushName: 'Apodo que no pisa' },
    ] as any);
    const at = new Date('2026-09-27T12:00:00Z');
    const row = (id: string, author: string): MsgRow => ({ chat: g, id, fromMe: false, authorJid: author, authorName: null, kind: 'text', body: id, sentAt: new Date(at.getTime() + Number(id.slice(1)) * 1000) });
    await storeMessages(s, [row('m1', '111@lid'), row('m2', '222@lid'), row('m3', '333@lid'), row('m4', '444@lid')], false);
    const r = await call(`/whatsapp/chats/${personal.id}/${encodeURIComponent(g)}/messages`, { token: ana.token });
    expect(r.status).toBe(200);
    expect(r.json.messages.map((m: any) => m.author)).toEqual(['Laura Libreta', 'Mateo', '+57 300 5550003', null]);
    const dm = await call(`/whatsapp/chats?accountId=${personal.id}&groups=0&limit=100`, { token: ana.token });
    // El directo que existía por LID se une al chat del número (103_wa_lid_merge.sql): uno solo, con nombre.
    expect(dm.json.chats.find((c: any) => c.jid === '111@lid')).toBeUndefined();
    expect(dm.json.chats.find((c: any) => c.jid === '573005550001@s.whatsapp.net')?.name).toBe('Laura Libreta');
  });
});

describe('vincular un chat a una conversación de Chaggu', () => {
  it('solo a conversaciones donde la persona puede publicar', async () => {
    const other = await call('/workspaces', { token: beto.token, body: { name: `Ajeno ${run}` } });
    const bad = await call(`/whatsapp/chats/${personal.id}/${encodeURIComponent('1@g.us')}`, { token: ana.token, method: 'PATCH', body: { linkedConversationId: other.json.generalConversationId } });
    expect(bad.status).toBe(404);
  });

  it('los mensajes nuevos llegan una sola vez, como reenviados de WhatsApp', async () => {
    const ok = await call(`/whatsapp/chats/${personal.id}/${encodeURIComponent('1@g.us')}`, { token: ana.token, method: 'PATCH', body: { linkedConversationId: generalId } });
    expect(ok.json.linkedConversationId).toBe(generalId);
    const s = session(personal);
    const old: MsgRow = { chat: '1@g.us', id: 'old', fromMe: false, authorJid: null, authorName: 'Laura', kind: 'text', body: 'de antes', sentAt: new Date(Date.now() - 3600_000) };
    const fresh: MsgRow = { chat: '1@g.us', id: 'b1', fromMe: false, authorJid: null, authorName: 'Laura', kind: 'text', body: 'Listo el despliegue', sentAt: new Date(Date.now() + 5000) };
    await bridgeToTieComs(s, [old, fresh]);
    await bridgeToTieComs(s, [fresh]);
    const msgs = await call(`/conversations/${generalId}/messages`, { token: ana.token });
    const fw = msgs.json.messages.filter((m: any) => m.forwarded?.source === 'whatsapp');
    expect(fw).toHaveLength(1);
    expect(fw[0].body).toBe('Listo el despliegue');
    expect(fw[0].forwarded.author).toBe('Laura');
    expect(fw[0].authorId).toBe(ana.id);
  });
});

describe('responder desde chaggu (apagado por defecto)', () => {
  const jid = '1@g.us';
  const send = (token: string, accountId: string, text: unknown) => call(`/whatsapp/chats/${accountId}/${encodeURIComponent(jid)}/send`, { token, body: { text } });
  /** Hace de puente: espera lo encolado y le pone el resultado. */
  const bridge = async (status: 'sent' | 'failed', error?: string) => {
    for (let i = 0; i < 40; i++) {
      const { rows } = await pool.query("SELECT id FROM wa_outbox WHERE account_id = $1 AND status = 'queued'", [personal.id]);
      if (rows[0]) { await pool.query('UPDATE wa_outbox SET status = $2, error = $3, body = $4 WHERE id = $1', [rows[0].id, status, error ?? null, '']); return; }
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it('la cuenta nace en solo lectura y no deja enviar', async () => {
    expect(personal.sendEnabled).toBe(false);
    expect((await send(ana.token, personal.id, 'hola')).status).toBe(403);
    expect((await pool.query('SELECT count(*)::int AS n FROM wa_outbox WHERE account_id = $1', [personal.id])).rows[0].n).toBe(0);
  });

  it('solo su dueña lo activa; otra persona no puede enviar por su cuenta', async () => {
    expect((await call(`/whatsapp/accounts/${personal.id}`, { token: beto.token, method: 'PATCH', body: { sendEnabled: true } })).status).toBe(404);
    const on = await call(`/whatsapp/accounts/${personal.id}`, { token: ana.token, method: 'PATCH', body: { sendEnabled: true } });
    expect(on.status).toBe(200);
    expect(on.json.sendEnabled).toBe(true);
    expect((await send(beto.token, personal.id, 'hola')).status).toBe(404);
  });

  it('con la cuenta sin conectar responde 409 y no encola', async () => {
    expect((await send(ana.token, personal.id, 'hola')).status).toBe(409);
    expect((await pool.query('SELECT count(*)::int AS n FROM wa_outbox WHERE account_id = $1', [personal.id])).rows[0].n).toBe(0);
  });

  it('conectada: encola, el puente lo manda y la respuesta dice enviado', async () => {
    await pool.query("UPDATE wa_accounts SET status = 'connected' WHERE id = $1", [personal.id]);
    expect((await send(ana.token, personal.id, '   ')).status).toBe(400);
    expect((await send(ana.token, personal.id, 'x'.repeat(4001))).status).toBe(400);
    const [r] = await Promise.all([send(ana.token, personal.id, 'Hola equipo, ya quedó.'), bridge('sent')]);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('sent');
  });

  it('si el puente no pudo mandarlo, devuelve failed con el motivo', async () => {
    const [r] = await Promise.all([send(ana.token, personal.id, 'otro'), bridge('failed', 'La sesión de WhatsApp no está lista')]);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'failed', error: 'La sesión de WhatsApp no está lista' });
  });

  it('sin puente atendiendo, queda en cola (no se pierde)', async () => {
    const r = await send(ana.token, personal.id, 'en cola');
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('queued');
    const row = (await pool.query("SELECT status, body FROM wa_outbox WHERE account_id = $1 AND id = $2", [personal.id, r.json.id])).rows[0];
    expect(row).toMatchObject({ status: 'queued', body: 'en cola' });
    await pool.query("UPDATE wa_outbox SET status = 'failed', body = '' WHERE id = $1", [r.json.id]);
  }, 30_000);

  it('apagarlo vuelve a cerrar el envío', async () => {
    const off = await call(`/whatsapp/accounts/${personal.id}`, { token: ana.token, method: 'PATCH', body: { sendEnabled: false } });
    expect(off.json.sendEnabled).toBe(false);
    expect((await send(ana.token, personal.id, 'hola')).status).toBe(403);
  });

  it('responder un correo en vivo pide un texto (y la sesión)', async () => {
    const bad = await call('/mail/messages/google/abc/reply', { token: ana.token, body: { body: '   ' } });
    expect(bad.status).toBe(400);
    expect((await call('/mail/messages/google/abc/reply', { body: { body: 'hola' } })).status).toBe(401);
  });
});

describe('WhatsApp en la bandeja (Grupos/DMs)', () => {
  const path = (jid: string) => `/whatsapp/chats/${personal.id}/${encodeURIComponent(jid)}`;
  const patch = (token: string, jid: string, body: unknown) => call(path(jid), { token, method: 'PATCH', body });
  const inbox = async (token: string) => ((await call('/bootstrap', { token })).json.waInbox ?? []) as any[];
  const events = async (jid: string, since: number) => (await pool.query(
    "SELECT payload FROM outbox WHERE id > $1 AND topic = 'account.event' AND payload->'event'->>'type' = 'wa.inbox' AND payload->'event'->'chat'->>'jid' = $2 ORDER BY id",
    [since, jid])).rows.map((r) => r.payload);
  const lastOutbox = async () => Number((await pool.query('SELECT COALESCE(max(id), 0) AS n FROM outbox')).rows[0].n);

  it('nace fuera de la bandeja; «auto» manda el grupo a Grupos y el 1 a 1 a DMs', async () => {
    expect((await inbox(ana.token)).length).toBe(0);
    const since = await lastOutbox();
    const g = await patch(ana.token, '1@g.us', { inboxPlace: 'auto' });
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ inboxPlace: 'groups', inboxPinnedAt: null, pinned: false });
    expect(g.json.accountStatus).toBeTruthy();
    const d = await patch(ana.token, '573111@s.whatsapp.net', { inboxPlace: 'auto' });
    expect(d.json.inboxPlace).toBe('dms');
    const list = await inbox(ana.token);
    expect(list.map((c) => [c.jid, c.inboxPlace]).sort()).toEqual([['1@g.us', 'groups'], ['573111@s.whatsapp.net', 'dms']]);
    // Aviso a la dueña para actualizar la fila sin recargar.
    const ev = await events('1@g.us', since);
    expect(ev).toHaveLength(1);
    expect(ev[0].userIds).toEqual([ana.id]);
    expect(ev[0].event.chat.inboxPlace).toBe('groups');
  });

  it('fijar y quitar: no toca el fijado de WhatsApp; fijar sin mover lo mueve solo', async () => {
    const p = await patch(ana.token, '1@g.us', { inboxPinned: true });
    expect(p.json.inboxPinnedAt).toBeTruthy();
    expect(p.json.pinned).toBe(false);
    const again = await patch(ana.token, '1@g.us', { inboxPinned: true });
    expect(again.json.inboxPinnedAt).toBe(p.json.inboxPinnedAt);
    const u = await patch(ana.token, '1@g.us', { inboxPinned: false });
    expect(u.json).toMatchObject({ inboxPinnedAt: null, inboxPlace: 'groups' });
    const solo = await patch(ana.token, '2@g.us', { inboxPinned: true });
    expect(solo.json).toMatchObject({ inboxPlace: 'groups' });
    expect(solo.json.inboxPinnedAt).toBeTruthy();
  });

  it('cambiar de sección y sacar de la bandeja (también lo desfija)', async () => {
    const m = await patch(ana.token, '2@g.us', { inboxPlace: 'dms' });
    expect(m.json.inboxPlace).toBe('dms');
    expect(m.json.inboxPinnedAt).toBeTruthy();
    const out = await patch(ana.token, '2@g.us', { inboxPlace: null });
    expect(out.json).toMatchObject({ inboxPlace: null, inboxPinnedAt: null });
    expect((await inbox(ana.token)).some((c) => c.jid === '2@g.us')).toBe(false);
    // Sigue en la pantalla WhatsApp.
    expect((await call('/whatsapp/chats', { token: ana.token })).json.chats.some((c: any) => c.jid === '2@g.us')).toBe(true);
    expect((await patch(ana.token, '2@g.us', { inboxPlace: 'otra' })).status).toBe(400);
  });

  it('no sale en el bootstrap de otra persona y ella no lo puede mover', async () => {
    expect((await inbox(beto.token)).length).toBe(0);
    expect((await patch(beto.token, '1@g.us', { inboxPinned: true })).status).toBe(404);
  });

  it('un chat oculto no sale en la bandeja', async () => {
    await patch(ana.token, '573111@s.whatsapp.net', { hidden: true });
    expect((await inbox(ana.token)).some((c) => c.jid === '573111@s.whatsapp.net')).toBe(false);
    await patch(ana.token, '573111@s.whatsapp.net', { hidden: false });
    expect((await inbox(ana.token)).some((c) => c.jid === '573111@s.whatsapp.net')).toBe(true);
  });

  it('un mensaje nuevo en un chat de la bandeja emite wa.inbox con la fila al día; fuera de la bandeja no', async () => {
    const since = await lastOutbox();
    const s = session(personal);
    const at = new Date(Date.now() + 60_000);
    await storeMessages(s, [
      { chat: '1@g.us', id: `in-${run}`, fromMe: false, authorJid: '5731@s.whatsapp.net', authorName: 'Laura', kind: 'text', body: 'Nuevo en la bandeja', sentAt: at },
      { chat: '2@g.us', id: `out-${run}`, fromMe: false, authorJid: '5732@s.whatsapp.net', authorName: 'Pedro', kind: 'text', body: 'fuera', sentAt: at },
    ], true);
    const ev = await events('1@g.us', since);
    expect(ev).toHaveLength(1);
    expect(ev[0].event.chat).toMatchObject({ unread: 1, lastPreview: 'Laura: Nuevo en la bandeja', inboxPlace: 'groups' });
    expect(await events('2@g.us', since)).toHaveLength(0);
    const row = (await inbox(ana.token)).find((c) => c.jid === '1@g.us');
    expect(row.unread).toBe(1);
    expect(row.lastMessageAt).toBe(at.toISOString());
  });
});

describe('desconectar', () => {
  it('marca la cuenta para que el puente cierre la sesión y la borre', async () => {
    expect((await call(`/whatsapp/accounts/${business.id}`, { token: ana.token, method: 'DELETE' })).status).toBe(200);
    const list = await call('/whatsapp/accounts', { token: ana.token });
    expect(list.json.accounts.map((x: any) => x.id)).toEqual([personal.id]);
  });
});
