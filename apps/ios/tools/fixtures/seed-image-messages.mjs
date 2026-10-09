// Siembra mensajes con imágenes (solo API de pruebas local) para reproducir el cierre al reaccionar.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const fx = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const API = fx.apiUrl; if (!/localhost|127\.0\.0\.1/.test(API)) throw new Error('solo pruebas');
async function call(path, { token, body, method, raw, headers } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, { method: method ?? (body || raw ? 'POST' : 'GET'),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(raw ? { 'content-type': 'application/octet-stream' } : {}), ...(headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const login = (email) => call('/auth/login', { body: { email, password: fx.password, device: { deviceId: randomUUID(), name: 'seed', platform: 'agent' } } });
const a = await login(fx.a.email), b = await login(fx.b.email);
// JPEG pequeño válido (1×1) en base64.
const jpg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const up = (t, conv, name) => call(`/conversations/${conv}/attachments`, { token: t, raw: jpg, headers: { 'x-file-name': name, 'x-file-type': 'image/jpeg' } });
const send = (t, conv, body, ids) => call(`/conversations/${conv}/messages`, { token: t, body: { clientMessageId: randomUUID(), body, attachmentIds: ids } });
const conv = fx.generalId;
const out = {};
out.bImage = (await send(b.accessToken, conv, '', [(await up(b.accessToken, conv, 'foto-b.jpg')).id])).message.id;
out.bCaption = (await send(b.accessToken, conv, 'Así quedó el tablero', [(await up(b.accessToken, conv, 'tablero.jpg')).id])).message.id;
out.aImage = (await send(a.accessToken, conv, '', [(await up(a.accessToken, conv, 'foto-a.jpg')).id])).message.id;
const many = [];
for (let i = 0; i < 3; i++) many.push((await up(b.accessToken, conv, `varias-${i}.jpg`)).id);
out.bMany = (await send(b.accessToken, conv, '', many)).message.id;
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const f = await call(`/conversations/${conv}/attachments`, { token: b.accessToken, raw: pdf, headers: { 'x-file-name': 'acta.pdf', 'x-file-type': 'application/pdf' } });
out.bFile = (await send(b.accessToken, conv, '', [f.id])).message.id;
writeFileSync(process.argv[3], JSON.stringify(out));
console.log(JSON.stringify(out));
