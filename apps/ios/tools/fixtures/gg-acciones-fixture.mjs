// Fixture para «gg prepara la reunión / redacta el correo» (GgUITests.testGgAgendaYCorreoConConfirmacion).
// Solo contra un API LOCAL con MAIL_ENABLED=true, MAIL_* y DEEPSEEK_URL apuntando a apps/api/test/fake-mail.mjs (MOCK:
// no prueba Google ni la IA real). Deja a Ana con su Gmail falso conectado, permiso de IA y un chat con Beto.
//   API_URL=http://localhost:3098 FAKE_MAIL=http://localhost:59398 FIXTURE_OUT=/tmp/gg.json node apps/ios/tools/fixtures/gg-acciones-fixture.mjs
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const API = process.env.API_URL ?? 'http://localhost:3098';
const FAKE = process.env.FAKE_MAIL ?? 'http://localhost:59398';
if (!/localhost|127\.0\.0\.1/.test(API) || !/localhost|127\.0\.0\.1/.test(FAKE)) throw new Error('solo pruebas locales');
const tag = randomBytes(3).toString('hex');
const password = randomBytes(12).toString('base64url');
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`;
async function call(path, { token, body, method } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'x-forwarded-for': ip(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const device = () => ({ deviceId: randomUUID(), name: 'Fixture gg acciones', platform: 'agent' });
const a = await call('/auth/signup', { body: { name: 'Ana Márquez', email: `ana.${tag}@qa.tiecoms.test`, password, orgName: `Xertify QA ${tag}`, device: device() } });
const b = await call('/auth/signup', { body: { name: 'Beto Ríos', email: `beto.${tag}@qa.tiecoms.test`, password, orgName: `Cliente QA ${tag}`, device: device() } });
const ws = await call('/workspaces', { token: a.accessToken, body: { name: `Proyecto gg ${tag}` } });
const inv = await call(`/workspaces/${ws.id}/invitations`, { token: a.accessToken, body: { role: 'member', conversationIds: [ws.generalConversationId] } });
await call(`/invitations/${inv.token}/accept`, { token: b.accessToken, body: {} });
await call('/assistant/consent', { token: a.accessToken, body: { on: true } });
const say = (t, body) => call(`/conversations/${ws.generalConversationId}/messages`, { token: t, body: { clientMessageId: randomUUID(), body } });
await say(b.accessToken, 'Ana, agendemos la revisión de la propuesta con jorge@cliente.com y conmigo. El borrador está aquí: https://docs.example.com/propuesta');
await say(a.accessToken, 'Perfecto, la armo esta semana.');

// Gmail falso de Ana (el mismo baile PKCE de la app, sin navegador).
const verifier = randomBytes(32).toString('base64url');
const start = await call('/mail/connect/google', { token: a.accessToken, body: { platform: 'web', proofChallenge: createHash('sha256').update(verifier).digest('base64url') } });
const cb = await fetch((await fetch(start.url, { redirect: 'manual' })).headers.get('location'), { redirect: 'manual' });
const receipt = new URL(cb.headers.get('location')).searchParams.get('receipt');
await call('/mail/connect/confirm', { token: a.accessToken, body: { receipt, proofVerifier: verifier } });

// Respuesta fija de la IA falsa: sirve para el borrador de reunión (title/durationMin/people/emails/description) y para el
// de correo (to/cc/subject/body). «Marta Gil» no está en el chat y «hacker@malo.com» no está escrito: el API los descarta.
const llm = { title: 'Revisión de la propuesta', durationMin: 45, people: ['Beto', 'Marta Gil'], emails: ['jorge@cliente.com', 'inventado@x.com'],
  description: 'Revisar la propuesta con el cliente.', to: ['jorge@cliente.com', 'Marta Gil', 'hacker@malo.com'], cc: [],
  subject: 'Propuesta para revisar', body: 'Hola Jorge,\n\nTe comparto la propuesta: https://docs.example.com/propuesta\n\nAna' };
await fetch(`${FAKE}/__llm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: JSON.stringify(llm), sticky: true }) });

const out = { apiUrl: API, fakeMail: FAKE, password, a: { email: a.user.email, id: a.user.id }, b: { id: b.user.id, name: 'Beto Ríos' }, generalId: ws.generalConversationId };
if (process.env.FIXTURE_OUT) writeFileSync(process.env.FIXTURE_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, password: '***' }, null, 2));
