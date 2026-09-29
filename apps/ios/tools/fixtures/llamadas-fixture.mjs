// Fixture de llamadas y temas para la app iOS (solo contra una API local con CALLS_ENABLED=true CALLS_PROVIDER=fake).
//   API_URL=http://localhost:3141 FIXTURE_OUT=<ruta>.json node apps/ios/tools/fixtures/llamadas-fixture.mjs
// Deja: un directo Ana–Bruno con temas (todo lo no leído en «Finanzas») y una llamada terminada con transcripción;
// un chat grupal con no leídos repartidos, una llamada sin respuesta y otra EN CURSO (Bruno dentro, sin worker que la cierre).
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const API = process.env.API_URL ?? 'http://localhost:3141';
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
const device = () => ({ deviceId: randomUUID(), name: 'Fixture llamadas', platform: 'agent' });
const say = (token, conv, body, topicId) => call(`/conversations/${conv}/messages`, { token, body: { clientMessageId: randomUUID(), body, ...(topicId ? { topicId } : {}) } });
const seqOf = (r) => r.message?.seq ?? r.seq;

const a = await call('/auth/signup', { body: { name: 'Ana Márquez', email: `ana.${tag}@qa.tiecoms.test`, password, orgName: `Xertify QA ${tag}`, device: device() } });
const boot = await call('/bootstrap', { token: a.accessToken });
// Bruno y Gloria entran a la empresa de Ana (así pueden escribirse y llamarse).
const join = async (name, who) => {
  const inv = await call(`/organizations/${boot.me.primaryOrgId}/invitations`, { token: a.accessToken, body: { email: `${who}.${tag}@qa.tiecoms.test` } });
  return call('/auth/signup', { body: { name, email: `${who}.${tag}@qa.tiecoms.test`, password, orgInviteToken: inv.token, device: device() } });
};
const b = await join('Bruno Ortega', 'bruno');
const g = await join('Gloria Paz', 'gloria');
if (boot.features?.calls !== true) throw new Error('la API no tiene CALLS_ENABLED=true');

// Directo con temas: lo leído de «Finanzas» y «Obra» queda solo en su banderita; lo no leído está todo en «Finanzas».
const dm = await call('/chats', { token: b.accessToken, body: { userIds: [a.user.id] } });
const fin = (await call(`/conversations/${dm.id}/topics`, { token: a.accessToken, body: { name: 'Finanzas', color: 'green', icon: '💰' } })).topic;
const obra = (await call(`/conversations/${dm.id}/topics`, { token: a.accessToken, body: { name: 'Obra', color: 'orange', icon: '📦' } })).topic;
await say(b.accessToken, dm.id, 'Hola Ana, ¿cómo vas?');
await say(b.accessToken, dm.id, 'Ya pagué la factura de agosto', fin.id);
await say(b.accessToken, dm.id, 'La obra arranca el lunes', obra.id);
const last = await say(a.accessToken, dm.id, 'Perfecto, gracias');
await call(`/conversations/${dm.id}/read`, { token: a.accessToken, body: { seq: seqOf(last) } });

// Llamada terminada con transcripción (Bruno llama, Ana entra, Bruno transcribe y cuelgan).
const c1 = await call(`/conversations/${dm.id}/call`, { token: b.accessToken, body: { kind: 'audio' } });
await call(`/calls/${c1.call.id}/join`, { token: a.accessToken, body: {} });
await call(`/calls/${c1.call.id}/transcription`, { token: b.accessToken, body: { on: true, aiSummary: false } });
await call(`/calls/${c1.call.id}/transcript`, { token: b.accessToken, body: { segments: [
  { resultId: `r1-${tag}`, externalUserId: b.user.id, language: 'es-US', text: 'Revisemos el presupuesto de octubre.', startMs: 1200, endMs: 3600 },
  { resultId: `r2-${tag}`, externalUserId: a.user.id, language: 'es-US', text: 'De acuerdo, lo mando hoy por el chat.', startMs: 4100, endMs: 6400 },
] } });
await call(`/calls/${c1.call.id}/leave`, { token: a.accessToken, body: {} });
await call(`/calls/${c1.call.id}/leave`, { token: b.accessToken, body: {} });
// Lo no leído, todo en «Finanzas» (al abrir, el chat queda filtrado ahí).
await say(b.accessToken, dm.id, 'Te dejo el presupuesto de octubre', fin.id);
await say(b.accessToken, dm.id, '¿Lo apruebas antes del viernes?', fin.id);

// Chat grupal: no leídos repartidos (sin tema y en «Pagos»), una llamada sin respuesta y otra en curso.
const multi = await call('/chats', { token: b.accessToken, body: { userIds: [a.user.id, g.user.id], name: `Comité ${tag}` } });
const pagos = (await call(`/conversations/${multi.id}/topics`, { token: b.accessToken, body: { name: 'Pagos', color: 'violet', icon: '🧾' } })).topic;
await say(b.accessToken, multi.id, 'Bienvenidas al comité');
const missed = await call(`/conversations/${multi.id}/call`, { token: g.accessToken, body: { kind: 'video' } });
await call(`/calls/${missed.call.id}/leave`, { token: g.accessToken, body: {} });
await say(g.accessToken, multi.id, 'Subí el acta', pagos.id);
await say(b.accessToken, multi.id, '¿Quién revisa el acta?');
const live = await call(`/conversations/${multi.id}/call`, { token: b.accessToken, body: { kind: 'audio' } });

const out = { apiUrl: API, password, tag, a: { email: a.user.email, id: a.user.id }, b: { email: b.user.email, id: b.user.id },
  g: { email: g.user.email, id: g.user.id }, dmId: dm.id, finId: fin.id, obraId: obra.id, multiId: multi.id, pagosId: pagos.id,
  endedCallId: c1.call.id, missedCallId: missed.call.id, liveCallId: live.call.id, bToken: b.accessToken };
writeFileSync(process.env.FIXTURE_OUT ?? '/dev/stdout', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, password: '…', bToken: '…' }, null, 2));
