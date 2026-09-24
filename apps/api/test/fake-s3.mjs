// S3 falso para pruebas locales (PUT/GET/DELETE con rutas estilo path, sin validar firmas).
//   node test/fake-s3.mjs 59000   y en el entorno del API: S3_ENDPOINT=http://localhost:59000
import { createServer } from 'node:http';
const store = new Map();
createServer((req, res) => {
  const key = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'PUT') {
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
      store.set(key, { body, type: req.headers['content-type'] ?? 'application/octet-stream' });
      res.writeHead(200, { etag: '"x"' }).end();
    });
  } else if (req.method === 'GET') {
    const o = store.get(key);
    if (!o) return res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
    res.writeHead(200, { 'content-type': o.type, 'content-length': o.body.length }).end(o.body);
  } else if (req.method === 'DELETE') { store.delete(key); res.writeHead(204).end(); }
  else if (req.method === 'HEAD' && key === '/__keys') res.writeHead(200, { 'x-keys': [...store.keys()].join(',') }).end();
  else res.writeHead(405).end();
}).listen(Number(process.argv[2] ?? 59000), () => console.log('fake-s3 listo'));
