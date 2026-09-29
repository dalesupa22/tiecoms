// Proxy de pruebas que agrega la latencia de red de Colombia (~100 ms por viaje) delante del API local.
//   TARGET=http://127.0.0.1:3141 PORT=3143 DELAY_MS=100 node apps/ios/tools/fixtures/latency-proxy.mjs
// HTTP: espera DELAY_MS antes de reenviar. WebSocket (socket.io): pasa directo tras la misma espera. Solo localhost.
import http from 'node:http';
import net from 'node:net';
const target = new URL(process.env.TARGET ?? 'http://127.0.0.1:3141');
const delay = Number(process.env.DELAY_MS ?? 100);
const wait = () => new Promise((r) => setTimeout(r, delay));
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  await wait();
  const p = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  p.on('error', () => { res.writeHead(502); res.end(); });
  p.end(Buffer.concat(chunks));
});
server.on('upgrade', async (req, socket, head) => {
  await wait();
  const up = net.connect(Number(target.port), target.hostname, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries({ ...req.headers, host: target.host }).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
});
server.listen(Number(process.env.PORT ?? 3143), '127.0.0.1');
