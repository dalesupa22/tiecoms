// Fixture de la tanda 1.6.6 (lectura del árbol, asuntos personales, reuniones y calendario) para la app iOS.
// Solo contra un API de pruebas local con la migración 028 y el contrato 2026-09-28 (rama tanda-lectura-reuniones).
//   API_URL=http://localhost:3075 FIXTURE_OUT=/tmp/fx166.json node apps/ios/tools/fixtures/tanda166-fixture.mjs
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const API = process.env.API_URL ?? 'http://localhost:3075';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API)) throw new Error('solo pruebas locales');
const tag = randomBytes(3).toString('hex');
const password = randomBytes(12).toString('base64url');
async function call(path, { token, body, method } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'x-tiecoms-contract': '2026-09-28', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const device = () => ({ deviceId: randomUUID(), name: 'Fixture 1.6.6', platform: 'agent' });
const say = (token, conv, body, extra = {}) => call(`/conversations/${conv}/messages`, { token, body: { clientMessageId: randomUUID(), body, ...extra } });
const lastSeq = async (token, conv) => (await call('/bootstrap', { token })).conversations.find((c) => c.id === conv)?.lastMessageSeq ?? 0;

// Danny (A) y su colega Carla (C) en «Xertify QA»; Bruno (B) en «Estudio Norte».
const a = await call('/auth/signup', { body: { name: 'Danny Prueba', email: `danny.${tag}@qa.tiecoms.test`, password, orgName: `Xertify QA ${tag}`, device: device() } });
const b = await call('/auth/signup', { body: { name: 'Bruno Norte', email: `bruno.${tag}@qa.tiecoms.test`, password, orgName: `Estudio Norte ${tag}`, device: device() } });
const orgA = (await call('/bootstrap', { token: a.accessToken })).me.primaryOrgId;
const oi = await call(`/organizations/${orgA}/invitations`, { token: a.accessToken, body: { email: `carla.${tag}@qa.tiecoms.test` } });
const c = await call('/auth/signup', { body: { name: 'Carla Soporte', email: `carla.${tag}@qa.tiecoms.test`, password, orgInviteToken: oi.token, device: device() } });

// Relación con Estudio Norte: «General» con B y C.
const ws = await call('/workspaces', { token: a.accessToken, body: { name: 'Estudio Norte', department: 'Clientes' } });
const general = ws.generalConversationId;
for (const [p, role] of [[b, 'member'], [c, 'member']]) {
  const inv = await call(`/workspaces/${ws.id}/invitations`, { token: a.accessToken, body: { email: p.user.email, role, conversationIds: [general] } });
  await call(`/invitations/${inv.token}/accept`, { token: p.accessToken, body: {} });
}
const m1 = await say(b.accessToken, general, 'Nos llegan notificaciones duplicadas desde el martes');
const m2 = await say(b.accessToken, general, '¿Podemos confirmar la fecha de salida?');
// Derivadas que Danny nunca abre: interna (5 de Carla) y directiva (6 de Bruno, la primera con una mención antigua).
const diag = await call(`/conversations/${general}/derive`, { token: a.accessToken, body: { messageId: m1.message.id, kind: 'internal', name: 'Diagnóstico · notificaciones duplicadas' } });
const decision = await call(`/conversations/${general}/derive`, { token: a.accessToken, body: { messageId: m2.message.id, kind: 'directive', name: 'Decisión · fecha de salida' } });
for (let n = 1; n <= 5; n++) await say(c.accessToken, diag.id, `Diagnóstico ${n}: revisé los registros del envío`);
await say(b.accessToken, decision.id, '@Danny Prueba ¿nos confirmas la fecha antes del viernes?', { mentions: [{ userId: a.user.id, start: 0, length: 13 }] });
for (let n = 2; n <= 6; n++) await say(b.accessToken, decision.id, `Punto ${n} de la decisión`);
await say(a.accessToken, general, 'como van');
// Danny leyó todo «General» (unread 0), pero no las derivadas: el caso de las capturas.
await call(`/conversations/${general}/read`, { token: a.accessToken, body: { seq: await lastSeq(a.accessToken, general) } });

// Chat largo con paginación: 70 mensajes, leído hasta el 30 y una mención en el 55.
const largo = await call('/groups', { token: a.accessToken, body: { name: 'Cohorte larga', target: { kind: 'workspace', workspaceId: ws.id }, memberIds: [b.user.id] } });
let readSeq = 0;
for (let n = 1; n <= 70; n++) {
  const body = n === 55 ? '@Danny Prueba ¿puedes revisar el cronograma?' : `Avance ${n} de la cohorte: todo en orden por aquí`;
  const r = await say(b.accessToken, largo.conversationId, body, n === 55 ? { mentions: [{ userId: a.user.id, start: 0, length: 13 }] } : {});
  if (n === 30) readSeq = r.message.seq;
}
await call(`/conversations/${largo.conversationId}/read`, { token: a.accessToken, body: { seq: readSeq } });

// Asuntos: uno del chat (compartido con Bruno) y uno personal de Danny (solo él lo ve).
const shared = await call(`/conversations/${general}/issues`, { token: a.accessToken, body: { title: 'Enviar cronograma a Estudio Norte', ownerId: a.user.id, dueDate: null, originMessageId: null } });
const personal = await call('/issues', { token: a.accessToken, body: { title: 'Preparar mi evaluación de desempeño', dueDate: null } });

// Calendario: reuniones en varios días de este mes (una con enlace de Meet) para Día / Semana / Mes.
const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };
const ev = (title, s, mins, location = null) => call(`/conversations/${general}/events`, { token: a.accessToken, body: {
  title, description: null, location, startsAt: s.toISOString(), endsAt: new Date(s.getTime() + mins * 60000).toISOString(),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, inviteeIds: [a.user.id, b.user.id] } });
const events = [];
events.push(await ev('Revisión semanal', at(0, 10), 60));
events.push(await ev('Llamada con Estudio Norte', at(0, 15, 30), 30, 'https://meet.google.com/abc-defg-hij'));
for (const [i, t] of ['Diseño', 'Pruebas', 'Soporte', 'Cierre'].entries()) events.push(await ev(`${t} · día lleno`, at(2, 9 + i * 2), 45));
events.push(await ev('Retro del sprint', at(5, 11), 60, 'https://teams.microsoft.com/l/meetup-join/xyz'));

const out = { apiUrl: API, password, tag, a: { email: a.user.email, id: a.user.id }, b: { email: b.user.email, id: b.user.id }, c: { email: c.user.email, id: c.user.id },
  orgA, wsId: ws.id, generalId: general, diagId: diag.id, decisionId: decision.id, longId: largo.conversationId,
  sharedIssueId: shared.id, personalIssueId: personal.id, eventIds: events.map((e) => e.id) };
writeFileSync(process.env.FIXTURE_OUT ?? '/dev/stdout', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
