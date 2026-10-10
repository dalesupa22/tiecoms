/**
 * Archivos grandes (MAX_LARGE_FILE_BYTES = 150 MB) por stream a un chat o a una tarea: POST /conversations/:id/files
 * y /issues/:id/files. Reporte de Lorena 9-oct-2026: un Illustrator (.ai) de 30 MB se quedaba «cargando» (413 de
 * nginx con el límite de 25 MB). Necesita el API (API_URL) con S3 falso (test/fake-s3.mjs, FAKE_S3_URL).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const S3 = process.env.FAKE_S3_URL ?? 'http://localhost:59000';
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
    name, email: `${name.toLowerCase()}.big.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const s3Log = async (): Promise<{ method: string; key: string; multipart: boolean; at: number }[]> => (await fetch(`${S3}/__log`)).json() as any;
const big = (name: string, type: string) => ({ 'x-file-name': encodeURIComponent(name), 'x-file-type': type });

function rawPost(path: string, token: string, headers: Record<string, string>, chunks: AsyncIterable<Buffer> | Buffer[]) {
  return new Promise<number>((resolve, reject) => {
    const u = new URL(`${API}/api/v1${path}`);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', agent: false, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', ...headers } }, (res) => {
      res.resume(); resolve(res.statusCode ?? 0);
    });
    req.on('error', (e: any) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve(-1) : reject(e)));
    (async () => {
      for await (const c of chunks) { if (req.destroyed) return; if (!req.write(c)) await new Promise((r) => req.once('drain', r)); }
      req.end();
    })().catch(() => {});
  });
}

describe('archivos grandes por stream', () => {
  let ana: Actor, laura: Actor, extra: Actor, generalId: string;
  // Un .ai real empieza como PDF (%PDF-); 30 MB como el de Lorena.
  const ai = Buffer.concat([Buffer.from('%PDF-1.6\n%âãÏÓ\n'), randomBytes(30 * 1024 * 1024)]);
  beforeAll(async () => {
    ana = await signup('Ana');
    laura = await signup('Laura', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
    extra = await signup('Extra');
    generalId = (await call('/workspaces', { token: ana.token, body: { name: `Grandes ${run}` } })).json.generalConversationId;
    expect(laura.id).toBeTruthy();
  });

  it('chat: un Illustrator de 30 MB sube en partes, conserva nombre y tipo, y se adjunta a un mensaje', async () => {
    const since = Date.now();
    const r = await call(`/conversations/${generalId}/files`, { token: ana.token, raw: ai, headers: big('Logo Provida Ñ.ai', 'application/postscript') });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: 'Logo Provida Ñ.ai', contentType: 'application/postscript', sizeBytes: ai.length, width: null, height: null });
    const log = (await s3Log()).filter((l) => l.at >= since && l.key.includes(r.json.id));
    expect(log.filter((l) => l.method === 'PUT' && l.multipart).length).toBeGreaterThanOrEqual(6);
    const got = await call(`/attachments/${r.json.id}`, { token: ana.token });
    expect(got.status).toBe(200);
    expect(got.buf.equals(ai)).toBe(true);
    const msg = await call(`/conversations/${generalId}/messages`, { token: ana.token, body: { clientMessageId: randomUUID(), body: 'el logo', attachmentIds: [r.json.id] } });
    expect(msg.status).toBe(201);
    expect(msg.json.message.attachments[0].id).toBe(r.json.id);
  });

  it('una imagen o un video grande queda como archivo genérico; el tipo inválido también', async () => {
    const r = await call(`/conversations/${generalId}/files`, { token: ana.token, raw: randomBytes(1024), headers: big('foto.png', 'image/png') });
    expect(r.status).toBe(200);
    expect(r.json.contentType).toBe('application/octet-stream');
    const bad = await call(`/conversations/${generalId}/files`, { token: ana.token, raw: randomBytes(1024), headers: big('x.bin', 'text/html; <script>') });
    expect(bad.json.contentType).toBe('text/html');
    const junk = await call(`/conversations/${generalId}/files`, { token: ana.token, raw: randomBytes(1024), headers: big('x.bin', 'nada') });
    expect(junk.json.contentType).toBe('application/octet-stream');
  });

  it('tarea: sube por stream y el PATCH la vincula; la ve quien ve la tarea', async () => {
    const t = await call(`/conversations/${generalId}/issues`, { token: ana.token, body: { title: `Provida ${run}` } });
    expect(t.status).toBe(200);
    const r = await call(`/issues/${t.json.id}/files`, { token: ana.token, raw: ai, headers: big('Mesa de trabajo.ai', 'application/illustrator') });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: 'Mesa de trabajo.ai', contentType: 'application/illustrator', sizeBytes: ai.length });
    const p = await call(`/issues/${t.json.id}`, { method: 'PATCH', token: ana.token, body: { attachmentIds: [r.json.id] } });
    expect(p.status).toBe(200);
    const full = await call(`/issues/${t.json.id}`, { token: ana.token });
    expect((full.json.issue ?? full.json).attachments.map((a: any) => a.id)).toContain(r.json.id);
    expect((await call(`/attachments/${r.json.id}`, { token: extra.token })).status).toBe(404);
    expect((await call(`/issues/${t.json.id}/files`, { token: extra.token, raw: randomBytes(10), headers: big('x.ai', 'application/postscript') })).status).toBe(404);
  });

  it('rechaza más de 150 MB (declarado o a mitad de camino), vacío, sin sesión y a quien no es del chat', async () => {
    expect(await rawPost(`/conversations/${generalId}/files`, ana.token, { 'content-length': String(151 * 1024 * 1024) }, [Buffer.alloc(64)])).toBe(413);
    async function* huge() { const mb = Buffer.alloc(1024 * 1024, 7); for (let i = 0; i < 152; i++) yield mb; }
    expect(await rawPost(`/conversations/${generalId}/files`, ana.token, {}, huge())).toBe(413);
    expect((await call(`/conversations/${generalId}/files`, { token: ana.token, raw: Buffer.alloc(0), headers: big('vacio.ai', 'application/postscript') })).status).toBe(400);
    expect((await call(`/conversations/${generalId}/files`, { raw: randomBytes(10) })).status).toBe(401);
    expect((await call(`/conversations/${generalId}/files`, { token: extra.token, raw: randomBytes(10), headers: big('x.ai', 'application/postscript') })).status).toBe(404);
  });
});
