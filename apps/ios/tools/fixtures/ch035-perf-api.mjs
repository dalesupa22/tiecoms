// CH035 (fluidez): API sintética para CH035PerfUITests. Sin base de datos, proveedores ni cuentas reales; solo 127.0.0.1.
//   PORT=3197 FIXTURE_OUT=<ruta>.json node apps/ios/tools/fixtures/ch035-perf-api.mjs
// Un directo con 120 mensajes, otro chat donde «llegan» mensajes durante la prueba y 30 chats más para que Inicio tenga
// lista. Tiene el socket (Engine.IO 4 sobre WebSocket, hecho a mano) para emitir eventos en vivo:
//   POST /__say {conv, body, author?}   → mensaje nuevo en esa conversación (conv.event message.created)
//   POST /__typing {conv, user?}        → «escribiendo…»
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const port = Number(process.env.PORT ?? 3197), N = Number(process.env.MESSAGES ?? 120);
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const me = { id: 'qa-me', name: 'Ana Márquez', email: 'ch035@synthetic.test', kind: 'human', primaryOrgId: 'qa-org' };
const bruno = { id: 'qa-bruno', name: 'Bruno Ortega', kind: 'human', orgId: 'qa-org' };
const gloria = { id: 'qa-gloria', name: 'Gloria Díaz', kind: 'human', orgId: 'qa-org' };
const convs = new Map(), msgs = new Map();
function conv(id, kind, memberIds, name) {
  const c = { id, kind, name, memberIds, lastMessageSeq: 0, lastEventSeq: 0, lastReadSeq: 0, unread: 0, canPost: true, canManage: false, historyFromSeq: 0, openIssues: 0 };
  convs.set(id, c); msgs.set(id, []); return c;
}
function add(convId, authorId, body, { clientMessageId, read = false, at } = {}) {
  const c = convs.get(convId), list = msgs.get(convId);
  const m = { id: `${convId}-m${list.length + 1}`, conversationId: convId, seq: list.length + 1, authorId, kind: 'text', body, createdAt: at ?? iso(), ...(clientMessageId ? { clientMessageId } : {}) };
  list.push(m);
  c.lastMessageSeq = m.seq; c.lastEventSeq += 1; c.lastMessageAt = m.createdAt; c.lastMessagePreview = body;
  if (authorId === me.id || read) c.lastReadSeq = m.seq; else c.unread += 1;
  return m;
}
conv('qa-dm', 'direct', [me.id, bruno.id]);
conv('qa-otro', 'multi', [me.id, bruno.id, gloria.id], 'Comité de obra');
for (let i = 1; i <= N; i++) add('qa-dm', i % 2 ? bruno.id : me.id, `Mensaje ${i} del historial`, { read: true, at: iso((N - i + 5) * 60000) });
add('qa-otro', bruno.id, 'Hola comité', { read: true, at: iso(3600000) });
for (let i = 1; i <= 30; i++) { conv(`qa-x${i}`, 'multi', [me.id, bruno.id, gloria.id], `Frente ${i}`); add(`qa-x${i}`, gloria.id, `Avance del frente ${i}`, { read: true, at: iso((i + 100) * 60000) }); }
const bootstrap = () => ({ contract: '2026-09-28', serverTime: iso(), me, features: { mail: false, calls: false },
  organizations: [{ id: 'qa-org', name: 'Fluidez QA', myRole: 'owner' }], workspaces: [],
  conversations: [...convs.values()].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')), people: [{ ...me, orgId: 'qa-org' }, bruno, gloria] });
const stats = {};
const sockets = new Set();
function wsSend(sock, text) {
  const data = Buffer.from(text), n = data.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  if (!sock.destroyed) sock.write(Buffer.concat([head, data]));
}
const emit = (name, payload) => { for (const s of sockets) wsSend(s, '42' + JSON.stringify([name, payload])); };
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'), path = url.pathname;
  stats[path] = (stats[path] ?? 0) + 1;
  const body = req.method === 'GET' ? {} : await readBody(req);
  if (path === '/__stats') return json(res, 200, stats);
  if (path === '/__say') {
    const m = add(body.conv, body.author ?? bruno.id, body.body ?? 'hola');
    emit('conv.event', { type: 'message.created', conversationId: m.conversationId, eventSeq: convs.get(m.conversationId).lastEventSeq, message: m });
    return json(res, 200, { message: m });
  }
  if (path === '/__typing') { emit('typing', { conversationId: body.conv, userId: body.user ?? bruno.id }); return json(res, 200, { ok: true }); }
  if (path === '/api/v1/auth/login' || path === '/api/v1/auth/refresh') return json(res, 200, { accessToken: 'synthetic-local-only', refreshToken: 'synthetic-local-only', accessExpiresAt: new Date(Date.now() + 3600000).toISOString(), sessionId: 'fixture', user: me });
  if (path === '/api/v1/bootstrap') return json(res, 200, bootstrap());
  const mm = path.match(/^\/api\/v1\/conversations\/([^/]+)\/(messages|read|events)$/);
  if (mm && convs.has(mm[1])) {
    const c = convs.get(mm[1]), list = msgs.get(mm[1]);
    if (mm[2] === 'messages' && req.method === 'GET') {
      const before = Number(url.searchParams.get('before') ?? Infinity), limit = Number(url.searchParams.get('limit') ?? 50);
      const older = list.filter((m) => m.seq < before);
      return json(res, 200, { messages: older.slice(-limit), hasMore: older.length > limit, lastEventSeq: c.lastEventSeq });
    }
    if (mm[2] === 'messages') {
      const dup = list.find((m) => m.clientMessageId && m.clientMessageId === body.clientMessageId);
      const m = dup ?? add(c.id, me.id, body.body ?? '', { clientMessageId: body.clientMessageId });
      if (!dup) emit('conv.event', { type: 'message.created', conversationId: c.id, eventSeq: c.lastEventSeq, message: m });
      return json(res, 200, { message: m, duplicate: !!dup });
    }
    if (mm[2] === 'read') { c.lastReadSeq = Math.max(c.lastReadSeq, Number(body.seq ?? 0)); c.unread = list.filter((m) => m.seq > c.lastReadSeq && m.authorId !== me.id).length; return json(res, 200, { lastReadSeq: c.lastReadSeq }); }
    return json(res, 200, { events: [], resetRequired: false, lastEventSeq: c.lastEventSeq });
  }
  if (path === '/api/v1/gg/side/pending') return json(res, 200, {});
  if (path.startsWith('/api/v1/')) return json(res, 200, { items: [], issues: [], topics: [], events: [], pins: [], userIds: [], accounts: [], reminders: [] });
  return json(res, 404, { error: { code: 'not_found', message: 'fixture' } });
});
server.on('upgrade', (req, sock) => {
  if (!req.url.startsWith('/api/socket.io/')) { sock.destroy(); return; }
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(sock);
  wsSend(sock, '0' + JSON.stringify({ sid: randomUUID(), upgrades: [], pingInterval: 20000, pingTimeout: 20000, maxPayload: 1000000 }));
  const ping = setInterval(() => wsSend(sock, '2'), 15000);
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = (buf[1] & 128) !== 0, need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      const op = buf[0] & 15, mask = masked ? buf.subarray(off, off + 4) : null, payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(need);
      if (op === 8) { sock.end(); return; }
      if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op !== 1) continue;
      const text = payload.toString();
      if (text.startsWith('40')) { wsSend(sock, '40' + JSON.stringify({ sid: randomUUID() })); wsSend(sock, '42' + JSON.stringify(['ready', {}])); }
    }
  });
  const done = () => { clearInterval(ping); sockets.delete(sock); };
  sock.on('close', done); sock.on('error', done);
});
server.listen(port, '127.0.0.1', () => {
  const fixture = { apiUrl: `http://127.0.0.1:${port}`, email: me.email, password: 'local-fixture-only', dmId: 'qa-dm', otherId: 'qa-otro', messages: N };
  if (process.env.FIXTURE_OUT) writeFileSync(process.env.FIXTURE_OUT, JSON.stringify(fixture));
  console.log(JSON.stringify({ fixture: 'ch035-perf', port }));
});
