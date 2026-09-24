/**
 * Conectar WhatsApp: API de cuentas y chats + guardado del puente (sin hablar con
 * WhatsApp). Necesita el API corriendo (API_URL) y su misma base (DATABASE_URL):
 *   set -a; . ./.env; set +a; API_URL=http://localhost:3020 npx vitest run test/whatsapp.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { bridgeToTieComs, storeMessages, upsertChats, upsertContacts, type MsgRow, type Session } from '../src/modules/wa-sync.ts';

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

  it('leer los mensajes los marca como leídos solo en TieComs', async () => {
    const m = await call(`/whatsapp/chats/${personal.id}/${encodeURIComponent('1@g.us')}/messages`, { token: ana.token });
    expect(m.json.messages.map((x: any) => x.body)).toEqual(['Hola equipo', '¿Revisamos?']);
    const r = await call('/whatsapp/chats', { token: ana.token });
    expect(r.json.chats.find((c: any) => c.jid === '1@g.us').unread).toBe(0);
  });
});

describe('vincular un chat a una conversación de TieComs', () => {
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

describe('desconectar', () => {
  it('marca la cuenta para que el puente cierre la sesión y la borre', async () => {
    expect((await call(`/whatsapp/accounts/${business.id}`, { token: ana.token, method: 'DELETE' })).status).toBe(200);
    const list = await call('/whatsapp/accounts', { token: ana.token });
    expect(list.json.accounts.map((x: any) => x.id)).toEqual([personal.id]);
  });
});
