/**
 * Adjuntos en mensajes. Necesita el API y su worker (API_URL) con S3 (en local, test/fake-s3.mjs).
 * Las pruebas de ancho/alto no necesitan el API.
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageSize, sniffImage, summarize, summaryText } from '../src/modules/attachments.ts';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
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
    name, email: `${name.toLowerCase()}.att.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const upload = (a: Actor, conv: string, body: Buffer, name: string, type: string) =>
  call(`/conversations/${conv}/attachments`, { token: a.token, raw: body, headers: { 'x-file-name': encodeURIComponent(name), 'x-file-type': type } });
const send = (a: Actor, conv: string, body: string, extra: object = {}, clientMessageId = randomUUID()) =>
  call(`/conversations/${conv}/messages`, { token: a.token, body: { clientMessageId, body, ...extra } });

// PNG 1×1 y un JPEG mínimo de 3×2 (SOF0).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);

describe('lectura de imágenes', () => {
  it('reconoce tipo y tamaño de PNG, JPEG, GIF y WebP', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(imageSize(PNG)).toEqual({ width: 1, height: 1 });
    expect(imageSize(JPEG)).toEqual({ width: 3, height: 2 });
    const gif = Buffer.from('GIF89a\x05\x00\x07\x00\x00\x00\x00', 'latin1');
    expect(imageSize(gif)).toEqual({ width: 5, height: 7 });
    const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.write('WEBPVP8X', 8); webp.writeUIntLE(639, 24, 3); webp.writeUIntLE(479, 27, 3);
    expect(imageSize(webp)).toEqual({ width: 640, height: 480 });
    expect(imageSize(Buffer.from('<svg/>'))).toBeNull();
  });
  it('resume adjuntos para las vistas previas', () => {
    const a = (contentType: string, name = 'x') => ({ id: '', name, contentType, sizeBytes: 1, width: null, height: null, url: '', thumbUrl: null });
    expect(summaryText(summarize([a('image/png')])!, 'es')).toBe('📷 Foto');
    expect(summaryText(summarize([a('image/png'), a('image/jpeg'), a('image/webp')])!, 'es')).toBe('📷 3 fotos');
    expect(summaryText(summarize([a('video/mp4')])!, 'en')).toBe('🎬 Video');
    expect(summaryText(summarize([a('application/pdf', 'Contrato.pdf')])!, 'es')).toBe('📎 Contrato.pdf');
    expect(summarize([])).toBeNull();
  });
});

describe('adjuntos en mensajes', () => {
  let ana: Actor, beto: Actor, laura: Actor, extra: Actor, generalId: string, otherId: string, wsId: string;
  let betoSocket: Socket;
  beforeAll(async () => {
    ana = await signup('Ana');
    laura = await signup('Laura', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
    beto = await signup('Beto');
    extra = await signup('Extra');
    const ws = await call('/workspaces', { token: ana.token, body: { name: `Adjuntos ${run}` } });
    wsId = ws.json.id; generalId = ws.json.generalConversationId;
    const inv = await call(`/workspaces/${wsId}/invitations`, { token: ana.token, body: { role: 'member', conversationIds: [generalId] } });
    await call(`/invitations/${inv.json.token}/accept`, { token: beto.token, body: {} });
    otherId = (await call('/chats', { token: ana.token, body: { userIds: [laura.id, beto.id], name: 'Otro chat' } })).json.id;
    betoSocket = await new Promise((res, rej) => {
      const s = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: beto.token } });
      s.once('ready', () => res(s)); s.once('connect_error', rej);
    });
  });
  afterAll(() => betoSocket?.disconnect());

  it('sube una foto: tipo real, tamaño y queda pendiente (solo la ve quien la subió)', async () => {
    const r = await upload(ana, generalId, PNG, 'Captura de pantalla.png', 'image/png');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: 'Captura de pantalla.png', contentType: 'image/png', sizeBytes: PNG.length, width: 1, height: 1, thumbUrl: null });
    expect(r.json.url).toBe(`/api/v1/attachments/${r.json.id}`);
    expect((await call(`/attachments/${r.json.id}`, { token: ana.token })).buf.equals(PNG)).toBe(true);
    expect((await call(`/attachments/${r.json.id}`, { token: beto.token })).status).toBe(404);
  });

  it('valida permisos, tamaño y tipo', async () => {
    expect((await upload(extra, generalId, PNG, 'a.png', 'image/png')).status).toBe(404);
    expect((await call(`/conversations/${generalId}/attachments`, { raw: PNG })).status).toBe(401);
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 1);
    expect([413]).toContain((await upload(ana, generalId, big, 'grande.bin', 'application/octet-stream')).status);
    // Lo que dice ser imagen y no lo es se guarda como archivo genérico y se descarga (nunca en línea).
    const fake = await upload(ana, generalId, Buffer.from('<svg onload=alert(1)>'), 'x.svg', 'image/svg+xml');
    expect(fake.json.contentType).toBe('application/octet-stream');
    const html = await upload(ana, generalId, Buffer.from('<script>alert(1)</script>'), 'x.html', 'text/html');
    expect(html.json.contentType).toBe('text/html');
    const got = await call(`/attachments/${html.json.id}`, { token: ana.token });
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
    expect(got.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('mensaje solo con adjuntos: llega con attachments, lo ven los miembros y no quien no está', async () => {
    const a1 = (await upload(ana, generalId, PNG, 'uno.png', 'image/png')).json;
    const a2 = (await upload(ana, generalId, JPEG, 'dos.jpg', 'image/jpeg')).json;
    const doc = (await upload(ana, generalId, Buffer.from('%PDF-1.4 hola'), 'Contrato final.pdf', 'application/pdf')).json;
    const ev = new Promise<any>((res) => betoSocket.on('conv.event', (e) => { if (e.type === 'message.created' && e.message.attachments?.length === 3) res(e); }));
    const r = await send(ana, generalId, '', { attachmentIds: [a2.id, a1.id, doc.id] });
    expect(r.status).toBe(201);
    expect(r.json.message.body).toBe('');
    expect(r.json.message.attachments.map((x: any) => x.id)).toEqual([a2.id, a1.id, doc.id]);
    expect((await ev).message.attachments[0]).toMatchObject({ name: 'dos.jpg', width: 3, height: 2 });
    const page = (await call(`/conversations/${generalId}/messages`, { token: beto.token })).json.messages;
    expect(page.at(-1).attachments).toHaveLength(3);
    const pdf = await call(`/attachments/${doc.id}`, { token: beto.token });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toContain("filename*=UTF-8''Contrato%20final.pdf");
    expect((await call(`/attachments/${doc.id}?download=1`, { token: beto.token })).headers.get('content-disposition')).toMatch(/^attachment;/);
    const part = await call(`/attachments/${doc.id}`, { token: beto.token, headers: { range: 'bytes=0-3' } });
    expect(part.status).toBe(206);
    expect(part.buf.toString()).toBe('%PDF');
    expect((await call(`/attachments/${doc.id}`, { token: extra.token })).status).toBe(404);
    expect((await call(`/attachments/${doc.id}`, { token: laura.token })).status).toBe(404);
    // Un adjunto ya usado no se puede volver a usar, ni el de otra persona, ni el de otra conversación.
    expect((await send(ana, generalId, 'otra vez', { attachmentIds: [a1.id] })).status).toBe(400);
    const betoAtt = (await upload(beto, generalId, PNG, 'b.png', 'image/png')).json;
    expect((await send(ana, generalId, 'ajeno', { attachmentIds: [betoAtt.id] })).status).toBe(400);
    const elsewhere = (await upload(ana, otherId, PNG, 'c.png', 'image/png')).json;
    expect((await send(ana, generalId, 'otra conv', { attachmentIds: [elsewhere.id] })).status).toBe(400);
    // Sin texto ni adjuntos sigue siendo inválido; más de 10, también.
    expect((await send(ana, generalId, '')).status).toBe(400);
    expect((await send(ana, generalId, 'x', { attachmentIds: Array.from({ length: 11 }, () => randomUUID()) })).status).toBe(400);
  });

  it('respeta el historial: quien entra después no ve adjuntos anteriores', async () => {
    const a = (await upload(ana, otherId, PNG, 'antes.png', 'image/png')).json;
    await send(ana, otherId, 'antes', { attachmentIds: [a.id] });
    // Laura ya estaba: la sacamos y vuelve a entrar sin historial.
    await call(`/conversations/${otherId}/members/${laura.id}`, { token: laura.token, method: 'DELETE' });
    await call(`/conversations/${otherId}/members`, { token: ana.token, body: { userIds: [laura.id], history: 'now' } });
    expect((await call(`/attachments/${a.id}`, { token: laura.token })).status).toBe(403);
    expect((await call(`/attachments/${a.id}`, { token: beto.token })).status).toBe(200);
  });

  it('idempotencia: el mismo clientMessageId con los mismos adjuntos devuelve el mismo mensaje; con otros, conflicto', async () => {
    const a = (await upload(ana, generalId, PNG, 'idem.png', 'image/png')).json;
    const cid = randomUUID();
    const first = await send(ana, generalId, 'con foto', { attachmentIds: [a.id] }, cid);
    const again = await send(ana, generalId, 'con foto', { attachmentIds: [a.id] }, cid);
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    expect(again.json.message.id).toBe(first.json.message.id);
    expect(again.json.message.attachments).toHaveLength(1);
    expect((await send(ana, generalId, 'con foto', {}, cid)).status).toBe(409);
  });

  it('borrar el mensaje oculta sus adjuntos (también al ponerse al día)', async () => {
    const a = (await upload(ana, generalId, PNG, 'borrar.png', 'image/png')).json;
    const m = (await send(ana, generalId, 'se va', { attachmentIds: [a.id] })).json.message;
    const del = await call(`/messages/${m.id}`, { token: ana.token, method: 'DELETE' });
    expect(del.json.attachments).toEqual([]);
    expect((await call(`/attachments/${a.id}`, { token: beto.token })).status).toBe(404);
    const evs = (await call(`/conversations/${generalId}/events?after=0`, { token: beto.token })).json.events;
    expect(evs.find((e: any) => e.type === 'message.created' && e.message.id === m.id).message.attachments).toEqual([]);
  });

  it('reenviar copia los adjuntos (mismo archivo) y exige poder leer el original', async () => {
    const a = (await upload(ana, generalId, JPEG, 'reenvio.jpg', 'image/jpeg')).json;
    await send(ana, generalId, 'mira', { attachmentIds: [a.id] });
    const fw = await send(ana, otherId, 'mira', { forwarded: { source: 'tiecoms', author: 'Ana', fromConversationId: generalId }, forwardAttachmentIds: [a.id] });
    expect(fw.status).toBe(201);
    const copy = fw.json.message.attachments[0];
    expect(copy.id).not.toBe(a.id);
    expect(copy).toMatchObject({ name: 'reenvio.jpg', width: 3, height: 2 });
    expect((await call(`/attachments/${copy.id}`, { token: laura.token })).buf.equals(JPEG)).toBe(true);
    // Laura no puede leer General: no puede reenviar desde allí.
    expect((await send(laura, otherId, 'robo', { forwardAttachmentIds: [a.id] })).status).toBe(404);
  });

  it('miniatura subida por el cliente y vista previa de la lista (lastHumanPreview)', async () => {
    const a = (await upload(ana, generalId, PNG, 'thumb.png', 'image/png')).json;
    const th = await call(`/attachments/${a.id}/thumb`, { token: ana.token, raw: JPEG });
    expect(th.json.thumbUrl).toBe(`/api/v1/attachments/${a.id}/thumb`);
    expect((await call(`/attachments/${a.id}/thumb`, { token: ana.token, raw: Buffer.from('no') })).status).toBe(400);
    const m = (await send(ana, generalId, '', { attachmentIds: [a.id] })).json.message;
    expect((await call(`/attachments/${a.id}/thumb`, { token: beto.token })).buf.equals(JPEG)).toBe(true);
    // Un aviso de sistema después: la lista sigue mostrando la foto.
    await call(`/conversations/${generalId}/issues`, { token: ana.token, body: { title: 'Revisar la foto' } });
    const c = (await call('/bootstrap', { token: beto.token })).json.conversations.find((x: any) => x.id === generalId);
    expect(JSON.parse(c.lastMessagePreview).k).toBe('issue.created');
    expect(c.lastHumanPreview).toMatchObject({ messageId: m.id, authorId: ana.id, body: '', attachments: { count: 1, images: 1, videos: 0, files: 0, firstName: 'thumb.png' } });
  });
});
