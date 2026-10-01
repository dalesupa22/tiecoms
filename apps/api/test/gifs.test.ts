/**
 * GIFs y memes de punta a punta dentro del proceso (app.inject), con el proveedor simulado (setUpstreamForTests):
 * búsqueda y tendencias normalizadas, proxy de imágenes con hosts permitidos, límite por usuario y enviar como
 * adjunto de imagen en S3. Necesita DATABASE_URL (una base propia); S3 lo levanta con test/fake-s3.mjs.
 *   DATABASE_URL=postgres://… JWT_SECRET=… npx vitest run test/gifs.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = randomUUID().slice(0, 8);
const hasDb = !!process.env.DATABASE_URL;

// GIF animado de 2 cuadros, 3×2.
const GIF = Buffer.from('R0lGODlhAwACAPAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAwACAAACAoRRACH5BAAKAAAALAAAAAADAAIAAAIChFEAOw==', 'base64');
const HTML = Buffer.from('<html>no soy un gif</html>');

const KLIPY_SEARCH = {
  results: [
    { id: '1', title: 'Gato', media_formats: { tinygif: { url: 'https://static.klipy.com/t/1.gif', dims: [3, 2] }, gif: { url: 'https://static.klipy.com/g/1.gif', dims: [3, 2], size: GIF.length } } },
    { id: '2', title: 'Redirige', media_formats: { tinygif: { url: 'https://static.klipy.com/t/2.gif', dims: [3, 2] }, gif: { url: 'https://static.klipy.com/g/redirect.gif', dims: [3, 2] } } },
    { id: '3', title: 'HTML', media_formats: { tinygif: { url: 'https://static.klipy.com/t/3.gif', dims: [3, 2] }, gif: { url: 'https://static.klipy.com/g/html.gif', dims: [3, 2] } } },
  ],
  next: 'P2',
};
const OPENVERSE = {
  page_count: 1, results: [{ id: 'ov1', title: 'Cat fall', url: 'https://upload.wikimedia.org/wikipedia/commons/7/78/Cat_fall.gif', creator: 'Eyytee', license: 'by-sa', license_version: '3.0', width: 3, height: 2 }],
};
const IMGFLIP = { success: true, data: { memes: [{ id: '181913649', name: 'Drake Hotline Bling', url: 'https://i.imgflip.com/30b1gx.jpg', width: 1200, height: 1200, box_count: 2 }] } };

describe.skipIf(!hasDb)('GIFs y memes (API)', () => {
  let app: any, gifs: typeof import('../src/modules/gifs.ts'), s3: ChildProcess | null = null;
  const calls: string[] = [];
  let token = '', convId = '', other = '';

  const req = async (method: string, url: string, opts: { token?: string; body?: unknown; ip?: string } = {}) => {
    const r = await app.inject({
      method, url, payload: opts.body as any,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), 'x-forwarded-for': opts.ip ?? '10.1.2.3' },
    });
    let json: any = {};
    try { json = r.json(); } catch {}
    return { status: r.statusCode, json, body: r.rawPayload as Buffer, headers: r.headers };
  };
  const signup = async (name: string) => {
    const r = await req('POST', '/api/v1/auth/signup', {
      ip: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      body: { name, email: `${name.toLowerCase()}.gif.${run}@example.com`, password: 'clave-segura-123', orgName: `${name} SAS ${run}`, device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' } },
    });
    expect(r.status).toBe(200);
    return r.json.accessToken as string;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'x'.repeat(40);
    process.env.MIGRATE_ON_START = 'false';
    if (!process.env.S3_ENDPOINT) {
      const port = 59000 + Math.floor(Math.random() * 900);
      s3 = spawn(process.execPath, [fileURLToPath(new URL('./fake-s3.mjs', import.meta.url)), String(port)], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 400));
      Object.assign(process.env, { S3_ENDPOINT: `http://127.0.0.1:${port}`, S3_BUCKET: 'gifs-test', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y' });
    }
    process.env.KLIPY_API_KEY = 'CLAVE-SECRETA-KLIPY';
    const { migrate } = await import('../src/migrate.ts');
    await migrate();
    gifs = await import('../src/modules/gifs.ts');
    gifs.setUpstreamForTests(async (url, _accept, max, isAllowed) => {
      calls.push(url);
      if (!isAllowed(url)) throw new Error('bloqueado');
      const u = new URL(url);
      if (u.hostname === 'api.klipy.com') return { status: 200, type: 'application/json', body: Buffer.from(JSON.stringify(KLIPY_SEARCH)) };
      if (u.hostname === 'api.openverse.org') return { status: 200, type: 'application/json', body: Buffer.from(JSON.stringify(OPENVERSE)) };
      if (u.hostname === 'api.imgflip.com') return { status: 200, type: 'application/json', body: Buffer.from(JSON.stringify(IMGFLIP)) };
      if (u.pathname.endsWith('html.gif')) return { status: 200, type: 'text/html', body: HTML };
      if (u.pathname.endsWith('redirect.gif')) {
        // Una redirección a un host ajeno la corta fetchAllowed (se prueba abajo); aquí la simula como bloqueo.
        return gifs.fetchAllowed(async () => ({ status: 302, type: '', body: Buffer.alloc(0), location: 'http://169.254.169.254/latest/meta-data' }), url, 'image/*', max, isAllowed);
      }
      return { status: 200, type: 'image/gif', body: GIF };
    });
    const { buildHttp } = await import('../src/http.ts');
    app = await buildHttp();
    token = await signup('Gabo');
    const ws = await req('POST', '/api/v1/workspaces', { token, body: { name: `GIFs ${run}` } });
    convId = ws.json.generalConversationId;
    const ws2 = await req('POST', '/api/v1/workspaces', { token: await signup('Otra'), body: { name: `Ajeno ${run}` } });
    other = ws2.json.generalConversationId;
  });
  afterAll(async () => {
    gifs?.setUpstreamForTests(null);
    await app?.close();
    s3?.kill();
    const { pool } = await import('../src/db.ts');
    await pool.end().catch(() => {});
  });

  it('pide sesión', async () => {
    expect((await req('GET', '/api/v1/gifs/trending')).status).toBe(401);
  });

  it('tendencias y búsqueda normalizadas, con URLs de nuestro dominio y sin la clave', async () => {
    gifs.clearGifCachesForTests();
    const tr = await req('GET', '/api/v1/gifs/trending?lang=es', { token });
    expect(tr.status).toBe(200);
    expect(tr.json.provider).toBe('klipy');
    expect(tr.json.poweredBy).toEqual({ label: 'Powered by KLIPY', url: 'https://klipy.com' });
    expect(tr.json.items).toHaveLength(3);
    const text = JSON.stringify(tr.json);
    expect(text).not.toContain('CLAVE-SECRETA-KLIPY');
    expect(text).not.toContain('static.klipy.com');
    for (const i of tr.json.items) {
      expect(Object.keys(i)).toEqual(expect.arrayContaining(['id', 'provider', 'title', 'previewUrl', 'url', 'width', 'height']));
      expect(i.previewUrl).toMatch(/^\/api\/v1\/gifs\/media\?t=[\w-]+$/);
    }
    expect(calls.at(-1)).toContain('/v2/featured');
    expect(new URL(calls.at(-1)!).searchParams.get('contentfilter')).toBe('medium');

    const s = await req('GET', '/api/v1/gifs/search?q=Gato&lang=en&cursor=P2', { token });
    expect(s.status).toBe(200);
    expect(s.json.next).toBe('P2');
    const sent = new URL(calls.at(-1)!);
    expect(sent.searchParams.get('q')).toBe('gato');
    expect(sent.searchParams.get('pos')).toBe('P2');
    expect(sent.searchParams.get('locale')).toBe('en_US');
    // La misma búsqueda sale de la caché.
    const before = calls.length;
    expect((await req('GET', '/api/v1/gifs/search?q=gato&lang=en&cursor=P2', { token })).status).toBe(200);
    expect(calls.length).toBe(before);
    expect((await req('GET', '/api/v1/gifs/search?q=', { token })).status).toBe(400);
  });

  it('sin clave usa Openverse; las plantillas vienen de Imgflip', async () => {
    delete process.env.KLIPY_API_KEY;
    try {
      const s = await req('GET', '/api/v1/gifs/search?q=gato', { token });
      expect(s.status).toBe(200);
      expect(s.json.provider).toBe('openverse');
      expect(s.json.items[0].attribution).toBe('GIF: «Cat fall» · Eyytee · CC BY-SA 3.0 · Wikimedia Commons (vía Openverse)');
      expect(new URL(calls.at(-1)!).searchParams.get('mature')).toBe('false');
    } finally { process.env.KLIPY_API_KEY = 'CLAVE-SECRETA-KLIPY'; }
    const m = await req('GET', '/api/v1/memes/templates', { token });
    expect(m.status).toBe(200);
    expect(m.json.provider).toBe('imgflip');
    expect(m.json.items[0]).toMatchObject({ title: 'Drake Hotline Bling', boxCount: 2 });
  });

  it('el proxy sirve la imagen y rechaza tokens falsos, hosts ajenos y lo que no es imagen', async () => {
    const tr = await req('GET', '/api/v1/gifs/trending', { token });
    const ok = await req('GET', tr.json.items[0].previewUrl);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/gif');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(ok.body, GIF)).toBe(0);
    // Token alterado o inventado.
    const tok = tr.json.items[0].previewUrl.split('?t=').pop() as string;
    const flipped = tok.slice(0, -2) + (tok.at(-2) === 'A' ? 'B' : 'A') + tok.at(-1);
    expect((await req('GET', `/api/v1/gifs/media?t=${flipped}`)).status).toBe(404);
    expect((await req('GET', `/api/v1/gifs/media?t=${Buffer.from(JSON.stringify({ u: 'https://evil.example/a.gif', p: 'klipy', k: 'p' })).toString('base64url')}`)).status).toBe(404);
    // Token auténtico pero hacia un host que no es del proveedor (o una IP de metadatos): no se pide nada.
    const n = calls.length;
    const evil = gifs.sealMedia({ u: 'https://169.254.169.254/latest/meta-data', p: 'klipy', k: 'p' });
    expect((await req('GET', `/api/v1/gifs/media?t=${evil}`)).status).toBe(404);
    const evil2 = gifs.sealMedia({ u: 'https://evil.example/x.gif', p: 'openverse', k: 'f' });
    expect((await req('GET', `/api/v1/gifs/media?t=${evil2}`)).status).toBe(404);
    expect(calls.length).toBe(n);
    // Redirección a un host ajeno: cortada.
    const redirect = await req('GET', tr.json.items[1].url);
    expect(redirect.status).toBe(502);
    expect(redirect.json.error.code).toBe('gifs_blocked');
    // HTML disfrazado de GIF.
    expect((await req('GET', tr.json.items[2].url)).status).toBe(415);
  });

  it('fetchAllowed valida cada salto y el tamaño', async () => {
    const allowed = (u: string) => new URL(u).hostname === 'static.klipy.com';
    const hop = async (t: URL) => (t.pathname === '/a' ? { status: 301, type: '', body: Buffer.alloc(0), location: '/b' } : { status: 200, type: 'image/gif', body: GIF });
    expect((await gifs.fetchAllowed(hop, 'https://static.klipy.com/a', 'image/*', 1000, allowed)).body.length).toBe(GIF.length);
    await expect(gifs.fetchAllowed(hop, 'https://static.klipy.com/a', 'image/*', 10, allowed)).rejects.toMatchObject({ status: 413 });
    await expect(gifs.fetchAllowed(async () => ({ status: 302, type: '', body: Buffer.alloc(0), location: 'https://10.0.0.5/x' }), 'https://static.klipy.com/a', 'image/*', 1000, allowed))
      .rejects.toMatchObject({ code: 'gifs_blocked' });
    await expect(gifs.fetchAllowed(hop, 'https://127.0.0.1/a', 'image/*', 1000, allowed)).rejects.toMatchObject({ code: 'gifs_blocked' });
  });

  it('enviar crea un adjunto de imagen normal y devuelve la atribución', async () => {
    const tr = await req('GET', '/api/v1/gifs/trending', { token });
    const gif = tr.json.items[0];
    const r = await req('POST', `/api/v1/conversations/${convId}/gifs`, { token, body: { url: gif.url } });
    expect(r.status).toBe(200);
    expect(r.json.attribution).toBe('GIF vía KLIPY');
    expect(r.json.attachment).toMatchObject({ contentType: 'image/gif', width: 3, height: 2, sizeBytes: GIF.length, name: 'gato.gif' });
    const att = r.json.attachment;
    // Se usa en un mensaje como cualquier foto.
    const m = await req('POST', `/api/v1/conversations/${convId}/messages`, { token, body: { clientMessageId: randomUUID(), body: r.json.attribution, attachmentIds: [att.id] } });
    expect(m.status).toBe(201);
    const msg = m.json.message ?? m.json;
    expect(msg.body).toBe('GIF vía KLIPY');
    expect(msg.attachments?.[0]).toMatchObject({ id: att.id, contentType: 'image/gif' });
    // Y se sirve desde S3 (no del proveedor).
    const n = calls.length;
    const file = await req('GET', att.url, { token });
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body, GIF)).toBe(0);
    expect(calls.length).toBe(n);
  });

  it('enviar exige un GIF válido y permiso en el chat', async () => {
    const tr = await req('GET', '/api/v1/gifs/trending', { token });
    expect((await req('POST', `/api/v1/conversations/${convId}/gifs`, { token, body: { url: tr.json.items[0].previewUrl } })).status).toBe(400); // vista previa, no el archivo
    expect((await req('POST', `/api/v1/conversations/${convId}/gifs`, { token, body: { url: 'https://evil.example/a.gif' } })).status).toBe(400);
    const tpl = await req('GET', '/api/v1/memes/templates', { token });
    expect((await req('POST', `/api/v1/conversations/${convId}/gifs`, { token, body: { url: tpl.json.items[0].url } })).status).toBe(400); // plantillas: se editan en el cliente
    const n = calls.length;
    const denied = await req('POST', `/api/v1/conversations/${other}/gifs`, { token, body: { url: tr.json.items[0].url } });
    expect([403, 404]).toContain(denied.status);
    expect(calls.length).toBe(n);
  });

  it('límite de peticiones por usuario', async () => {
    const t2 = await signup('Rafaga');
    let limited = 0;
    for (let i = 0; i < gifs.SEARCH_LIMIT.max + 3; i++) {
      // IPs distintas: el límite es por usuario, no por IP.
      const r = await req('GET', `/api/v1/gifs/search?q=rafaga${i % 3}`, { token: t2, ip: `10.7.0.${i + 1}` });
      if (r.status === 429) limited++;
    }
    expect(limited).toBe(3);
    // Otro usuario no se ve afectado.
    expect((await req('GET', '/api/v1/gifs/search?q=rafaga0', { token })).status).toBe(200);
  });
});
