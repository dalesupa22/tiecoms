// PROVEEDOR FALSO (MOCK) de Gmail y Outlook (Graph) para probar el correo en el chat (docs/CORREO.md).
// No habla con Google ni con Microsoft: probar con esto NO demuestra que OAuth o los permisos reales funcionen.
//   node test/fake-mail.mjs 59397
// En el entorno del API (además de GOOGLE_/MICROSOFT_CLIENT_ID y _SECRET de mentira y MAIL_ENABLED=true):
//   MAIL_GOOGLE_AUTH=http://localhost:59397/google/auth MAIL_GOOGLE_TOKEN=http://localhost:59397/google/token MAIL_GOOGLE_API=http://localhost:59397/gmail
//   MAIL_GOOGLE_REVOKE=http://localhost:59397/google/revoke MAIL_GOOGLE_BATCH=http://localhost:59397/batch/gmail/v1
//   MAIL_MS_AUTH=http://localhost:59397/ms/auth MAIL_MS_TOKEN=http://localhost:59397/ms/token MAIL_MS_API=http://localhost:59397/graph
//   DEEPSEEK_URL=http://localhost:59397/llm DEEPSEEK_API_KEY=fake
// GET /sent lista lo que se «envió» (para comprobar destinatarios, asunto y adjuntos). GET /stats cuenta peticiones por ruta.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.argv[2] ?? 59397);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (email) => `${b64({ alg: 'none' })}.${b64({ email })}.`;
const sent = [];
const stats = { batch: 0, gmailGet: 0, gmailList: 0, graphGet: 0, graphAttachments: 0 };
const day = 86_400_000;
const now = Date.now();

