#!/usr/bin/env node
/**
 * Par de pruebas en tiempo real: entra como B por Socket.IO, y
 *  - responde "eco: <texto>" a cada mensaje de A en la conversación,
 *  - con PEER_SEND="texto" envía un mensaje y sale,
 *  - registra la latencia desde createdAt del servidor hasta que B lo recibe.
 * Sale con PEER_TIMEOUT_MS (por defecto 120 s) o tras PEER_MAX_ECHOES ecos.
 *
 *   API_URL=http://localhost:3021 FIXTURE=/tmp/fx.json node scripts/realtime-peer.mjs
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { io } from 'socket.io-client';

const fx = JSON.parse(readFileSync(process.env.FIXTURE, 'utf8'));
const API = process.env.API_URL ?? fx.apiUrl;
const login = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: fx.b.email, password: fx.password, device: { deviceId: randomUUID(), name: 'Par de pruebas', platform: 'agent' } }),
}).then((r) => r.json());
if (!login.accessToken) { console.error('login B falló', login); process.exit(1); }

const socket = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: login.accessToken } });
const send = (body) => new Promise((res) => socket.emit('message.send', { conversationId: fx.conversationId, clientMessageId: randomUUID(), body }, res));
let echoes = 0;
const max = Number(process.env.PEER_MAX_ECHOES ?? 1e9);
setTimeout(() => { console.log(JSON.stringify({ done: 'timeout', echoes })); process.exit(echoes > 0 || process.env.PEER_SEND ? 0 : 3); }, Number(process.env.PEER_TIMEOUT_MS ?? 120000));

socket.on('connect_error', (e) => { console.error('connect_error', e.message); process.exit(1); });
socket.on('ready', async () => {
  console.log(JSON.stringify({ ready: true }));
  if (process.env.PEER_SEND) {
    const ack = await send(process.env.PEER_SEND);
    console.log(JSON.stringify({ sent: process.env.PEER_SEND, ok: ack.ok, seq: ack.message?.seq }));
    setTimeout(() => process.exit(ack.ok ? 0 : 1), 300);
  }
});
socket.on('conv.event', async (e) => {
  if (e.type !== 'message.created' || e.conversationId !== fx.conversationId) return;
  const m = e.message;
  if (m.authorId !== fx.a.id) return;
  const latencyMs = Date.now() - Date.parse(m.createdAt);
  console.log(JSON.stringify({ received: m.body, seq: m.seq, latencyMs }));
  socket.emit('typing', { conversationId: fx.conversationId });
  const ack = await send(`eco: ${m.body}`);
  console.log(JSON.stringify({ echoed: ack.ok, seq: ack.message?.seq }));
  if (++echoes >= max) setTimeout(() => process.exit(0), 300);
});
