// Fixture de filas altas en la pila perezosa (más de 200 filas) para ChatScrollUITests.testTallRowsInLazyStack.
// Solo API local con MAIL_ENABLED y el Gmail falso (apps/api/test/fake-mail.mjs). Usa ffmpeg para el video de prueba.
//   API_URL=http://localhost:3097 FIXTURE_OUT=<ruta>.json node apps/ios/tools/fixtures/tall-rows-fixture.mjs
// En un grupo: 215 mensajes cortos y, repartidos, una foto vertical muy alta (400×3000), un video vertical, un PDF,
// un mensaje con 30 enlaces, una tarjeta de tarea, una de evento y la tarjeta de un correo con comentarios en línea.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const API = process.env.API_URL ?? 'http://localhost:3097';
if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(API)) throw new Error('solo pruebas locales');
const tag = randomBytes(3).toString('hex');
const password = randomBytes(12).toString('base64url');
const ip = () => `10.80.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function call(path, { token, body, method, raw, headers } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, { method: method ?? (body || raw ? 'POST' : 'GET'),
    headers: { 'x-forwarded-for': ip(), ...(body ? { 'content-type': 'application/json' } : {}), ...(raw ? { 'content-type': 'application/octet-stream' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers ?? {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const device = () => ({ deviceId: randomUUID(), name: 'Fixture filas altas', platform: 'agent' });
const a = await call('/auth/signup', { body: { name: 'Ana Márquez', email: `ana.${tag}@qa.chaggu.test`, password, orgName: `Altas QA ${tag}`, device: device() } });
const boot = await call('/bootstrap', { token: a.accessToken });
const inv = await call(`/organizations/${boot.me.primaryOrgId}/invitations`, { token: a.accessToken, body: { email: `bruno.${tag}@qa.chaggu.test` } });
const b = await call('/auth/signup', { body: { name: 'Bruno Ortega', email: `bruno.${tag}@qa.chaggu.test`, password, orgInviteToken: inv.token, device: device() } });
const g = await call('/groups', { token: a.accessToken, body: { name: `Filas altas ${tag}`, target: { kind: 'org' }, memberIds: [b.user.id] } });
const conv = g.conversationId;
const say = async (body, extra = {}) => { const j = await call(`/conversations/${conv}/messages`, { token: b.accessToken, body: { clientMessageId: randomUUID(), body, ...extra } }); return j.message ?? j; };
const upload = async (name, type, bytes) => call(`/conversations/${conv}/attachments`, { token: b.accessToken, raw: bytes,
  headers: { 'x-file-name': encodeURIComponent(name), 'x-file-type': type } });

// PNG vertical 400×3000 de un solo color (sin dependencias).
function png(w, h) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(t), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x60)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dir = mkdtempSync(join(tmpdir(), 'altas-'));
const mp4 = join(dir, 'vertical.mp4');
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=360x1280:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', mp4, '-y']);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 800]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

for (let i = 1; i <= 60; i++) await say(`corto ${i}`);
const img = await upload('foto-alta.png', 'image/png', png(400, 3000));
await say('', { attachmentIds: [img.id ?? img.attachment?.id] });
for (let i = 61; i <= 90; i++) await say(`corto ${i}`);
const vid = await upload('video-vertical.mp4', 'video/mp4', readFileSync(mp4));
await say('video vertical', { attachmentIds: [vid.id ?? vid.attachment?.id] });
const doc = await upload('informe.pdf', 'application/pdf', pdf);
await say('el informe', { attachmentIds: [doc.id ?? doc.attachment?.id] });
for (let i = 91; i <= 120; i++) await say(`corto ${i}`);
await say(Array.from({ length: 30 }, (_, i) => `https://ejemplo${i}.com/pagina/${i}`).join('\n'));
await call(`/conversations/${conv}/issues`, { token: b.accessToken, body: { title: 'Revisar la obra', ownerId: a.user.id, dueDate: null, originMessageId: null } });
const start = new Date(Date.now() + 2 * 86400e3), end = new Date(start.getTime() + 3600e3);
await call(`/conversations/${conv}/events`, { token: b.accessToken, body: { title: 'Visita a la obra', startsAt: start.toISOString(), endsAt: end.toISOString(), timezone: 'America/Bogota', inviteeIds: [a.user.id] } });
// Correo con comentarios en línea (Ana conecta el Gmail falso con recibo + PKCE).
const verifier = randomBytes(32).toString('base64url');
const { url } = await call('/mail/connect/google', { token: a.accessToken, body: { platform: 'ios', redirectScheme: 'chaggu', proofChallenge: createHash('sha256').update(verifier).digest('base64url') } });
let next = url;
for (let i = 0; i < 5 && !next.startsWith('chaggu://'); i++) { const r = await fetch(next, { redirect: 'manual' }); next = new URL(r.headers.get('location'), next).toString(); }
await call('/mail/connect/confirm', { token: a.accessToken, body: { receipt: new URL(next).searchParams.get('receipt'), proofVerifier: verifier } });
const m = await call('/mail/share', { token: a.accessToken, body: { provider: 'google', messageId: 'g1', conversationId: conv, comment: 'Miren este correo del comité' } });
const email = m.emails?.[0] ?? m;
await call(`/mail/shared/${email.id}/comments`, { token: b.accessToken, body: { body: 'Yo armo la presentación con precios por volumen y el cronograma completo.' } });
await call(`/mail/shared/${email.id}/comments`, { token: b.accessToken, body: { body: 'Y reviso los requisitos del PDF antes del jueves.' } });
for (let i = 121; i <= 215; i++) await say(`corto ${i}`);
// El último lo escribe Ana: así el chat queda leído y abre al final.
await call(`/conversations/${conv}/messages`, { token: a.accessToken, body: { clientMessageId: randomUUID(), body: 'ÚLTIMO MENSAJE CORTO' } });
writeFileSync(process.env.FIXTURE_OUT ?? '/dev/stdout', JSON.stringify({ apiUrl: API, password, a: { email: a.user.email, id: a.user.id },
  multiId: conv, longMessageId: '', emailId: email.id }, null, 2));
console.error('ok', conv);