// Buzón de muestra: correos de hoy, de hace semanas y de hace más de un año (para probar filtros de fecha).
const MAILS = [
  { id: 'g1', thread: 't1', from: 'Jorge Ramírez <jorge.ramirez@uniandes.edu.co>', to: 'Danny Suárez <mock.google@example.com>', cc: 'Óscar Zambrano <oscar@uniandes.edu.co>',
    subject: 'Solicitud de presentación para el comité del jueves', at: now - 2 * 3600_000, labels: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
    text: 'Buenos días, Danny.\n\nPara el comité de la Facultad de Administración del jueves necesitamos una presentación corta de la plataforma, con precios por volumen y el cronograma.\n\nQuedo atento, Jorge.',
    files: [{ id: 'a1', name: 'Requisitos_comite.pdf', type: 'application/pdf', data: '%PDF-1.4 fake' }, { id: 'a2', name: 'Formato_precios.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: 'xlsx' }] },
  { id: 'g2', thread: 't2', from: 'Banco Ejemplo <avisos@banco.example>', to: 'mock.google@example.com', subject: 'Recibiste un pago de $4.200.000', at: now - 5 * 3600_000,
    labels: ['INBOX', 'CATEGORY_UPDATES'], html: '<p>Hola,</p><p>Recibiste un <b>pago</b> de Uniandes por $4.200.000 &amp; ya está en tu cuenta.</p>' },
  { id: 'g3', thread: 't3', from: 'Tienda <ofertas@tienda.example>', to: 'mock.google@example.com', subject: '50% en todo', at: now - 8 * 3600_000, labels: ['INBOX', 'CATEGORY_PROMOTIONS'], text: 'Promo' },
  { id: 'g4', thread: 't4', from: 'Danny Suárez <mock.google@example.com>', to: 'Ana María Forero <ana@uniandes.edu.co>', subject: 'Propuesta credenciales', at: now - 20 * day, labels: ['SENT'], text: 'Te envío la propuesta.' },
  { id: 'g6', thread: 't6', from: 'Ana María Forero <ana@uniandes.edu.co>', to: 'mock.google@example.com', subject: 'RE: Recarga de créditos', at: now - 30 * 3600_000, labels: ['INBOX', 'CATEGORY_PERSONAL'],
    text: 'Confirmo que ya aparecen en la cuenta de la facultad.\n\n-- \nAna María Forero\nCoordinadora\n\nEl mar, 8 jul 2025 a las 10:53, Lorena Tapias escribió:\n> Hola Ana,\n> ya repusimos los 209 créditos.' },
  { id: 'g5', thread: 't5', from: 'Jorge Ramírez <jorge.ramirez@uniandes.edu.co>', to: 'mock.google@example.com', subject: 'Presentación piloto 2025', at: now - 400 * day, labels: ['INBOX', 'CATEGORY_PERSONAL'], text: 'La presentación del piloto quedó muy bien.' },
];

async function body(req) {
  let d = ''; for await (const c of req) d += c;
  if ((req.headers['content-type'] ?? '').includes('json')) { try { return JSON.parse(d || '{}'); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(d));
}
const send = (res, status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
const bu = (s) => Buffer.from(s, 'utf8').toString('base64url');
const hdr = (m) => [['From', m.from], ['To', m.to], ...(m.cc ? [['Cc', m.cc]] : []), ['Subject', m.subject], ['Date', new Date(m.at).toUTCString()], ['Message-ID', `<${m.id}@mock>`]].map(([name, value]) => ({ name, value }));
function gmailMsg(m, full) {
  const payload = { mimeType: m.files ? 'multipart/mixed' : m.html ? 'text/html' : 'text/plain', headers: hdr(m) };
  if (full) {
    payload.parts = [m.html ? { mimeType: 'text/html', body: { data: bu(m.html) } } : { mimeType: 'text/plain', body: { data: bu(m.text ?? '') } },
      ...(m.files ?? []).map((f) => ({ mimeType: f.type, filename: f.name, body: { attachmentId: f.id, size: f.data.length } }))];
  }
  return { id: m.id, threadId: m.thread, labelIds: m.labels, snippet: (m.text ?? m.html ?? '').slice(0, 80), internalDate: String(m.at), payload };
}
/** Subconjunto de la sintaxis de Gmail: in:, category:, from:, to:, after:, before:, has:attachment, is:unread y palabras. */
function gmailMatch(m, q) {
  for (const tok of q.match(/"[^"]*"|\S+/g) ?? []) {
    const [k, ...rest] = tok.split(':'); const v = rest.join(':').replace(/"/g, '').toLowerCase();
    if (!rest.length) { const w = tok.replace(/"/g, '').toLowerCase(); if (![m.subject, m.text, m.html, m.from].join(' ').toLowerCase().includes(w)) return false; continue; }
    if (k === 'in' && v === 'inbox' && !m.labels.includes('INBOX')) return false;
    if (k === 'in' && v === 'sent' && !m.labels.includes('SENT')) return false;
    if (k === 'category' && !m.labels.includes(`CATEGORY_${v === 'primary' ? 'PERSONAL' : v.toUpperCase()}`)) return false;
    if (k === 'from' && !m.from.toLowerCase().includes(v)) return false;
    if (k === 'to' && !m.to.toLowerCase().includes(v)) return false;
    if (k === 'after' && m.at < Date.parse(v.replace(/\//g, '-'))) return false;
    if (k === 'before' && m.at >= Date.parse(v.replace(/\//g, '-'))) return false;
    if (k === 'has' && v === 'attachment' && !m.files) return false;
    if (k === 'is' && v === 'unread' && !m.labels.includes('UNREAD')) return false;
  }
  return true;
}
const graphMsg = (m) => ({
  id: `ms-${m.id}`, conversationId: m.thread, subject: m.subject, bodyPreview: (m.text ?? '').slice(0, 80),
  from: { emailAddress: { name: m.from.split(' <')[0], address: (m.from.match(/<([^>]+)>/)?.[1] ?? m.from) } },
  toRecipients: [{ emailAddress: { address: m.to.match(/<([^>]+)>/)?.[1] ?? m.to } }], receivedDateTime: new Date(m.at).toISOString(),
  isRead: !m.labels.includes('UNREAD'), hasAttachments: !!m.files, inferenceClassification: m.labels.includes('CATEGORY_PERSONAL') ? 'focused' : 'other',
  internetMessageId: `<${m.id}@mock>`,
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${port}`);
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.pathname === '/sent') return send(res, 200, sent);
  if (u.pathname === '/stats') return send(res, 200, stats);
  // Lote de Gmail: multipart/mixed con «GET /gmail/v1/users/me/messages/<id>?…» por parte.
  if (u.pathname === '/batch/gmail/v1' && req.method === 'POST') {
    if (!(req.headers.authorization ?? '').startsWith('Bearer at-')) return send(res, 401, {});
    stats.batch++;
    let d = ''; for await (const c of req) d += c;
    const rb = 'batch_resp';
    const out = [...d.matchAll(/Content-ID: <([^>]+)>\r\n\r\nGET (\S+)/g)].map(([, cid, path]) => {
      const id = decodeURIComponent(path.split('?')[0].split('/').pop());
      const m = MAILS.find((x) => x.id === id);
      const json = m ? gmailMsg(m, false) : { error: { code: 404 } };
      return `--${rb}\r\nContent-Type: application/http\r\nContent-ID: <response-${cid}>\r\n\r\nHTTP/1.1 ${m ? '200 OK' : '404 Not Found'}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(json)}\r\n`;
    }).join('') + `--${rb}--`;
    res.writeHead(200, { 'content-type': `multipart/mixed; boundary=${rb}` }); return res.end(out);
  }
  if (parts[1] === 'auth') {
    const to = new URL(u.searchParams.get('redirect_uri'));
    to.searchParams.set('state', u.searchParams.get('state') ?? '');
    to.searchParams.set('code', `code-${parts[0]}-${randomUUID()}`);
    res.writeHead(302, { location: to.toString() }); return res.end();
  }
  if (parts[1] === 'token') return send(res, 200, { access_token: `at-${parts[0]}-${randomUUID()}`, refresh_token: `rt-${randomUUID()}`, expires_in: 3600, scope: 'mock', id_token: idToken(`mock.${parts[0]}@example.com`) });
  if (parts[1] === 'revoke') return send(res, 200, {});
  if (parts[0] === 'llm') return send(res, 200, { choices: [{ message: { content: 'Hola, Jorge. Te adjunto la presentación con los precios por volumen.\n\nSaludos, Danny' } }] });
  if (!(req.headers.authorization ?? '').startsWith('Bearer at-')) return send(res, 401, { error: { code: 'unauthorized' } });
  // Gmail: /gmail/users/me/messages[/id[/attachments/aid]] y /gmail/users/me/messages/send
  if (parts[0] === 'gmail') {
    const [, , , , id, sub, aid] = parts;
    if (id === 'send' && req.method === 'POST') {
      const b = await body(req);
      const raw = Buffer.from(b.raw, 'base64url').toString('utf8');
      sent.push({ provider: 'google', threadId: b.threadId ?? null, to: raw.match(/^To: (.*)$/m)?.[1], cc: raw.match(/^Cc: (.*)$/m)?.[1] ?? null, subject: raw.match(/^Subject: (.*)$/m)?.[1],
        inReplyTo: raw.match(/^In-Reply-To: (.*)$/m)?.[1] ?? null, attachments: [...raw.matchAll(/filename="([^"]+)"/g)].map((x) => x[1]) });
      return send(res, 200, { id: `sent-${sent.length}` });
    }
    if (!id) {
      stats.gmailList++;
      const q = u.searchParams.get('q') ?? '';
      const list = MAILS.filter((m) => gmailMatch(m, q)).sort((a, b) => b.at - a.at);
      return send(res, 200, { messages: list.map((m) => ({ id: m.id, threadId: m.thread })), resultSizeEstimate: list.length });
    }
    const m = MAILS.find((x) => x.id === id);
    if (!m) return send(res, 404, { error: { code: 404 } });
    if (sub === 'attachments') { const f = m.files?.find((x) => x.id === aid); return f ? send(res, 200, { data: bu(f.data), size: f.data.length }) : send(res, 404, {}); }
    stats.gmailGet++;
    return send(res, 200, gmailMsg(m, u.searchParams.get('format') === 'full'));
  }
  // Graph: /graph/me/(mailFolders/x/)messages[/id[/attachments[/aid/$value]]|/reply]
  if (parts[0] === 'graph') {
    const i = parts.indexOf('messages');
    const id = parts[i + 1]; const sub = parts[i + 2]; const aid = parts[i + 3];
    if (!id) {
      const folder = parts.includes('sentitems') ? 'SENT' : parts.includes('inbox') ? 'INBOX' : null;
      let list = MAILS.filter((m) => !folder || m.labels.includes(folder));
      const s = (u.searchParams.get('$search') ?? '').replace(/^"|"$/g, '').toLowerCase();
      for (const w of s.split(' and ').filter((x) => x && !x.includes(':') && !x.includes('>') && !x.includes('<'))) list = list.filter((m) => [m.subject, m.text].join(' ').toLowerCase().includes(w));
      const f = u.searchParams.get('$filter') ?? '';
      if (f.includes("'focused'")) list = list.filter((m) => graphMsg(m).inferenceClassification === 'focused');
      if (f.includes("'other'")) list = list.filter((m) => graphMsg(m).inferenceClassification === 'other');
      return send(res, 200, { value: list.sort((a, b) => b.at - a.at).map(graphMsg) });
    }
    const m = MAILS.find((x) => `ms-${x.id}` === id);
    if (!m) return send(res, 404, { error: { code: 'ErrorItemNotFound' } });
    if (sub === 'reply' && req.method === 'POST') {
      const b = await body(req);
      sent.push({ provider: 'microsoft', id, to: b.message.toRecipients.map((r) => r.emailAddress.address).join(', '), cc: b.message.ccRecipients.map((r) => r.emailAddress.address).join(', ') || null, comment: b.comment, attachments: b.message.attachments.map((a) => a.name) });
      res.writeHead(202); return res.end();
    }
    if (sub === 'attachments' && aid) { const f = m.files?.find((x) => x.id === aid); if (!f) return send(res, 404, {}); res.writeHead(200, { 'content-type': f.type }); return res.end(f.data); }
    if (sub === 'attachments') stats.graphAttachments++;
    if (sub === 'attachments') return send(res, 200, { value: (m.files ?? []).map((f) => ({ id: f.id, name: f.name, size: f.data.length, contentType: f.type, isInline: false, '@odata.type': '#microsoft.graph.fileAttachment' })) });
    stats.graphGet++;
    const exp = (u.searchParams.get('$expand') ?? '').startsWith('attachments');
    return send(res, 200, { ...graphMsg(m), ccRecipients: [], body: { contentType: 'text', content: m.text ?? m.html },
      ...(exp ? { attachments: (m.files ?? []).map((f) => ({ id: f.id, name: f.name, size: f.data.length, contentType: f.type, isInline: false, '@odata.type': '#microsoft.graph.fileAttachment' })) } : {}) });
  }
  send(res, 404, {});
}).listen(port, () => console.log(`fake-mail en http://localhost:${port}`));
