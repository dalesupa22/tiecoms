/**
 * Videos (docs/VIDEO.md): subida por stream a S3 en partes, URL prefirmada para reproducir y medición de
 * almacenamiento. Necesita el API (API_URL) con S3 falso (test/fake-s3.mjs, FAKE_S3_URL) que registra las
 * peticiones en /__log. No necesita el worker.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sniffVideo } from '../src/modules/attachments.ts';

const API = process.env.API_URL ?? 'http://localhost:3020';
const S3 = process.env.FAKE_S3_URL ?? 'http://localhost:59000';
const run = randomUUID().slice(0, 8);
const MP4 = readFileSync(new URL('./fixtures/video-2s.mp4', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
interface Actor { token: string; id: string; orgId: string }

async function call(path: string, opts: { method?: string; token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : opts.raw ? { 'content-type': 'application/octet-stream' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : opts.raw,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = {};
  try { json = JSON.parse(buf.toString()); } catch {}
  return { status: res.status, json, buf, headers: res.headers };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.vid.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const uploadVideo = (a: Actor, conv: string, body: Buffer, meta: Record<string, string> = {}) =>
  call(`/conversations/${conv}/videos`, { token: a.token, raw: body, headers: { 'content-type': 'video/mp4', 'x-file-name': encodeURIComponent('Paseo.mp4'), ...meta } });
const upload = (a: Actor, conv: string, body: Buffer, name: string, type: string, extra: Record<string, string> = {}) =>
  call(`/conversations/${conv}/attachments`, { token: a.token, raw: body, headers: { 'x-file-name': encodeURIComponent(name), 'x-file-type': type, ...extra } });
const send = (a: Actor, conv: string, extra: object) => call(`/conversations/${conv}/messages`, { token: a.token, body: { clientMessageId: randomUUID(), body: '', ...extra } });
const s3Log = async (): Promise<{ method: string; key: string; range: string | null; multipart: boolean; at: number }[]> => (await fetch(`${S3}/__log`)).json() as any;

/** POST crudo con node:http: cabeceras a mano (content-length falso) o cuerpo por partes (chunked). */
function rawPost(path: string, token: string, headers: Record<string, string>, chunks: AsyncIterable<Buffer> | Buffer[]) {
  return new Promise<number>((resolve, reject) => {
    const u = new URL(`${API}/api/v1${path}`);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', agent: false, headers: { authorization: `Bearer ${token}`, 'content-type': 'video/mp4', ...headers } }, (res) => {
      res.resume(); resolve(res.statusCode ?? 0);
    });
    req.on('error', (e: any) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve(-1) : reject(e)));
    (async () => {
      for await (const c of chunks) { if (req.destroyed) return; if (!req.write(c)) await new Promise((r) => req.once('drain', r)); }
      req.end();
    })().catch(() => {});
  });
}

describe('reconocer video por los primeros bytes', () => {
  it('MP4, MOV y WebM sí; audio, HEIC, PNG y texto no', () => {
    expect(sniffVideo(MP4)).toBe('video/mp4');
    const box = (brand: string) => { const b = Buffer.alloc(32); b.writeUInt32BE(32, 0); b.write('ftyp', 4); b.write(brand, 8); return b; };
    expect(sniffVideo(box('qt  '))).toBe('video/quicktime');
    expect(sniffVideo(box('mp42'))).toBe('video/mp4');
    expect(sniffVideo(box('M4A '))).toBeNull();
    expect(sniffVideo(box('heic'))).toBeNull();
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(20)]);
    expect(sniffVideo(webm)).toBe('video/webm');
    const mkv = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88]), Buffer.from('matroska'), Buffer.alloc(20)]);
    expect(sniffVideo(mkv)).toBeNull();
    expect(sniffVideo(PNG)).toBeNull();
    expect(sniffVideo(Buffer.from('hola, esto no es un video'))).toBeNull();
  });
});

