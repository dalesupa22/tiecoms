/**
 * Perfil y foto. Necesita el API (API_URL) con S3 configurado; en local sirve el
 * S3 falso: node test/fake-s3.mjs 59000 y S3_ENDPOINT=http://localhost:59000.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);

async function call(path: string, opts: { method?: string; token?: string; body?: unknown; raw?: Buffer; type?: string } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : opts.raw ? { 'content-type': opts.type ?? 'image/png' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : opts.raw,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = {};
  try { json = JSON.parse(buf.toString()); } catch {}
  return { status: res.status, json, buf, headers: res.headers };
}

// PNG de 1×1 válido.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let ana: { token: string; id: string }, beto: { token: string; id: string };

async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/auth/signup', { body: {
    name, ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} ${run}` }), email: `${name.toLowerCase()}.${run}@example.com`, password: 'clave-segura-123',
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string };
}

beforeAll(async () => {
  ana = await signup('Ana');
  const inv = await call(`/organizations/${(await call('/bootstrap', { token: ana.token })).json.me.primaryOrgId}/invitations`, { token: ana.token, body: {} });
  beto = await signup('Beto', inv.json.token);
});

describe('perfil', () => {
  it('cambia nombre, cargo y área', async () => {
    const r = await call('/me', { token: ana.token, method: 'PATCH', body: { name: 'Ana María', title: 'Coordinadora', area: 'Operaciones' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: 'Ana María', title: 'Coordinadora', area: 'Operaciones' });
    const b = await call('/bootstrap', { token: beto.token });
    expect(b.json.people.find((p: any) => p.id === ana.id)).toMatchObject({ name: 'Ana María', title: 'Coordinadora' });
    expect((await call('/me', { token: ana.token, method: 'PATCH', body: { name: 'A' } })).status).toBe(400);
    const clear = await call('/me', { token: ana.token, method: 'PATCH', body: { area: null } });
    expect(clear.json.area).toBeNull();
    expect(clear.json.title).toBe('Coordinadora');
  });
});

describe('foto de perfil', () => {
  it('rechaza lo que no es imagen aunque diga image/png', async () => {
    const r = await call('/me/avatar', { token: ana.token, raw: Buffer.from('<svg onload=alert(1)>'), type: 'image/png' });
    expect(r.status).toBe(400);
  });

  it('sube, la ven sus contactos y se reemplaza', async () => {
    const up = await call('/me/avatar', { token: ana.token, raw: PNG });
    expect(up.status).toBe(200);
    const url1: string = up.json.avatarUrl;
    expect(url1).toMatch(/^\/api\/v1\/avatars\/[0-9a-f-]{36}$/);
    const b = await call('/bootstrap', { token: beto.token });
    expect(b.json.people.find((p: any) => p.id === ana.id).avatarUrl).toBe(url1);
    const img = await fetch(`${API}${url1}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);

    const up2 = await call('/me/avatar', { token: ana.token, raw: PNG });
    expect(up2.json.avatarUrl).not.toBe(url1);
    expect((await fetch(`${API}${url1}`)).status).toBe(404);
  });

  it('se quita', async () => {
    const r = await call('/me/avatar', { token: ana.token, method: 'DELETE' });
    expect(r.json.avatarUrl).toBeNull();
    expect((await call('/bootstrap', { token: ana.token })).json.me.avatarUrl).toBeNull();
  });

  it('sin sesión no se sube', async () => {
    expect((await call('/me/avatar', { raw: PNG })).status).toBe(401);
  });
});
