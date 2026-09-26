/**
 * APNs (HTTP/2 + JWT ES256) y FCM HTTP v1 (OAuth con cuenta de servicio) contra
 * servidores falsos en este mismo proceso: no necesita el API ni la base.
 */
import { generateKeyPairSync, verify } from 'node:crypto';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
let apns: http2.Http2Server, fcm: http.Server;
let apnsReqs: { headers: http2.IncomingHttpHeaders; body: any }[] = [];
let fcmReqs: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let apnsReply: { status: number; body?: object } = { status: 200 };
let t: typeof import('../src/push-transport.ts');

const parts = (jwt: string) => jwt.split('.').map((p, i) => (i < 2 ? JSON.parse(Buffer.from(p, 'base64url').toString()) : p));

beforeAll(async () => {
  apns = http2.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      apnsReqs.push({ headers: req.headers, body: JSON.parse(d) });
      res.writeHead(apnsReply.status, { 'content-type': 'application/json' }).end(apnsReply.body ? JSON.stringify(apnsReply.body) : '');
    });
  });
  fcm = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      fcmReqs.push({ url: req.url!, headers: req.headers, body: d });
      if (req.url === '/token') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
      const token = JSON.parse(d).message.token;
      if (token === 'gone') return res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
      if (token === 'quota') return res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', details: [{ errorCode: 'QUOTA_EXCEEDED' }] } }));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"name":"projects/p/messages/1"}');
    });
  });
  await new Promise<void>((r) => apns.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => fcm.listen(0, '127.0.0.1', r));
  const fcmOrigin = `http://127.0.0.1:${(fcm.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    APNS_HOST: `http://127.0.0.1:${(apns.address() as AddressInfo).port}`,
    APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'B76US7H3L3', APNS_BUNDLE_ID: 'com.tiecoms.app',
    APNS_KEY: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n'),
    FCM_HOST: fcmOrigin,
    FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'tiecoms-app', client_email: 'push@tiecoms-app.iam.gserviceaccount.com', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${fcmOrigin}/token` }),
  });
  delete process.env.APNS_KEY_PATH; delete process.env.FCM_SERVICE_ACCOUNT_PATH;
  t = await import('../src/push-transport.ts');
  t.resetPushConfig();
});
afterAll(() => { t?.closePushConnections(); apns?.close(); fcm?.close(); });

describe('APNs', () => {
  it('envía por HTTP/2 con JWT ES256 válido, tema y tipo alert', async () => {
    const r = await t.sendApns('abc123token', 'production', { aps: { alert: { title: 'Hola', body: 'x' } } }, { collapseId: 'm1' });
    expect(r).toEqual({ ok: true });
    const req = apnsReqs.at(-1)!;
    expect(req.headers[':path']).toBe('/3/device/abc123token');
    expect(req.headers['apns-topic']).toBe('com.tiecoms.app');
    expect(req.headers['apns-push-type']).toBe('alert');
    expect(req.headers['apns-priority']).toBe('10');
    expect(req.headers['apns-collapse-id']).toBe('m1');
    const jwt = String(req.headers.authorization).replace(/^bearer /, '');
    const [h, c, sig] = parts(jwt);
    expect(h).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(c.iss).toBe('B76US7H3L3');
    expect(Math.abs(c.iat - Date.now() / 1000)).toBeLessThan(5);
    const signed = jwt.split('.').slice(0, 2).join('.');
    expect(verify('sha256', Buffer.from(signed), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(req.body.aps.alert.title).toBe('Hola');
  });

  it('reutiliza el JWT y la conexión', async () => {
    await t.sendApns('tok2', 'sandbox', { aps: {} });
    const [a, b] = apnsReqs.slice(-2);
    expect(a!.headers.authorization).toBe(b!.headers.authorization);
  });

  it('410 y BadDeviceToken marcan el token como inválido; otros errores no', async () => {
    apnsReply = { status: 410, body: { reason: 'Unregistered' } };
    expect(await t.sendApns('t', 'production', { aps: {} })).toMatchObject({ ok: false, invalidToken: true });
    apnsReply = { status: 400, body: { reason: 'BadDeviceToken' } };
    expect(await t.sendApns('t', 'production', { aps: {} })).toMatchObject({ ok: false, invalidToken: true, error: 'apns_400_BadDeviceToken' });
    apnsReply = { status: 429, body: { reason: 'TooManyRequests' } };
    expect(await t.sendApns('t', 'production', { aps: {} })).toMatchObject({ ok: false, invalidToken: false });
    apnsReply = { status: 403, body: { reason: 'ExpiredProviderToken' } };
    const before = apnsReqs.at(-1)!.headers.authorization;
    await t.sendApns('t', 'production', { aps: {} });
    apnsReply = { status: 200 };
    await new Promise((r) => setTimeout(r, 1100));
    await t.sendApns('t', 'production', { aps: {} });
    expect(apnsReqs.at(-1)!.headers.authorization).not.toBe(before);
  });
});

describe('FCM HTTP v1', () => {
  it('pide el token OAuth con un JWT RS256 de la cuenta de servicio y manda un mensaje de datos', async () => {
    const r = await t.sendFcm('android-token', { type: 'message', title: 'Hola', badge: '2' }, { collapseKey: 'c1' });
    expect(r).toEqual({ ok: true });
    const tokenReq = fcmReqs.find((x) => x.url === '/token')!;
    const form = new URLSearchParams(tokenReq.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion')!;
    const [h, c, sig] = parts(assertion);
    expect(h.alg).toBe('RS256');
    expect(c).toMatchObject({ iss: 'push@tiecoms-app.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/firebase.messaging' });
    expect(verify('sha256', Buffer.from(assertion.split('.').slice(0, 2).join('.')), rsa.publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    const send = fcmReqs.at(-1)!;
    expect(send.url).toBe('/v1/projects/tiecoms-app/messages:send');
    expect(send.headers.authorization).toBe('Bearer ya29.test');
    const body = JSON.parse(send.body);
    expect(body.message).toEqual({ token: 'android-token', data: { type: 'message', title: 'Hola', badge: '2' }, android: { priority: 'high', ttl: '86400s', collapse_key: 'c1' } });
  });

  it('UNREGISTERED borra; cuota no', async () => {
    expect(await t.sendFcm('gone', {})).toMatchObject({ ok: false, invalidToken: true, error: 'fcm_404_UNREGISTERED' });
    expect(await t.sendFcm('quota', {})).toMatchObject({ ok: false, invalidToken: false });
    // El token OAuth se pidió una sola vez.
    expect(fcmReqs.filter((x) => x.url === '/token')).toHaveLength(1);
  });

  it('sin configuración no envía', async () => {
    delete process.env.FCM_SERVICE_ACCOUNT; delete process.env.APNS_KEY;
    t.resetPushConfig();
    expect(await t.sendFcm('x', {})).toMatchObject({ ok: false, error: 'fcm_not_configured' });
    expect(await t.sendApns('x', 'production', {})).toMatchObject({ ok: false, error: 'apns_not_configured' });
  });
});
