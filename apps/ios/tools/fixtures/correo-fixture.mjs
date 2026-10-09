// Fixture de «Correo y WhatsApp en el chat» (docs/CORREO.md) para la app iOS. Solo API local con MAIL_ENABLED=true
// y el Gmail/Outlook FALSO (apps/api/test/fake-mail.mjs): pasar con esto NO prueba OAuth ni permisos reales.
//   API_URL=http://localhost:3097 FIXTURE_OUT=<ruta>.json node apps/ios/tools/fixtures/correo-fixture.mjs
// Siembra: Sofía (Gmail y Outlook conectados), Laura y Felipe (sin correo) en el grupo «Ventas correo»; g1 (comité, con
// adjuntos) compartido con comentario y dos comentarios de Laura (aviso mail.comments), g6 (con historial citado) y g4 (enviado).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const API = process.env.API_URL ?? 'http://localhost:3097';
if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(API)) throw new Error('solo pruebas locales');
const tag = randomBytes(3).toString('hex');
const password = randomBytes(12).toString('base64url');
const ip = () => `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function call(path, { token, body, method } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, { method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'x-forwarded-for': ip(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const device = () => ({ deviceId: randomUUID(), name: 'Fixture correo', platform: 'agent' });
const b64u = (b) => Buffer.from(b).toString('base64url');

const a = await call('/auth/signup', { body: { name: 'Sofía Rincón', email: `sofia.${tag}@qa.chaggu.test`, password, orgName: `Correo QA ${tag}`, device: device() } });
const boot = await call('/bootstrap', { token: a.accessToken });
if (!boot.features?.mail) throw new Error('El API no tiene MAIL_ENABLED=true');
const join = async (name, who) => {
  const inv = await call(`/organizations/${boot.me.primaryOrgId}/invitations`, { token: a.accessToken, body: { email: `${who}.${tag}@qa.chaggu.test` } });
  return call('/auth/signup', { body: { name, email: `${who}.${tag}@qa.chaggu.test`, password, orgInviteToken: inv.token, device: device() } });
};
const b = await join('Laura Pineda', 'laura');
const c = await join('Felipe Arenas', 'felipe');
const group = await call('/groups', { token: a.accessToken, body: { name: `Ventas correo ${tag}`, target: { kind: 'org' }, memberIds: [b.user.id, c.user.id] } });
const chatId = group.conversationId;
const other = await call('/groups', { token: a.accessToken, body: { name: `Compras ${tag}`, target: { kind: 'org' }, memberIds: [b.user.id] } });

// Conectar como lo hace la app: recibo + prueba PKCE. El proveedor falso redirige solo.
async function connect(provider) {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const { url } = await call(`/mail/connect/${provider}`, { token: a.accessToken, body: { platform: 'ios', redirectScheme: 'chaggu', proofChallenge: challenge } });
  let next = url;
  for (let i = 0; i < 5 && !next.startsWith('chaggu://'); i++) {
    const r = await fetch(next, { redirect: 'manual' });
    next = new URL(r.headers.get('location'), next).toString();
  }
  const receipt = new URL(next).searchParams.get('receipt');
  if (!receipt) throw new Error(`sin recibo: ${next}`);
  await call('/mail/connect/confirm', { token: a.accessToken, body: { receipt, proofVerifier: verifier } });
}
await connect('google');
await connect('microsoft');

const share = (messageId, comment, conversationId = chatId) => call('/mail/share', { token: a.accessToken, body: { provider: 'google', messageId, conversationId, ...(comment ? { comment } : {}) } });
const g4 = await share('g4');
const g6 = await share('g6', 'Ana ya confirmó la recarga');
const g1 = await share('g1', '¿Cómo le respondemos a Jorge?');
await call(`/mail/shared/${g1.id}/comments`, { token: b.accessToken, body: { body: 'Yo armo la presentación' } });
await call(`/mail/shared/${g1.id}/comments`, { token: b.accessToken, body: { body: 'Precios por volumen en la diapositiva 3' } });

const out = { apiUrl: API, password, tag,
  a: { email: a.user.email, id: a.user.id, name: 'Sofía Rincón' }, b: { email: b.user.email, id: b.user.id, name: 'Laura Pineda' },
  c: { email: c.user.email, id: c.user.id, name: 'Felipe Arenas' },
  chatId, otherId: other.conversationId, g1: g1.id, g4: g4.id, g6: g6.id };
writeFileSync(process.env.FIXTURE_OUT ?? '/dev/stdout', JSON.stringify(out, null, 2));
console.error('ok', chatId);
