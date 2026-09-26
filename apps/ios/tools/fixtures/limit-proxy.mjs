// Proxy de pruebas con el límite de cuerpo del nginx viejo (128 KB → 413 HTML). Solo localhost.
import http from 'node:http';
const target = new URL(process.env.TARGET ?? 'http://127.0.0.1:3050');
const limit = Number(process.env.LIMIT ?? 128 * 1024);
http.createServer((req, res) => {
  const len = Number(req.headers['content-length'] ?? 0);
  if (req.url.includes('/attachments') && len > limit) {
    res.writeHead(413, { 'content-type': 'text/html' });
    res.end('<html><head><title>413 Request Entity Too Large</title></head><body><center><h1>413 Request Entity Too Large</h1></center><hr><center>nginx</center></body></html>');
    req.resume(); return;
  }
  const p = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  p.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(p);
}).listen(Number(process.env.PORT ?? 3059), '127.0.0.1');
