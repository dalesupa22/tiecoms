// Fixture de Grupos para la app iOS (solo contra la API de pruebas :3050).
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const API = process.env.API_URL ?? 'http://localhost:3050';
if (!/localhost|127\.0\.0\.1/.test(API)) throw new Error('solo pruebas');
const tag = randomBytes(3).toString('hex');
const password = randomBytes(12).toString('base64url');
async function call(path, { token, body, method } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const device = () => ({ deviceId: randomUUID(), name: 'Fixture grupos', platform: 'agent' });
const say = (token, conv, body) => call(`/conversations/${conv}/messages`, { token, body: { clientMessageId: randomUUID(), body } });
const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const a = await call('/auth/signup', { body: { name: 'Ana Márquez', email: `ana.${tag}@qa.tiecoms.test`, password, orgName: `Xertify QA ${tag}`, title: 'Directora de operaciones', device: device() } });
const b = await call('/auth/signup', { body: { name: 'Bruno Ortega', email: `bruno.${tag}@qa.tiecoms.test`, password, orgName: `Ongoing ${tag}`, device: device() } });
const g = await call('/auth/signup', { body: { name: 'Gloria Paz', email: `gloria.${tag}@qa.tiecoms.test`, password, orgName: `Acelera ${tag}`, device: device() } });
const boot = await call('/bootstrap', { token: a.accessToken });
const orgA = boot.me.primaryOrgId;
const oi = await call(`/organizations/${orgA}/invitations`, { token: a.accessToken, body: { email: `carlos.${tag}@qa.tiecoms.test` } });
const c = await call('/auth/signup', { body: { name: 'Carlos Rincón', email: `carlos.${tag}@qa.tiecoms.test`, password, orgInviteToken: oi.token, device: device() } });

// Tu organización: grupo interno con Carlos y cuatro asuntos (uno vencido, uno en curso).
const pagos = await call('/groups', { token: a.accessToken, body: { name: 'Pagos y facturación', target: { kind: 'org' }, memberIds: [c.user.id] } });
await say(c.accessToken, pagos.conversationId, 'Ya subí las facturas de septiembre 📎');
const issue = (t, title, extra = {}) => call(`/conversations/${pagos.conversationId}/issues`, { token: t, body: { title, ownerId: null, dueDate: null, originMessageId: null, ...extra } });
const i1 = await issue(a.accessToken, 'Conciliar pagos de proveedores', { dueDate: day(-2) });
const i2 = await issue(a.accessToken, 'Cerrar facturación de septiembre', { dueDate: day(3) });
await call(`/issues/${i2.id}`, { token: a.accessToken, method: 'PATCH', body: { status: 'in_progress' } });
await issue(c.accessToken, 'Revisar retenciones');
await issue(c.accessToken, 'Actualizar plantilla de cobro');
// Carlos arma un grupo interno donde Ana no está (supervisión).
const ventas = await call('/groups', { token: c.accessToken, body: { name: 'Ventas regionales', target: { kind: 'org' } } });
await say(c.accessToken, ventas.conversationId, 'Meta de octubre: 120 cuentas nuevas');

// Relación con Ongoing (espacio de siempre + invitación) y un segundo grupo en ella.
const ws = await call('/workspaces', { token: a.accessToken, body: { name: `Mentorías Ongoing`, department: 'Programa' } });
const inv = await call(`/workspaces/${ws.id}/invitations`, { token: a.accessToken, body: { email: b.user.email, role: 'member', conversationIds: [ws.generalConversationId] } });
await call(`/invitations/${inv.token}/accept`, { token: b.accessToken, body: {} });
const m = await say(b.accessToken, ws.generalConversationId, '¿Movemos la mentoría del jueves a las 4?');
// Un hilo con los del chat colgando del mensaje, con una respuesta.
const thread = await call(`/conversations/${ws.generalConversationId}/derive`, { token: a.accessToken, body: { messageId: m.message.id, kind: 'same', name: 'Hilo · Horario de la mentoría' } });
await say(b.accessToken, thread.id, 'Mejor a las 5, ¿les sirve?');
const mentor2 = await call('/groups', { token: a.accessToken, body: { name: 'Mentoría 2 · Finanzas', target: { kind: 'workspace', workspaceId: ws.id }, memberIds: [b.user.id] } });
await say(b.accessToken, mentor2.conversationId, 'Comparto el tablero de la cohorte');
await call(`/conversations/${ws.generalConversationId}/issues`, { token: a.accessToken, body: { title: 'Agenda de mentorías de octubre', ownerId: b.user.id, dueDate: day(5), originMessageId: null } });
// Sidechat de Bruno a Ana desde el grupo general y un directo.
await call(`/conversations/${ws.generalConversationId}/side`, { token: b.accessToken, body: { messageId: m.message.id, userIds: [a.user.id], question: '¿El equipo llega a tiempo?' } });
const dm = await call('/chats', { token: b.accessToken, body: { userIds: [a.user.id] } });
await say(b.accessToken, dm.id, 'Ana, ¿tienes 5 minutos hoy?');
const dm2 = await call('/chats', { token: a.accessToken, body: { userIds: [c.user.id] } });
await say(c.accessToken, dm2.id, 'Listo el informe 👍');

// Relación pendiente con Nestlé (con enlace para compartir).
const nestle = await call('/groups', { token: a.accessToken, body: { name: 'Proveedores Nestlé', target: { kind: 'company', companyName: 'Nestlé' }, shareLink: true } });

// Invitado en: Acelera invita a Ana como tercera (mentora) a su grupo.
const wsG = await call('/workspaces', { token: g.accessToken, body: { name: 'Programa Acelera' } });
const invG = await call(`/workspaces/${wsG.id}/invitations`, { token: g.accessToken, body: { email: a.user.email, role: 'guest', conversationIds: [wsG.generalConversationId] } });
await call(`/invitations/${invG.token}/accept`, { token: a.accessToken, body: {} });
await say(g.accessToken, wsG.generalConversationId, 'Bienvenida, Ana: esta semana revisamos los pitches');
// Un código para «Unirme con código»: Gloria comparte otro grupo con enlace.
const cohort = await call('/groups', { token: g.accessToken, body: { name: 'Cohorte 5', target: { kind: 'org' }, shareLink: true } });

// 1.6.4: chat largo con 40 no leídos (Ana leyó hasta el 30) y una mención a Ana entre ellos; un grupo fijado.
const largo = await call('/groups', { token: a.accessToken, body: { name: 'Cohorte larga', target: { kind: 'workspace', workspaceId: ws.id }, memberIds: [b.user.id] } });
let readSeq = 0;
for (let n = 1; n <= 70; n++) {
  const body = n === 55 ? '@Ana Márquez ¿puedes revisar el cronograma?' : `Avance ${n} de la cohorte: todo en orden por aquí`;
  const r = await call(`/conversations/${largo.conversationId}/messages`, { token: b.accessToken,
    body: { clientMessageId: randomUUID(), body, ...(n === 55 ? { mentions: [{ userId: a.user.id, start: 0, length: 12 }] } : {}) } });
  if (n === 30) readSeq = r.message?.seq ?? r.seq;
}
await call(`/conversations/${largo.conversationId}/read`, { token: a.accessToken, body: { seq: readSeq } });
await call(`/conversations/${nestle.conversationId}/prefs`, { token: a.accessToken, method: 'PUT', body: { pinned: true } });

const out = { apiUrl: API, password, tag, a: { email: a.user.email, id: a.user.id }, b: { email: b.user.email, id: b.user.id },
  c: { email: c.user.email, id: c.user.id }, orgA, pagosId: pagos.conversationId, ventasId: ventas.conversationId, wsId: ws.id, generalId: ws.generalConversationId, threadId: thread.id,
  nestleCode: nestle.inviteCode, joinCode: cohort.inviteCode, overdueIssue: i1.id, longId: largo.conversationId, pinnedId: nestle.conversationId };
writeFileSync(process.env.FIXTURE_OUT ?? '/dev/stdout', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
