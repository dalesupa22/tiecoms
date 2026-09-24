#!/usr/bin/env node
/**
 * Par de pruebas v2 (apps nativas): entra como B por Socket.IO y reacciona en vivo a lo que hace A:
 *  - mensaje nuevo de A            → responde «eco: <texto>»
 *  - A edita un mensaje            → responde «visto editado: <texto>»
 *  - cambian los fijados           → responde «visto fijado: <n>»
 * No reemplaza a realtime-peer.mjs (lo usa la otra plataforma).
 *
 *   API_URL=http://localhost:3041 FIXTURE=/tmp/fx.json NODE_ROOT=<carpeta con node_modules> node scripts/realtime-peer2.mjs
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.env.NODE_ROOT ?? process.cwd(), 'package.json'));
const { io } = require('socket.io-client');

const fx = JSON.parse(readFileSync(process.env.FIXTURE, 'utf8'));
const API = process.env.API_URL ?? fx.apiUrl;
if (/app\.tiecoms\.com/.test(API)) { console.error('Solo contra el API de pruebas'); process.exit(1); }
const login = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: fx.b.email, password: fx.password, device: { deviceId: randomUUID(), name: 'Par de pruebas v2', platform: 'agent' } }),
}).then((r) => r.json());
if (!login.accessToken) { console.error('login B falló', login); process.exit(1); }

const socket = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: login.accessToken } });
const send = (body) => new Promise((res) => socket.emit('message.send', { conversationId: fx.conversationId, clientMessageId: randomUUID(), body }, res));
const seenEdits = new Set();
let lastPins = -1;
const out = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
setTimeout(() => { out({ done: 'timeout' }); process.exit(0); }, Number(process.env.PEER_TIMEOUT_MS ?? 300000));

socket.on('connect_error', (e) => { console.error('connect_error', e.message); process.exit(1); });
socket.on('ready', () => out({ ready: true }));
socket.on('conv.event', async (e) => {
  if (e.conversationId !== fx.conversationId) return;
  if (e.type === 'message.created' && e.message.authorId === fx.a.id && e.message.kind === 'text') {
    out({ received: e.message.body, latencyMs: Date.now() - Date.parse(e.message.createdAt) });
    socket.emit('typing', { conversationId: fx.conversationId });
    const ack = await send(`eco: ${e.message.body}`);
    out({ echoed: ack.ok });
  }
  if (e.type === 'message.updated' && e.message.authorId === fx.a.id && e.message.editedAt && !e.message.deletedAt) {
    const key = `${e.message.id}:${e.message.editedAt}`;
    if (seenEdits.has(key)) return;
    seenEdits.add(key);
    out({ edited: e.message.body });
    await send(`visto editado: ${e.message.body}`);
  }
  if (e.type === 'pins.changed' && e.messageIds.length !== lastPins) {
    lastPins = e.messageIds.length;
    out({ pins: e.messageIds.length });
    await send(`visto fijado: ${e.messageIds.length}`);
  }
});
