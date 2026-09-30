// API sintético mínimo (solo 127.0.0.1) para la prueba de interfaz de «Nueva llamada» (1.7.6). Sin base de datos ni
// servidores reales: implementa el contrato de POST /api/v1/calls/instant (rama web-llamada-rapida) con el proveedor falso de
// llamadas (MeetingId «fake-…»: la app usa medios nulos). La llamada trae una invitada por enlace con correo.
//
//   PORT=3098 FIXTURE_OUT=/tmp/fx-instant.json node apps/ios/tools/fixtures/instant-call-api.mjs
//   TEST_RUNNER_TC_FIXTURE_INSTANT=/tmp/fx-instant.json xcodebuild test ... -only-testing:TieComsUITests/NuevaLlamadaUITests
//
// POST /__old con {"on":true} hace que /calls/instant responda 404 (servidor viejo). GET /__stats cuenta las rutas pedidas.
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.PORT ?? 3098);
const password = randomUUID();
const me = { id: 'u-danny', name: 'Danny Prueba', kind: 'human', email: 'danny@synthetic.test', primaryOrgId: 'o1' };
const now = () => new Date().toISOString();
const hits = {};
let old = false;
let call = null;
let lastInstant = null;

const bootstrap = () => ({
  contract: '2026-09-29.1', serverTime: now(), me, features: { calls: true },
  organizations: [{ id: 'o1', name: 'Sintética', mark: 'S', colorBg: '#000000', colorFg: '#ffffff', myRole: 'owner' }],
  workspaces: [], conversations: [], people: [{ ...me, orgId: 'o1', guest: false }],
});
const auth = () => ({ accessToken: 'synthetic-' + randomUUID(), accessExpiresAt: new Date(Date.now() + 3600e3).toISOString(),
  refreshToken: 'synthetic-refresh', sessionId: 's1', user: me });
const meeting = (id) => ({
  meeting: { Meeting: { MeetingId: `fake-${id}`, ExternalMeetingId: id, MediaRegion: 'us-east-1',
    MediaPlacement: { AudioHostUrl: 'fake.invalid:3478', SignalingUrl: 'wss://fake.invalid/control', TurnControlUrl: 'https://fake.invalid/turn' } } },
  attendee: { Attendee: { AttendeeId: `att-${id}`, ExternalUserId: `${me.id}#ios`, JoinToken: 'tok' } },
});

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  hits[path] = (hits[path] ?? 0) + 1;
  const body = req.method === 'POST' ? await readBody(req) : {};
  if (path === '/__stats') return json(res, 200, { ...hits, lastInstant });
  if (path === '/__old') { old = body.on === true; return json(res, 200, { old }); }
  if (path === '/api/v1/auth/login' || path === '/api/v1/auth/refresh') return json(res, 200, auth());
  if (path === '/api/v1/bootstrap') return json(res, 200, bootstrap());
  if (path === '/api/v1/blocks') return json(res, 200, { userIds: [] });
  if (path === '/api/v1/calls') return json(res, 200, { calls: [], hasMore: false });
  if (path === '/api/v1/calls/active') return json(res, 200, { calls: call && !call.endedAt ? [{ call, title: call.title }] : [] });
  if (path === '/api/v1/calls/instant' && req.method === 'POST') {
    if (old) return json(res, 404, { error: { code: 'not_found', message: 'Route POST:/api/v1/calls/instant not found' } });
    const id = 'call-' + randomUUID().slice(0, 8), conv = 'conv-' + id, token = 'tok_' + randomUUID().replace(/-/g, '');
    lastInstant = { title: body.title ?? null, video: body.video ?? null };
    call = { id, conversationId: conv, kind: body.video ? 'video' : 'audio', startedBy: me.id, startedAt: now(), endedAt: null,
      activeUserIds: [me.id], transcribing: false, hasTranscript: false, title: body.title ?? null,
      guests: [{ id: 'g1', name: 'Laura Invitada', email: 'laura@correo.test' }], names: { 'guest:g1': 'Laura Invitada' } };
    return json(res, 201, { call, conversationId: conv, link: { url: `https://app.chaggu.com/llamada/${token}`, token } });
  }
  const m = path.match(/^\/api\/v1\/calls\/([^/]+)\/(join|heartbeat|leave|end)$/);
  if (m && call && m[1] === call.id) {
    if (m[2] === 'join') return json(res, 200, { call, ...meeting(call.id) });
    if (m[2] === 'heartbeat') return json(res, 200, { ok: true });
    call = { ...call, endedAt: now(), activeUserIds: [] };
    return json(res, 200, { call });
  }
  if (path.startsWith('/api/v1/conversations/') && path.endsWith('/call')) return json(res, 200, { call: null });
  if (path.startsWith('/api/v1/')) return json(res, 200, { items: [], userIds: [], events: [], calls: [] });
  json(res, 404, { error: { code: 'not_found', message: 'no' } });
}).listen(port, '127.0.0.1', () => {
  const fx = { apiUrl: `http://127.0.0.1:${port}`, email: me.email, password };
  if (process.env.FIXTURE_OUT) writeFileSync(process.env.FIXTURE_OUT, JSON.stringify(fx));
  console.log(JSON.stringify({ listening: port }));
});
