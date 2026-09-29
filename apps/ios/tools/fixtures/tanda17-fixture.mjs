// Fixture de la tanda 1.7 para la app iOS (solo API local con la migración 037).
//   API_URL=http://localhost:3141 FIXTURE_OUT=<ruta>.json node apps/ios/tools/fixtures/tanda17-fixture.mjs
// Luego, para «Es hoy» y «No cumplimos» sin esperar al worker: correr fireTodayEvents / fireOverdueIssues una vez.
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const API = process.env.API_URL ?? 'http://localhost:3141';
if (!/localhost|127\.0\.0\.1/.test(API)) throw new Error('solo pruebas');
const tag = randomBytes(3).toString('hex');
const password = randomBytes(12).toString('base64url');
async function call(path, { token, body, method } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, { method: method ?? (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const device = () => ({ deviceId: randomUUID(), name: 'Fixture 1.7', platform: 'agent' });
const say = (token, conv, body, extra = {}) => call(`/conversations/${conv}/messages`, { token, body: { clientMessageId: randomUUID(), body, ...extra } });
const u16 = (s) => s.length; // los textos de aquí no tienen emojis

const a = await call('/auth/signup', { body: { name: 'Ana Márquez', email: `ana.${tag}@qa.tiecoms.test`, password, orgName: `Xertify QA ${tag}`, device: device() } });
const boot = await call('/bootstrap', { token: a.accessToken });
const join = async (name, who) => {
  const inv = await call(`/organizations/${boot.me.primaryOrgId}/invitations`, { token: a.accessToken, body: { email: `${who}.${tag}@qa.tiecoms.test` } });
  return call('/auth/signup', { body: { name, email: `${who}.${tag}@qa.tiecoms.test`, password, orgInviteToken: inv.token, device: device() } });
};
const b = await join('Bruno Ortega', 'bruno');
const pagos = await call('/groups', { token: a.accessToken, body: { name: 'Pagos 1.7', target: { kind: 'org' }, memberIds: [b.user.id] } });
const secreto = await call('/groups', { token: b.accessToken, body: { name: 'Junta privada', target: { kind: 'org' } } }); // Ana no está
const dm = await call('/chats', { token: b.accessToken, body: { userIds: [a.user.id] } });

// §1 #grupos: uno que Ana ve y otro al que no tiene acceso.
const t1 = 'Revisen #Pagos 1.7 y #Junta privada antes del viernes';
await say(b.accessToken, dm.id, t1, { refs: [
  { conversationId: pagos.conversationId, start: t1.indexOf('#Pagos'), length: u16('#Pagos 1.7') },
  { conversationId: secreto.conversationId, start: t1.indexOf('#Junta'), length: u16('#Junta privada') },
] });
// §6 buscar: varias coincidencias.
await say(b.accessToken, dm.id, 'El presupuesto de octubre está listo');
await say(a.accessToken, dm.id, 'Gracias, reviso el Presupuesto hoy');
await say(b.accessToken, dm.id, 'Presupuésto final aprobado');
// §7 una sola vista.
const vo = await say(b.accessToken, dm.id, 'Clave del wifi: chaggu2026', { viewOnce: true });

// §3 tarea hecha, §4 vencida y §5 comentarios agrupados, en el grupo.
const iso = (d) => d.toISOString().slice(0, 10);
const done = await call(`/conversations/${pagos.conversationId}/issues`, { token: a.accessToken, body: { title: 'Conciliar pagos de septiembre', ownerId: b.user.id, dueDate: null, originMessageId: null } });
await call(`/issues/${done.id}`, { token: b.accessToken, method: 'PATCH', body: { status: 'done' } });
const late = await call(`/conversations/${pagos.conversationId}/issues`, { token: a.accessToken, body: { title: 'Enviar el informe al banco', ownerId: b.user.id, dueDate: iso(new Date(Date.now() - 3 * 86400e3)), originMessageId: null } });
const talk = await call(`/conversations/${pagos.conversationId}/issues`, { token: a.accessToken, body: { title: 'Cotizar el nuevo proveedor', ownerId: a.user.id, dueDate: null, originMessageId: null } });
await call(`/issues/${talk.id}/comments`, { token: b.accessToken, body: { body: 'Pedí dos cotizaciones' } });
await call(`/issues/${talk.id}/comments`, { token: b.accessToken, body: { body: 'La segunda llega mañana' } });
// §2 evento de hoy (en 3 horas) y §5 comentarios del evento.
const start = new Date(Date.now() + 3 * 3600e3), end = new Date(start.getTime() + 3600e3);
const ev = await call(`/conversations/${pagos.conversationId}/events`, { token: a.accessToken, body: { title: 'Revisión de pagos', startsAt: start.toISOString(), endsAt: end.toISOString(), timezone: 'America/Bogota', inviteeIds: [b.user.id] } });
await call(`/events/${ev.id}/comments`, { token: b.accessToken, body: { body: 'Llevo el extracto' } });

const out = { apiUrl: API, password, tag, a: { email: a.user.email, id: a.user.id }, b: { email: b.user.email, id: b.user.id },
  dmId: dm.id, pagosId: pagos.conversationId, secretoId: secreto.conversationId, viewOnceId: vo.message?.id ?? vo.id,
  doneIssue: done.id, lateIssue: late.id, talkIssue: talk.id, eventId: ev.id };
writeFileSync(process.env.FIXTURE_OUT ?? '/dev/stdout', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, password: '…' }, null, 2));
