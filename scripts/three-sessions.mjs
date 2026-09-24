#!/usr/bin/env node
/**
 * Prueba en vivo con 3 sesiones simultáneas (una por empresa) sobre los datos de demo.
 * Cada sesión es un cliente real: HTTP para enviar y WebSocket para recibir.
 * Mide latencia de entrega y verifica que cada quien reciba solo lo de su alcance.
 *
 *   API_URL=https://app.tiecoms.com DEMO_PASSWORD='...' node scripts/three-sessions.mjs
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { io } = require('socket.io-client');

const API = process.env.API_URL ?? 'http://localhost:3020';
const PASSWORD = process.env.DEMO_PASSWORD;
const DOMAIN = process.env.DEMO_DOMAIN ?? 'demo.tiecoms.com';

async function call(path, { token, body } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function session(user, deviceName) {
  const auth = await call('/auth/login', { body: { email: `${user}@${DOMAIN}`, password: PASSWORD, device: { deviceId: randomUUID(), name: deviceName, platform: 'agent' } } });
  const boot = await call('/bootstrap', { token: auth.accessToken });
  const received = [];
  const socket = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: auth.accessToken } });
  await new Promise((res, rej) => { socket.once('ready', res); socket.once('connect_error', rej); });
  socket.on('conv.event', (e) => { if (e.type === 'message.created') received.push({ at: Date.now(), e }); });
  socket.on('typing', (e) => received.push({ at: Date.now(), typing: e }));
  return { user, name: auth.user.name, token: auth.accessToken, boot, socket, received };
}

const find = (s, name) => s.boot.conversations.find((c) => c.name === name && c.kind !== 'direct');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const danny = await session('danny', 'Sesión 1 · Xertify');
const mateo = await session('mateo', 'Sesión 2 · Estudio Norte');
const lucia = await session('lucia', 'Sesión 3 · Nexo Logística');
const all = [danny, mateo, lucia];
console.log('3 sesiones conectadas por WebSocket:');
for (const s of all) console.log(`  ${s.name.padEnd(14)} ve ${s.boot.workspaces.length} espacio(s), ${s.boot.conversations.length} conversación(es), ${s.boot.conversations.reduce((n, c) => n + c.unread, 0)} sin leer`);

async function send(from, conv, text) {
  for (const s of all) s.received.length = 0;
  const t0 = Date.now();
  const r = await call(`/conversations/${conv.id}/messages`, { token: from.token, body: { clientMessageId: randomUUID(), body: text } });
  const ack = Date.now() - t0;
  await wait(1500);
  const line = all.map((s) => {
    const hit = s.received.find((x) => x.e?.message.id === r.message.id);
    return `${s.name.split(' ')[0]}: ${hit ? `recibió en ${hit.at - t0} ms` : 'no lo recibe (fuera de su alcance)'}`;
  });
  console.log(`\n${from.name} → «${conv.name}»: "${text}"\n  ACK guardado en ${ack} ms · ${line.join(' · ')}`);
}

const general1 = find(danny, 'General') && danny.boot.conversations.find((c) => c.name === 'General' && danny.boot.workspaces.find((w) => w.id === c.workspaceId)?.name.startsWith('Lanzamiento'));
const general2 = mateo.boot.conversations.find((c) => c.name === 'General' && mateo.boot.workspaces.find((w) => w.id === c.workspaceId)?.name.startsWith('Entrega'));
const comite = find(danny, 'Comité directivo');

await send(danny, general1, 'Prueba en vivo: ¿me leen desde Estudio Norte?');
await send(mateo, general1, 'Te leo, Danny. Llegó al instante.');
await send(mateo, general2, 'Lucía, esto solo lo ve Nexo y Estudio Norte, no Xertify.');
await send(lucia, general2, 'Confirmado, Mateo. Seguimos con la entrega del jueves.');
await send(danny, comite, 'Esto es del comité directivo: solo Mateo y yo.');

// Escribiendo… (efímero)
for (const s of all) s.received.length = 0;
danny.socket.emit('typing', { conversationId: general1.id });
await wait(800);
console.log(`\nIndicador "escribiendo" de Danny en «General»: ${all.filter((s) => s.received.some((x) => x.typing)).map((s) => s.name.split(' ')[0]).join(', ') || 'nadie'} lo ve`);

for (const s of all) s.socket.disconnect();
console.log('\nListo.');
