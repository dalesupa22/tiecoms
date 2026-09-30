// 1.7.1: fixture para ChatScrollUITests y ChatPerfUITests (solo API local; no necesita llamadas ni correo).
//   API_URL=http://localhost:3097 FIXTURE_OUT=<ruta>.json node apps/ios/tools/fixtures/long-fixture.mjs
// En un chat de varias personas (multiId), escritos por Bruno: 15 cortos, uno de 120 líneas (~5000 caracteres) y 15 cortos
// (el último «ÚLTIMO MENSAJE CORTO»). En un directo (dmId), 250 mensajes.
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const API = process.env.API_URL ?? 'http://localhost:3097';
if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(API)) throw new Error('solo pruebas locales');
const tag = randomBytes(3).toString('hex');
const password = randomBytes(12).toString('base64url');
const ip = () => `10.79.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function call(path, { token, body, method } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, { method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'x-forwarded-for': ip(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const device = () => ({ deviceId: randomUUID(), name: 'Fixture largo', platform: 'agent' });
const a = await call('/auth/signup', { body: { name: 'Ana Márquez', email: `ana.${tag}@qa.chaggu.test`, password, orgName: `Largo QA ${tag}`, device: device() } });
const boot = await call('/bootstrap', { token: a.accessToken });
const join = async (name, who) => {
  const inv = await call(`/organizations/${boot.me.primaryOrgId}/invitations`, { token: a.accessToken, body: { email: `${who}.${tag}@qa.chaggu.test` } });
  return call('/auth/signup', { body: { name, email: `${who}.${tag}@qa.chaggu.test`, password, orgInviteToken: inv.token, device: device() } });
};
const b = await join('Bruno Ortega', 'bruno');
const g = await join('Gloria Díaz', 'gloria');
const multi = await call('/chats', { token: b.accessToken, body: { userIds: [a.user.id, g.user.id], name: `Comité ${tag}` } });
const dm = await call('/chats', { token: b.accessToken, body: { userIds: [a.user.id] } });
const say = async (conv, body) => { const j = await call(`/conversations/${conv}/messages`, { token: b.accessToken, body: { clientMessageId: randomUUID(), body } }); return j.message ?? j; };
for (let i = 1; i <= 15; i++) await say(multi.id, `corto antes ${i}`);
const long = Array.from({ length: 120 }, (_, i) => `Línea ${i + 1} del informe de la obra, punto revisado.`).join('\n');
const lm = await say(multi.id, long);
for (let i = 1; i <= 14; i++) await say(multi.id, `corto después ${i}`);
await say(multi.id, 'ÚLTIMO MENSAJE CORTO');
for (let i = 1; i <= 250; i++) await say(dm.id, `Mensaje ${i} del historial largo`);
writeFileSync(process.env.FIXTURE_OUT ?? '/dev/stdout', JSON.stringify({ apiUrl: API, password, a: { email: a.user.email, id: a.user.id },
  b: { email: b.user.email, id: b.user.id }, multiId: multi.id, dmId: dm.id, longMessageId: lm.id }, null, 2));
console.error('ok', multi.id);
