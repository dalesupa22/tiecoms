// API sintético mínimo (solo 127.0.0.1) para la prueba de interfaz del chat tras un 502 de despliegue
// (incidencia Alicia → Danny, 28-sep-2026). No usa base de datos ni toca ningún servidor real:
// el GET de mensajes del DM responde FAIL veces «502 Bad Gateway» en HTML (como nginx mientras se reemplaza el API)
// y después 200. Sin socket.io (404): la app queda «Sin conexión», como durante el despliegue.
//
//   PORT=3097 FAIL=2 FIXTURE_OUT=/tmp/fx502.json node apps/ios/tools/fixtures/gateway502-api.mjs
//   TEST_RUNNER_TC_FIXTURE_502=/tmp/fx502.json xcodebuild test ... -only-testing:TieComsUITests/GatewayRecoveryUITests
//
// GET /__stats devuelve cuántas veces se pidió cada ruta (lo lee la prueba).
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.PORT ?? 3097);
const fail = Number(process.env.FAIL ?? 2);
const password = randomUUID();
const me = { id: 'u-danny', name: 'Danny Prueba', kind: 'human', email: 'danny@synthetic.test', primaryOrgId: 'o1' };
const ali = { id: 'u-alicia', name: 'Alicia Prueba', kind: 'human', orgId: 'o1', guest: false };
const dm = 'dm-502';
const hits = { messagePOSTs: 0 };
const now = new Date().toISOString();

const bootstrap = {
  contract: '2026-09-23', serverTime: now, me,
  organizations: [{ id: 'o1', name: 'Sintética', mark: 'S', colorBg: '#000000', colorFg: '#ffffff', myRole: 'owner' }],
  workspaces: [],
  conversations: [{ id: dm, kind: 'direct', memberIds: [me.id, ali.id], lastMessageSeq: 1, lastEventSeq: 1, lastReadSeq: 1, unread: 0,
    canPost: true, historyFromSeq: 0, lastMessageAt: now, lastMessagePreview: 'Mensaje sintético después del 502' }],
  people: [{ ...me, orgId: 'o1', guest: false }, ali],
};
const page = { messages: [{ id: 'm-502-1', conversationId: dm, seq: 1, authorId: ali.id, kind: 'text', body: 'Mensaje sintético después del 502', createdAt: now }],
  hasMore: false, lastEventSeq: 1 };
const auth = () => ({ accessToken: 'synthetic-' + randomUUID(), accessExpiresAt: new Date(Date.now() + 3600e3).toISOString(),
  refreshToken: 'synthetic-refresh', sessionId: 's1', user: me });

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  hits[path] = (hits[path] ?? 0) + 1;
  req.resume();
  if (path === '/__stats') return json(res, 200, hits);
  if (path === '/api/v1/auth/login' || path === '/api/v1/auth/refresh') return json(res, 200, auth());
  if (path === '/api/v1/bootstrap') return json(res, 200, bootstrap);
  if (path === '/api/v1/blocks') return json(res, 200, { userIds: [] });
  if (path === `/api/v1/conversations/${dm}/messages`) {
    if (req.method !== 'GET') {
      hits.messagePOSTs += 1;
      return json(res, 405, { error: { code: 'read_only_fixture', message: 'Messages are read-only in this fixture' } });
    }
    if (hits[path] <= fail) {
      res.writeHead(502, { 'content-type': 'text/html' });
      return res.end('<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>');
    }
    return json(res, 200, page);
  }
  if (path === `/api/v1/conversations/${dm}/events`) return json(res, 200, { events: [], resetRequired: false, lastEventSeq: 1 });
  if (path.startsWith('/api/v1/')) return json(res, 200, { items: [], userIds: [], events: [] });
  json(res, 404, { error: { code: 'not_found', message: 'no' } });
}).listen(port, '127.0.0.1', () => {
  const fx = { apiUrl: `http://127.0.0.1:${port}`, email: me.email, password, dmId: dm, fail };
  if (process.env.FIXTURE_OUT) writeFileSync(process.env.FIXTURE_OUT, JSON.stringify(fx));
  console.log(JSON.stringify({ listening: port, fail }));
});
