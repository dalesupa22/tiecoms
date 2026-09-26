// APNs y FCM falsos para pruebas locales (sin validar firmas; sí el formato del JWT).
//   node test/fake-push.mjs 59044 59045
// y en el entorno del worker:
//   APNS_HOST=http://localhost:59044 APNS_KEY_ID=… APNS_TEAM_ID=… APNS_KEY_PATH=<llave de prueba>
//   FCM_HOST=http://localhost:59045 FCM_SERVICE_ACCOUNT_PATH=<json con token_uri=http://localhost:59045/token>
// GET http://localhost:59045/sent devuelve lo recibido por ambos. Un token que contenga "bad"
// responde como token inválido (APNs 410 Unregistered, FCM 404 UNREGISTERED).
import http from 'node:http';
import http2 from 'node:http2';

const sent = [];
const jwtOk = (t, alg) => {
  const parts = String(t ?? '').split('.');
  if (parts.length !== 3) return false;
  try { return JSON.parse(Buffer.from(parts[0], 'base64url').toString()).alg === alg; } catch { return false; }
};

http2.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const token = decodeURIComponent(String(req.headers[':path']).replace(/^\/3\/device\//, ''));
    if (!jwtOk(String(req.headers.authorization).replace(/^bearer /, ''), 'ES256')) {
      return res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ reason: 'InvalidProviderToken' }));
    }
    if (token.includes('bad')) return res.writeHead(410, { 'content-type': 'application/json' }).end(JSON.stringify({ reason: 'Unregistered', timestamp: Date.now() }));
    sent.push({ provider: 'apns', token, topic: req.headers['apns-topic'], pushType: req.headers['apns-push-type'], body: JSON.parse(data), at: Date.now() });
    res.writeHead(200, { 'apns-id': crypto.randomUUID() }).end();
  });
}).listen(Number(process.argv[2] ?? 59044), () => console.log('fake-apns listo'));

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/sent') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sent));
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    if (req.url === '/token') {
      const assertion = new URLSearchParams(data).get('assertion');
      if (!jwtOk(assertion, 'RS256')) return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: `fake-oauth-${Date.now()}`, expires_in: 3600, token_type: 'Bearer' }));
    }
    const m = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(req.url ?? '');
    if (!m || !String(req.headers.authorization).startsWith('Bearer fake-oauth-')) return res.writeHead(401).end();
    const body = JSON.parse(data);
    const token = body.message?.token ?? '';
    if (token.includes('bad')) {
      return res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }));
    }
    sent.push({ provider: 'fcm', token, project: m[1], body, at: Date.now() });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: `projects/${m[1]}/messages/${Date.now()}` }));
  });
}).listen(Number(process.argv[3] ?? 59045), () => console.log('fake-fcm listo'));
