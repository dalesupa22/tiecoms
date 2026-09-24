#!/usr/bin/env node
/**
 * Par de pruebas v2 (apps nativas): entra como B por Socket.IO y reacciona a lo que hace A.
 * No cambia el comportamiento de realtime-peer.mjs (lo usa la otra plataforma).
 *
 *  - Mensaje de texto de A            → responde "eco: <texto>"
 *  - A edita un mensaje (message.updated sin deletedAt) → responde "vi edición: <texto nuevo>"
 *  - A borra un mensaje (deletedAt)   → responde "vi borrado"
 *  - Cambian los fijados (pins.changed, no causados por B) → responde "vi fijados: <n>"
 *  - A escribe "par: edita"           → B publica "original del par", lo edita a "editado por el par" y lo fija
 *  - A escribe "par: reunión"         → B responde RSVP «yes» a la última reunión de la conversación
 * Cada evento recibido se imprime como una línea JSON (para el informe).
 *
 *   API_URL=http://localhost:3041 FIXTURE=/tmp/fx.json node scripts/realtime-peer2.mjs
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { io } from 'socket.io-client';

const fx = JSON.parse(readFileSync(process.env.FIXTURE, 'utf8'));
const API = process.env.API_URL ?? fx.apiUrl;
const conv = fx.conversationId;
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

const login = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: fx.b.email, password: fx.password, device: { deviceId: randomUUID(), name: 'Par de pruebas v2', platform: 'agent' } }),
}).then((r) => r.json());
if (!login.accessToken) { console.error('login B falló', login); process.exit(1); }
const token = login.accessToken;
const http = (path, method = 'GET', body) => fetch(`${API}/api/v1${path}`, {
  method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const socket = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token } });
const send = (body) => new Promise((res) => socket.emit('message.send', { conversationId: conv, clientMessageId: randomUUID(), body }, res));
let lastPins = null;
let busyPin = false;
setTimeout(() => { log({ done: 'timeout' }); process.exit(0); }, Number(process.env.PEER_TIMEOUT_MS ?? 600000));

socket.on('connect_error', (e) => { console.error('connect_error', e.message); process.exit(1); });
socket.on('ready', () => log({ ready: true }));
socket.on('conv.event', async (e) => {
  if (e.conversationId !== conv) return;
  log({ event: e.type, eventSeq: e.eventSeq, body: e.message?.body, deleted: !!e.message?.deletedAt, pins: e.messageIds, title: e.event?.title ?? e.issue?.title });
  if (e.type === 'message.created' && e.message.authorId === fx.a.id && e.message.kind === 'text') {
    const body = e.message.body;
    if (body === 'par: edita') {
      const ack = await send('original del par');
      await new Promise((r) => setTimeout(r, 400));
      const ed = await http(`/messages/${ack.message.id}`, 'PATCH', { body: 'editado por el par' });
      busyPin = true;
      const pin = await http(`/messages/${ack.message.id}/pin`, 'POST');
      log({ peerEdited: ed.status, peerPinned: pin.status });
      setTimeout(() => { busyPin = false; }, 1500);
      return;
    }
    if (body === 'par: reunión') {
      const r = await http(`/events?from=${encodeURIComponent(new Date(Date.now() - 86400e3).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60 * 86400e3).toISOString())}&conversationId=${conv}`);
      const ev = (r.json?.events ?? []).filter((x) => !x.cancelledAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (ev) { const x = await http(`/events/${ev.id}/rsvp`, 'POST', { rsvp: 'yes' }); log({ rsvp: x.status, event: ev.title }); }
      await send(`vi reunión: ${ev?.title ?? 'ninguna'}`);
      return;
    }
    await send(`eco: ${body}`);
  }
  if (e.type === 'message.updated' && e.message.authorId === fx.a.id) {
    await send(e.message.deletedAt ? 'vi borrado' : `vi edición: ${e.message.body}`);
  }
  if (e.type === 'pins.changed' && !busyPin) {
    const n = e.messageIds.length;
    if (n !== lastPins) { lastPins = n; await send(`vi fijados: ${n}`); }
  }
});
