// Fixture de «WhatsApp: tocar abre el chat, cabecera compacta y dos pines» + pines de correo (2-oct-2026) para la app iOS.
// Solo API local con MAIL_ENABLED=true y el Gmail falso (apps/api/test/fake-mail.mjs). Los chats de WhatsApp se siembran
// DIRECTO en la base de pruebas (sin teléfono ni puente): dos cuentas conectadas (danny y Business), con lease vigente
// y privacidad sincronizada para que el API las muestre.
//   API_URL=http://localhost:3098 PG_CONTAINER=<contenedor docker de postgres> FIXTURE_OUT=<ruta>.json \
//     node apps/ios/tools/fixtures/pines-wa-fixture.mjs
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const API = process.env.API_URL ?? 'http://localhost:3098';
if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(API)) throw new Error('solo pruebas locales');
const PG = process.env.PG_CONTAINER;
if (!PG) throw new Error('falta PG_CONTAINER (contenedor docker de la base de pruebas)');
const tag = randomBytes(3).toString('hex');
const password = randomBytes(12).toString('base64url');
const ip = () => `10.78.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function call(path, { token, body, method } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, { method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'x-forwarded-for': ip(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const sql = (q) => execFileSync('docker', ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'tiecoms', '-v', 'ON_ERROR_STOP=1', '-qAt'], { input: q }).toString().trim();
const lit = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const b64u = (b) => Buffer.from(b).toString('base64url');

const a = await call('/auth/signup', { body: { name: 'Danny Prueba', email: `danny.${tag}@qa.chaggu.test`, password, orgName: `Pines QA ${tag}`,
  device: { deviceId: randomUUID(), name: 'Fixture pines', platform: 'agent' } } });
const uid = a.user.id;
const boot = await call('/bootstrap', { token: a.accessToken });
if (!boot.features?.mail) throw new Error('El API no tiene MAIL_ENABLED=true');
const group = await call('/groups', { token: a.accessToken, body: { name: `Operaciones ${tag}`, target: { kind: 'org' } } });

// Gmail falso conectado (recibo + PKCE, como la app).
const verifier = b64u(randomBytes(32));
const { url } = await call('/mail/connect/google', { token: a.accessToken, body: { platform: 'ios', redirectScheme: 'chaggu', proofChallenge: b64u(createHash('sha256').update(verifier).digest()) } });
let next = url;
for (let i = 0; i < 5 && !next.startsWith('chaggu://'); i++) next = new URL((await fetch(next, { redirect: 'manual' })).headers.get('location'), next).toString();
await call('/mail/connect/confirm', { token: a.accessToken, body: { receipt: new URL(next).searchParams.get('receipt'), proofVerifier: verifier } });

// WhatsApp: dos cuentas conectadas (la personal en solo lectura, la Business con «Responder desde chaggu»).
const personal = randomUUID(), business = randomUUID();
const acc = (id, label, kind, send) => `INSERT INTO wa_accounts (id, user_id, label, kind, status, phone, push_name, connected_at, last_sync_at,
  lease_owner, lease_until, privacy_synced_at, privacy_hydrated_at, send_enabled)
  VALUES ('${id}', '${uid}', ${lit(label)}, '${kind}', 'connected', '573001234567', ${lit(label)}, now(), now(), 'fixture', now() + interval '2 days', now(), now(), ${send});`;
const min = (m) => `now() - interval '${m} minutes'`;
const chats = [
  // [cuenta, jid, nombre, grupo, categoría, minutos, vista previa, no leídos, bandeja]
  [personal, `120363${tag}01@g.us`, 'Equipo Ventas', true, 'trabajo', 3, 'Laura: ¿cerramos la propuesta hoy?', 2, null],
  [personal, `120363${tag}02@g.us`, 'Clientes Acme', true, 'clientes', 15, 'Pedro: envío la orden de compra', 0, 'groups'],
  [personal, `120363${tag}03@g.us`, 'Familia Suárez', true, 'familia', 30, 'Mamá: ¿vienen el domingo?', 4, null],
  [personal, `120363${tag}04@g.us`, 'Vecinos Edificio', true, 'comunidad', 60, 'Administración: corte de agua el martes', 0, null],
  [personal, `5730055${tag}@s.whatsapp.net`, 'Laura Pineda', false, 'trabajo', 8, 'Te paso el contrato en un rato', 1, 'dms'],
  [personal, `5730066${tag}@s.whatsapp.net`, 'Amigo Fútbol', false, 'amigos', 90, '¿Partido el jueves?', 0, 'dms'],
  [business, `120363${tag}05@g.us`, 'Pedidos Tienda', true, 'clientes', 5, 'Cliente: ¿tienen talla M?', 3, null],
];
const chatSql = chats.map(([acct, jid, name, g, cat, m, prev, unread, place]) =>
  `INSERT INTO wa_chats (account_id, jid, name, is_group, participants, category, last_message_at, last_preview, unread, inbox_place, wa_locked)
   VALUES ('${acct}', ${lit(jid)}, ${lit(name)}, ${g}, ${g ? 8 : 'NULL'}, '${cat}', ${min(m)}, ${lit(prev)}, ${unread}, ${lit(place)}, false);`).join('\n');
const ventas = chats[0][1];
const msgs = [
  [false, 'Laura', 'Buenos días equipo, ¿cómo vamos con Acme?', 40],
  [true, null, 'Bien, ya les mandé el borrador', 35],
  [false, 'Pedro', 'Ellos piden descuento por volumen', 20],
  [false, 'Laura', 'Laura: ¿cerramos la propuesta hoy?', 3],
].map(([me, who, body, m], i) => `INSERT INTO wa_messages (account_id, chat_jid, id, from_me, author_name, body, sent_at)
   VALUES ('${personal}', ${lit(ventas)}, 'm${i}${tag}', ${me}, ${lit(who)}, ${lit(body)}, ${min(m)});`).join('\n');
const pedidos = chats[6][1];
const msgsB = `INSERT INTO wa_messages (account_id, chat_jid, id, from_me, author_name, body, sent_at)
   VALUES ('${business}', ${lit(pedidos)}, 'b1${tag}', false, 'Cliente', 'Cliente: ¿tienen talla M?', ${min(5)});`;
sql(acc(personal, 'danny', 'personal', false) + '\n' + acc(business, 'Business', 'business', true) + '\n' + chatSql + '\n' + msgs + '\n' + msgsB);

const key = (acct, jid) => `wa:${acct}:${jid}`;
const out = { apiUrl: API, password, tag, a: { email: a.user.email, id: uid }, groupId: group.conversationId,
  personal, business, ventasKey: key(personal, ventas), acmeKey: key(personal, chats[1][1]), familiaKey: key(personal, chats[2][1]),
  vecinosKey: key(personal, chats[3][1]), lauraKey: key(personal, chats[4][1]), amigoKey: key(personal, chats[5][1]), pedidosKey: key(business, pedidos),
  mailThread: 't1', mailSubject: 'Solicitud de presentación para el comité del jueves' };
writeFileSync(process.env.FIXTURE_OUT ?? '/dev/stdout', JSON.stringify(out, null, 2));
console.error('ok', uid);