describe('videos en el chat', () => {
  let ana: Actor, beto: Actor, laura: Actor, extra: Actor, generalId: string, otherId: string;
  beforeAll(async () => {
    ana = await signup('Ana');
    laura = await signup('Laura', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
    beto = await signup('Beto');
    extra = await signup('Extra');
    const ws = await call('/workspaces', { token: ana.token, body: { name: `Videos ${run}` } });
    generalId = ws.json.generalConversationId;
    const inv = await call(`/workspaces/${ws.json.id}/invitations`, { token: ana.token, body: { role: 'member', conversationIds: [generalId] } });
    await call(`/invitations/${inv.json.token}/accept`, { token: beto.token, body: {} });
    otherId = (await call('/chats', { token: ana.token, body: { userIds: [laura.id, beto.id], name: 'Otro chat' } })).json.id;
  });
  afterAll(() => {});

  let videoId = '';
  it('sube un MP4 real por stream: tipo por bytes, duración, ancho y alto, playUrl y pendiente', async () => {
    const r = await uploadVideo(ana, generalId, MP4, { 'x-duration-ms': '2000', 'x-width': '320', 'x-height': '180' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: 'Paseo.mp4', contentType: 'video/mp4', sizeBytes: MP4.length, width: 320, height: 180, durationMs: 2000, thumbUrl: null });
    expect(r.json.kind).toBeUndefined();
    expect(r.json.playUrl).toBe(`/api/v1/attachments/${r.json.id}/play`);
    videoId = r.json.id;
    // GET /attachments/:id lo sirve por stream desde S3 (mismos bytes) y reenvía el rango.
    const got = await call(`/attachments/${videoId}`, { token: ana.token });
    expect(got.status).toBe(200);
    expect(got.buf.equals(MP4)).toBe(true);
    const part = await call(`/attachments/${videoId}`, { token: ana.token, headers: { range: 'bytes=0-99' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-99/${MP4.length}`);
    expect(part.buf.equals(MP4.subarray(0, 100))).toBe(true);
    // Póster con la ruta de siempre.
    const th = await call(`/attachments/${videoId}/thumb`, { method: 'POST', token: ana.token, raw: PNG });
    expect(th.status).toBe(200);
    expect(th.json.thumbUrl).toBe(`/api/v1/attachments/${videoId}/thumb`);
    // Pendiente: solo su dueño.
    expect((await call(`/attachments/${videoId}/play`, { token: beto.token })).status).toBe(404);
  });

  it('un video de 12 MB sube en partes (multipart) y llega entero', async () => {
    const big = Buffer.concat([MP4.subarray(0, 64), randomBytes(12 * 1024 * 1024)]);
    const since = Date.now();
    const r = await uploadVideo(ana, generalId, big);
    expect(r.status).toBe(200);
    expect(r.json.sizeBytes).toBe(big.length);
    const log = (await s3Log()).filter((l) => l.at >= since && l.key.includes(r.json.id));
    expect(log.filter((l) => l.method === 'PUT' && l.multipart).length).toBeGreaterThanOrEqual(3);
    expect(log.some((l) => l.method === 'POST' && l.multipart)).toBe(true);
    const got = await call(`/attachments/${r.json.id}`, { token: ana.token });
    expect(got.buf.equals(big)).toBe(true);
  });

  it('rechaza lo que no es video, lo que pasa de 150 MB y a quien no es del chat', async () => {
    expect((await uploadVideo(ana, generalId, PNG)).status).toBe(415);
    expect((await uploadVideo(ana, generalId, Buffer.from('<script>alert(1)</script>'.repeat(10)))).status).toBe(415);
    const m4a = Buffer.alloc(64); m4a.writeUInt32BE(32, 0); m4a.write('ftyp', 4); m4a.write('M4A ', 8);
    expect((await uploadVideo(ana, generalId, m4a)).status).toBe(415);
    // Declara más de 150 MB: 413 sin leer el cuerpo.
    expect(await rawPost(`/conversations/${generalId}/videos`, ana.token, { 'content-length': String(151 * 1024 * 1024) }, [MP4.subarray(0, 64)])).toBe(413);
    // Por partes (sin content-length) y pasa el límite a mitad de camino: se corta.
    async function* huge() { yield MP4.subarray(0, 64); const mb = Buffer.alloc(1024 * 1024, 7); for (let i = 0; i < 152; i++) yield mb; }
    const status = await rawPost(`/conversations/${generalId}/videos`, ana.token, {}, huge());
    expect(status).toBe(413);
    // No es del chat / sin sesión.
    expect((await uploadVideo(extra, generalId, MP4)).status).toBe(404);
    expect((await call(`/conversations/${generalId}/videos`, { raw: MP4, headers: { 'content-type': 'video/mp4' } })).status).toBe(401);
    // Metadatos inválidos.
    expect((await uploadVideo(ana, generalId, MP4, { 'x-duration-ms': '-5' })).status).toBe(400);
  });

  it('URL prefirmada solo para quien puede leer: inline con Range directo a S3, y descarga con attachment', async () => {
    const sent = await send(ana, generalId, { attachmentIds: [videoId] });
    expect(sent.status).toBe(201);
    const dto = sent.json.message.attachments[0];
    expect(dto).toMatchObject({ id: videoId, durationMs: 2000, playUrl: `/api/v1/attachments/${videoId}/play` });
    const play = await call(`/attachments/${videoId}/play`, { token: beto.token });
    expect(play.status).toBe(200);
    expect(play.json.expiresIn).toBe(3600);
    expect(play.json.contentType).toBe('video/mp4');
    expect(play.headers.get('cache-control')).toBe('no-store');
    const url = new URL(play.json.url);
    expect(url.origin).toBe(new URL(S3).origin);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('response-content-disposition')).toMatch(/^inline;/);
    // El navegador pide rangos directo a S3 (sin Bearer, sin pasar por el API).
    const ranged = await fetch(play.json.url, { headers: { range: 'bytes=0-1023' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(Buffer.from(await ranged.arrayBuffer()).equals(MP4.subarray(0, 1024))).toBe(true);
    const dl = await call(`/attachments/${videoId}/play?download=1`, { token: beto.token });
    expect(new URL(dl.json.url).searchParams.get('response-content-disposition')).toMatch(/^attachment;/);
    // Quien no está en el chat, sin sesión, o algo que no es video.
    expect((await call(`/attachments/${videoId}/play`, { token: extra.token })).status).toBe(404);
    expect((await call(`/attachments/${videoId}/play`)).status).toBe(401);
    const img = await upload(ana, generalId, PNG, 'foto.png', 'image/png');
    expect((await call(`/attachments/${img.json.id}/play`, { token: ana.token })).status).toBe(400);
  });

  it('mide el almacenamiento por persona y por empresa sin contar dos veces los reenvíos', async () => {
    const before = (await call('/me/storage', { token: ana.token })).json;
    expect(before.scope).toBe('user');
    // Hasta aquí Ana tiene: el MP4, el de 12 MB y la foto de la prueba anterior (todos vivos).
    const photo = await upload(ana, generalId, PNG, 'otra.png', 'image/png');
    const doc = await upload(ana, generalId, Buffer.from('%PDF-1.4 hola'), 'Contrato.pdf', 'application/pdf');
    const m4a = Buffer.alloc(200); m4a.writeUInt32BE(32, 0); m4a.write('ftyp', 4); m4a.write('M4A ', 8);
    const voice = await upload(ana, generalId, m4a, 'nota.m4a', 'audio/mp4', { 'x-voice-note': '1', 'x-duration-ms': '1500' });
    expect(voice.status).toBe(200);
    await send(ana, generalId, { attachmentIds: [photo.json.id, doc.json.id, voice.json.id] });
    const mid = (await call('/me/storage', { token: ana.token })).json;
    expect(mid.totalBytes).toBe(before.totalBytes + PNG.length + 13 + 200);
    expect(mid.breakdown.photos).toBe(before.breakdown.photos + PNG.length);
    expect(mid.breakdown.files).toBe(before.breakdown.files + 13);
    expect(mid.breakdown.voice).toBe(before.breakdown.voice + 200);
    expect(mid.breakdown.videos).toBe(before.breakdown.videos);
    expect(mid.breakdown.videos).toBeGreaterThanOrEqual(MP4.length);
    expect(mid.bySource.chat).toBe(mid.totalBytes);
    // Beto reenvía el video a otro chat y Ana también: el objeto es el mismo, nadie suma más.
    const betoBefore = (await call('/me/storage', { token: beto.token })).json;
    expect((await send(beto, otherId, { forwardAttachmentIds: [videoId] })).status).toBe(201);
    expect((await send(ana, otherId, { forwardAttachmentIds: [videoId] })).status).toBe(201);
    const after = (await call('/me/storage', { token: ana.token })).json;
    const betoAfter = (await call('/me/storage', { token: beto.token })).json;
    expect(after.totalBytes).toBe(mid.totalBytes);
    expect(after.objects).toBe(mid.objects);
    expect(betoAfter.totalBytes).toBe(betoBefore.totalBytes);
    // Empresa: Ana (dueña) ve la suma de su gente; Laura (miembro) no puede; Extra no es de la empresa.
    await uploadVideo(laura, otherId, MP4);
    const org = await call(`/organizations/${ana.orgId}/storage`, { token: ana.token });
    expect(org.status).toBe(200);
    expect(org.json).toMatchObject({ scope: 'organization', id: ana.orgId, people: 2 });
    expect(org.json.totalBytes).toBe(after.totalBytes + MP4.length);
    expect((await call(`/organizations/${ana.orgId}/storage`, { token: laura.token })).status).toBe(403);
    expect((await call(`/organizations/${ana.orgId}/storage`, { token: extra.token })).status).toBe(404);
  });
});
