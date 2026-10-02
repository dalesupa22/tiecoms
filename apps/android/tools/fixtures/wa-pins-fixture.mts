/**
 * Fixture para WaPinesUiTest (2-oct-2026): una persona con 2 cuentas de WhatsApp conectadas (sintéticas, sin teléfono),
 * chats de trabajo, clientes y familia con mensajes, un grupo de chaggu y Gmail conectado al proveedor FALSO (test/fake-mail.mjs).
 * Solo API local. Se corre desde apps/api del worktree del API (usa su base y sus módulos):
 *   cd <api> && API_URL=http://localhost:3099 FAKE_MAIL=http://localhost:59399 FIXTURE_OUT=/tmp/wa.json \
 *     npx tsx --env-file=<env> <android>/tools/fixtures/wa-pins-fixture.mts
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:3099';
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(API)) throw new Error('Solo contra un API local');
const apiDir = process.cwd();
const { pool } = await import(resolve(apiDir, 'src/db.ts'));
const { upsertChats, upsertContacts, storeMessages } = await import(resolve(apiDir, 'src/modules/wa-sync.ts'));
const run = randomUUID().slice(0, 8);
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, { method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), 'x-forwarded-for': ip() },
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json: any = await res.json().catch(() => ({}));
  if (res.status >= 300) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const email = `ana.wa.${run}@example.com`, password = randomBytes(12).toString('base64url');
const su = await call('/auth/signup', { body: { name: 'Ana Pruebas', orgName: `Ana SAS ${run}`, email, password, device: { deviceId: randomUUID(), name: 'fixture', platform: 'web' } } });
const token = su.accessToken as string, userId = su.user.id as string;
const ws = await call('/workspaces', { token, body: { name: `Proyecto ${run}` } });
// Nombre largo: la cabecera del chat debe mostrarlo con «…» y el sello gg pequeñito.
const longGroup = await call(`/workspaces/${ws.id}/conversations`, { token, body: { name: 'Comité de transformación digital y nuevos productos 2026' } });

// Gmail conectado al proveedor falso (flujo OAuth de mentira).
const hash = (s: string) => createHash('sha256').update(s).digest('base64url');
const verifier = randomBytes(32).toString('base64url');
const start = await call('/mail/connect/google', { token, body: { platform: 'web', proofChallenge: hash(verifier) } });
const cb = await fetch((await fetch(start.url, { redirect: 'manual' })).headers.get('location')!, { redirect: 'manual' });
const receipt = new URL(cb.headers.get('location')!).searchParams.get('receipt')!;
await call('/mail/connect/confirm', { token, body: { receipt, proofVerifier: verifier } });

const personal = await call('/whatsapp/accounts', { token, body: { label: 'Personal', kind: 'personal' } });
const business = await call('/whatsapp/accounts', { token, body: { label: 'Negocio', kind: 'business' } });
await pool.query(`UPDATE wa_accounts SET status='connected', privacy_synced_at=now(), lease_owner='fixture', lease_until=now()+interval '6 hours' WHERE id=ANY($1)`, [[personal.id, business.id]]);
const session = (acc: any) => ({ id: acc.id, userId, kind: acc.kind, pairPhone: null, sock: null, stopping: false, retries: 0, registered: true, me: '573000000000@s.whatsapp.net', notifyTimer: null });
const sp = session(personal), sb = session(business);
await upsertChats(sp, [
  { jid: '120363001@g.us', name: 'Equipo de producto', isGroup: true, participants: 8 },
  { jid: '120363002@g.us', name: 'Familia López', isGroup: true, participants: 12 },
  { jid: '573111000001@s.whatsapp.net', name: null, isGroup: false },
  { jid: '120363009@g.us', name: 'Coordinación logística de eventos corporativos fin de año', isGroup: true, participants: 30 },
]);
await upsertContacts(sp, [{ id: '573111000001@s.whatsapp.net', name: 'Mamá' }]);
await upsertChats(sb, [{ jid: '573222000002@s.whatsapp.net', name: null, isGroup: false }, { jid: '120363003@g.us', name: 'Clientes Acme', isGroup: true, participants: 5 }]);
await upsertContacts(sb, [{ id: '573222000002@s.whatsapp.net', name: 'Laura Acme' }]);
const t = Date.now() - 3600_000;
const m = (chat: string, id: string, body: string, i: number, fromMe = false, author: string | null = 'Laura') =>
  ({ chat, id: `${id}-${run}`, fromMe, authorJid: fromMe ? null : '573999@s.whatsapp.net', authorName: fromMe ? null : author, kind: 'text', body, sentAt: new Date(t + i * 60_000) });
await storeMessages(sp, [
  m('120363001@g.us', 'p1', 'Hola equipo, ¿revisamos el lanzamiento?', 1), m('120363001@g.us', 'p2', 'Sí, a las 3', 2, true),
  m('120363001@g.us', 'p3', 'Perfecto, llevo el tablero', 3),
  m('120363002@g.us', 'f1', 'Almuerzo el domingo 🍲', 4, false, 'Tía Rosa'),
  m('573111000001@s.whatsapp.net', 'h1', '¿Vienes a comer?', 5, false, null),
  m('120363009@g.us', 'l1', 'Confirmen asistencia, por favor', 8, false, 'Marta'),
], true);
await storeMessages(sb, [m('573222000002@s.whatsapp.net', 'b1', 'Te envío la orden de compra', 6, false, null), m('120363003@g.us', 'b2', 'Pedido listo', 7, false, 'Carlos')], true);
const cat = (acc: string, jid: string, category: string) => call(`/whatsapp/chats/${acc}/${encodeURIComponent(jid)}`, { token, method: 'PATCH', body: { category } });
await cat(personal.id, '120363001@g.us', 'trabajo'); await cat(personal.id, '120363002@g.us', 'familia'); await cat(personal.id, '573111000001@s.whatsapp.net', 'familia');
await cat(business.id, '573222000002@s.whatsapp.net', 'clientes'); await cat(personal.id, '120363009@g.us', 'trabajo'); await cat(business.id, '120363003@g.us', 'clientes');
const out = { apiUrl: API, email, password, userId, workspaceId: ws.id, generalId: ws.generalConversationId, longGroupId: longGroup.id, longWa: '120363009@g.us', personal: personal.id, business: business.id,
  work: '120363001@g.us', family: '120363002@g.us', mom: '573111000001@s.whatsapp.net', client: '573222000002@s.whatsapp.net' };
writeFileSync(process.env.FIXTURE_OUT ?? '/dev/stdout', JSON.stringify(out, null, 2));
await pool.end();
