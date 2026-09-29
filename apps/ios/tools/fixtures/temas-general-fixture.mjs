// Fixture de las tres vistas de temas (docs/TEMAS.md: «General», «Todo» y un tema) para la app iOS. Solo API local.
//   API_URL=http://localhost:3097 FIXTURE_OUT=<ruta>.json node apps/ios/tools/fixtures/temas-general-fixture.mjs
// Deja en un grupo: mensajes sin tema, mensajes del tema «Finanzas» (uno leído y uno sin leer) y otro tema activo (así
// los no leídos quedan repartidos y el chat abre en General).
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const API = process.env.API_URL ?? 'http://localhost:3097';
if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(API)) throw new Error('solo pruebas locales');
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
const device = () => ({ deviceId: randomUUID(), name: 'Fixture temas', platform: 'agent' });
const a = await call('/auth/signup', { body: { name: 'Ana Márquez', email: `ana.${tag}@qa.chaggu.test`, password, orgName: `Temas QA ${tag}`, device: device() } });
const boot = await call('/bootstrap', { token: a.accessToken });
const inv = await call(`/organizations/${boot.me.primaryOrgId}/invitations`, { token: a.accessToken, body: { email: `bruno.${tag}@qa.chaggu.test` } });
const b = await call('/auth/signup', { body: { name: 'Bruno Ortega', email: `bruno.${tag}@qa.chaggu.test`, password, orgInviteToken: inv.token, device: device() } });
const g = await call('/groups', { token: a.accessToken, body: { name: `Temas ${tag}`, target: { kind: 'org' }, memberIds: [b.user.id] } });
const conv = g.conversationId;
const fin = (await call(`/conversations/${conv}/topics`, { token: a.accessToken, body: { name: 'Finanzas', color: 'green', icon: '💰' } })).topic;
const ops = (await call(`/conversations/${conv}/topics`, { token: a.accessToken, body: { name: 'Operaciones', color: 'blue', icon: '⚙️' } })).topic;
const say = (token, body, topicId) => call(`/conversations/${conv}/messages`, { token, body: { clientMessageId: randomUUID(), body, ...(topicId ? { topicId } : {}) } });
await say(b.accessToken, 'Hola Ana, ¿cómo vas?');
await say(b.accessToken, 'Ya pagué la factura de agosto', fin.id);
const read = await say(a.accessToken, 'Perfecto, gracias');
await call(`/conversations/${conv}/read`, { token: a.accessToken, body: { seq: read.seq ?? read.message?.seq } }).catch(() => {});
await say(b.accessToken, 'Falta el extracto de septiembre', fin.id);
await say(b.accessToken, 'El camión llega el lunes', ops.id);
await say(b.accessToken, 'Nos vemos mañana en la oficina');
writeFileSync(process.env.FIXTURE_OUT ?? '/dev/stdout', JSON.stringify({ apiUrl: API, password, a: { email: a.user.email, id: a.user.id }, b: { email: b.user.email, id: b.user.id },
  conversationId: conv, fin: fin.id, ops: ops.id }, null, 2));
console.error('ok', conv);
