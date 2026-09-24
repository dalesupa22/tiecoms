/**
 * Archivos en árbol. Necesita el API (API_URL) con S3; en local, el S3 falso:
 * node test/fake-s3.mjs 59000 y S3_ENDPOINT=http://localhost:59000.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);

async function call(path: string, opts: { method?: string; token?: string; body?: unknown; raw?: Buffer; fileType?: string } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.raw ? { 'content-type': 'application/octet-stream', 'x-file-type': opts.fileType ?? 'application/octet-stream' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : opts.raw,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

async function signup(name: string) {
  const r = await call('/auth/signup', { body: {
    name, orgName: `${name} ${run}`, email: `${name.toLowerCase()}.drive.${run}@example.com`, password: 'clave-segura-123',
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string };
}

let ana: { token: string; id: string }, beto: { token: string; id: string }, wsId: string;

beforeAll(async () => {
  ana = await signup('Ana');
  beto = await signup('Beto');
  wsId = (await call('/workspaces', { token: ana.token, body: { name: `Proyecto ${run}` } })).json.id;
});

describe('Mis archivos', () => {
  let docs: string, contratos: string, fileId: string;

  it('crea un árbol de carpetas y no repite nombres en el mismo nivel', async () => {
    docs = (await call('/drive/folders', { token: ana.token, body: { name: 'Documentos' } })).json.id;
    contratos = (await call('/drive/folders', { token: ana.token, body: { name: 'Contratos', parentId: docs } })).json.id;
    expect((await call('/drive/folders', { token: ana.token, body: { name: 'documentos' } })).status).toBe(409);
    const tr = await call('/drive/tree', { token: ana.token });
    expect(tr.json.folders.map((f: any) => [f.name, f.parentId])).toEqual([['Contratos', docs], ['Documentos', null]]);
  });

  it('sube un archivo (aunque sea .json) y lo baja con un enlace firmado', async () => {
    const body = Buffer.from('{"hola":"mundo"}');
    const up = await call(`/drive/files?name=${encodeURIComponent('datos.json')}&folderId=${contratos}`, { token: ana.token, raw: body, fileType: 'application/json' });
    expect(up.status).toBe(200);
    expect(up.json).toMatchObject({ name: 'datos.json', contentType: 'application/json', size: body.length, folderId: contratos });
    fileId = up.json.id;
    const link = await call(`/drive/files/${fileId}/link`, { token: ana.token });
    const got = await fetch(link.json.url);
    expect(Buffer.from(await got.arrayBuffer()).equals(body)).toBe(true);
  });

  it('nadie más ve ni baja lo de otra persona', async () => {
    expect((await call('/drive/tree', { token: beto.token })).json.folders).toHaveLength(0);
    expect((await call(`/drive/files/${fileId}/link`, { token: beto.token })).status).toBe(404);
    expect((await call('/drive/folders', { token: beto.token, body: { name: 'X', parentId: docs } })).status).toBe(404);
    expect((await call(`/drive/folders/${docs}`, { token: beto.token, method: 'DELETE' })).status).toBe(404);
  });

  it('mueve, pero no una carpeta dentro de sí misma', async () => {
    expect((await call(`/drive/folders/${docs}`, { token: ana.token, method: 'PATCH', body: { parentId: contratos } })).status).toBe(400);
    const mv = await call(`/drive/files/${fileId}`, { token: ana.token, method: 'PATCH', body: { folderId: docs, name: 'datos-2026.json' } });
    expect(mv.json).toMatchObject({ folderId: docs, name: 'datos-2026.json' });
    expect((await call(`/drive/folders/${contratos}`, { token: ana.token, method: 'PATCH', body: { parentId: null } })).json.parentId).toBeNull();
  });

  it('borrar una carpeta se lleva lo que tiene dentro', async () => {
    const r = await call(`/drive/folders/${docs}`, { token: ana.token, method: 'DELETE' });
    expect(r.json).toMatchObject({ folders: 1, files: 1 });
    const tr = await call('/drive/tree', { token: ana.token });
    expect(tr.json.folders.map((f: any) => f.name)).toEqual(['Contratos']);
    expect(tr.json.files).toHaveLength(0);
  });
});

describe('carpetas de un espacio', () => {
  it('las ven sus miembros y nadie de fuera', async () => {
    const f = await call('/drive/folders', { token: ana.token, body: { workspaceId: wsId, name: 'Entregables' } });
    expect(f.status).toBe(200);
    const up = await call(`/drive/files?name=acta.txt&workspaceId=${wsId}&folderId=${f.json.id}`, { token: ana.token, raw: Buffer.from('acta'), fileType: 'text/plain' });
    expect(up.status).toBe(200);
    expect((await call(`/drive/tree?workspaceId=${wsId}`, { token: ana.token })).json.files).toHaveLength(1);
    expect((await call(`/drive/tree?workspaceId=${wsId}`, { token: beto.token })).status).toBe(404);
    // Una carpeta de un espacio no sirve como destino en «Mis archivos».
    expect((await call(`/drive/files/${up.json.id}`, { token: ana.token, method: 'PATCH', body: { folderId: randomUUID() } })).status).toBe(404);
  });
});
