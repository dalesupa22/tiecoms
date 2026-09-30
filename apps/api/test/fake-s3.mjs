// S3 falso para pruebas locales (PUT/GET/HEAD/DELETE con rutas estilo path, sin validar firmas).
//   node test/fake-s3.mjs 59000   y en el entorno del API: S3_ENDPOINT=http://localhost:59000
// También: subida multipart (lib-storage), GET con Range (el <video> del navegador pide rangos a la URL
// prefirmada) y los response-content-type / response-content-disposition de las URL prefirmadas.
// GET /__log devuelve las últimas peticiones (método, ruta, Range) para comprobar el streaming en las pruebas.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
const store = new Map();
const uploads = new Map();
const log = [];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      // El SDK sube con aws-chunked cuando calcula el checksum en streaming.
      if (String(req.headers['content-encoding'] ?? '').includes('aws-chunked')) {
        const out = []; let i = 0;
        while (i < body.length) {
          const eol = body.indexOf('\r\n', i); const size = parseInt(body.subarray(i, eol).toString().split(';')[0], 16);
          if (!size) break; out.push(body.subarray(eol + 2, eol + 2 + size)); i = eol + 2 + size + 2;
        }
        body = Buffer.concat(out);
      }
      resolve(body);
    });
  });
}
const xml = (res, status, body) => res.writeHead(status, { 'content-type': 'application/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);

createServer(async (req, res) => {
  const [path, qs = ''] = req.url.split('?');
  const key = decodeURIComponent(path);
  const q = new URLSearchParams(qs);
  if (key !== '/__log') log.push({ method: req.method, key, range: req.headers.range ?? null, multipart: q.has('uploadId') || q.has('uploads'), at: Date.now() });
  if (log.length > 500) log.shift();
  if (req.method === 'GET' && key === '/__log') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(log));
  // ---- Multipart ----
  if (req.method === 'POST' && q.has('uploads')) {
    await readBody(req);
    const id = randomUUID();
    uploads.set(id, { key, parts: new Map(), type: req.headers['content-type'] ?? 'application/octet-stream' });
    return xml(res, 200, `<InitiateMultipartUploadResult><Bucket>test</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }
  if (req.method === 'PUT' && q.has('uploadId')) {
    const u = uploads.get(q.get('uploadId'));
    const body = await readBody(req);
    if (!u) return xml(res, 404, '<Error><Code>NoSuchUpload</Code></Error>');
    const n = Number(q.get('partNumber'));
    u.parts.set(n, body);
    return res.writeHead(200, { etag: `"p${n}"` }).end();
  }
  if (req.method === 'POST' && q.has('uploadId')) {
    await readBody(req);
    const u = uploads.get(q.get('uploadId'));
    if (!u) return xml(res, 404, '<Error><Code>NoSuchUpload</Code></Error>');
    const body = Buffer.concat([...u.parts.entries()].sort((a, b) => a[0] - b[0]).map((p) => p[1]));
    store.set(u.key, { body, type: u.type });
    uploads.delete(q.get('uploadId'));
    return xml(res, 200, `<CompleteMultipartUploadResult><Bucket>test</Bucket><Key>${u.key}</Key><ETag>"x"</ETag></CompleteMultipartUploadResult>`);
  }
  if (req.method === 'DELETE' && q.has('uploadId')) { uploads.delete(q.get('uploadId')); return res.writeHead(204).end(); }
  // ---- Objetos ----
  if (req.method === 'PUT') {
    const body = await readBody(req);
    store.set(key, { body, type: req.headers['content-type'] ?? 'application/octet-stream' });
    return res.writeHead(200, { etag: '"x"' }).end();
  }
  if (req.method === 'GET' || (req.method === 'HEAD' && key !== '/__keys')) {
    const o = store.get(key);
    if (!o) return xml(res, 404, '<Error><Code>NoSuchKey</Code></Error>');
    const headers = { 'content-type': q.get('response-content-type') ?? o.type, 'accept-ranges': 'bytes' };
    if (q.get('response-content-disposition')) headers['content-disposition'] = q.get('response-content-disposition');
    const total = o.body.length;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      if (start >= total || start > end) return res.writeHead(416, { 'content-range': `bytes */${total}`, 'content-type': 'application/xml' }).end('<Error><Code>InvalidRange</Code></Error>');
      const part = o.body.subarray(start, end + 1);
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': part.length });
      return res.end(req.method === 'HEAD' ? undefined : part);
    }
    res.writeHead(200, { ...headers, 'content-length': total });
    return res.end(req.method === 'HEAD' ? undefined : o.body);
  }
  if (req.method === 'DELETE') { store.delete(key); return res.writeHead(204).end(); }
  if (req.method === 'HEAD' && key === '/__keys') return res.writeHead(200, { 'x-keys': [...store.keys()].join(',') }).end();
  res.writeHead(405).end();
}).listen(Number(process.argv[2] ?? 59000), () => console.log('fake-s3 listo'));
