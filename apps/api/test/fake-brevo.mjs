// Brevo falso para pruebas locales: guarda cada correo y los devuelve en GET /sent.
//   node test/fake-brevo.mjs 59100   y en el entorno del API:
//   BREVO_API_KEY=xkeysib-falsa BREVO_API_URL=http://localhost:59100/v3/smtp/email
// Un destinatario que empiece por "rebota" responde 400 (para probar fallos).
import { createServer } from 'node:http';
const sent = [];
createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/sent') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sent));
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const body = JSON.parse(data || '{}');
    if (body.to?.some((t) => t.email.startsWith('rebota'))) {
      return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'invalid_parameter', message: 'email is not valid' }));
    }
    sent.push({ ...body, apiKey: req.headers['api-key'], at: Date.now() });
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ messageId: `<${sent.length}@fake-brevo>` }));
  });
}).listen(Number(process.argv[2] ?? 59100), () => console.log('fake-brevo listo'));
