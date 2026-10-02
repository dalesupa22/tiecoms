/**
 * Enlaces para ver un archivo sin cuenta (file-links.ts): se usan al llevar un adjunto a WhatsApp.
 * Necesita el API (API_URL) con S3 (en local, test/fake-s3.mjs).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }

async function call(path: string, opts: { method?: string; token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'), redirect: 'manual',
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : opts.raw ? { 'content-type': 'application/octet-stream' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : opts.raw,
  });
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.fl.${run}@example.com`, password: 'clave-segura-123', orgName: `${name} SAS ${run}`,
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

describe('enlaces para ver un archivo', () => {
  let ana: Actor, extra: Actor, generalId: string, pdfId: string, htmlId: string, messageId: string;
  beforeAll(async () => {
    ana = await signup('Ana');
    extra = await signup('Extra');
    const ws = await call('/workspaces', { token: ana.token, body: { name: `Enlaces ${run}` } });
    generalId = ws.json.generalConversationId;
    const up = (body: Buffer, name: string, type: string) => call(`/conversations/${generalId}/attachments`, { token: ana.token, raw: body, headers: { 'x-file-name': encodeURIComponent(name), 'x-file-type': type } });
    pdfId = (await up(PDF, 'Comprobante pago.pdf', 'application/pdf')).json.id;
    htmlId = (await up(HTML, 'pagina.html', 'text/html')).json.id;
    const m = await call(`/conversations/${generalId}/messages`, { token: ana.token, body: { clientMessageId: randomUUID(), body: 'el comprobante', attachmentIds: [pdfId, htmlId] } });
    expect(m.status).toBe(201);
    messageId = m.json.message?.id ?? m.json.id;
  });

  it('quien ve el archivo crea el enlace; quien no, no', async () => {
    expect((await call(`/attachments/${pdfId}/link`, { token: extra.token, body: {} })).status).toBe(404);
    expect((await call(`/attachments/${pdfId}/link`, { body: {} })).status).toBe(401);
    const r = await call(`/attachments/${pdfId}/link`, { token: ana.token, body: {} });
    expect(r.status).toBe(200);
    expect(r.json.url).toMatch(/\/archivo\/[A-Za-z0-9_-]{20,}$/);
    expect(r.json.name).toBe('Comprobante pago.pdf');
    expect(new Date(r.json.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86400_000);
  });

  it('sin cuenta: ve el nombre y abre el archivo en el navegador', async () => {
    const token = (await call(`/attachments/${pdfId}/link`, { token: ana.token, body: {} })).json.url.split('/archivo/')[1];
    const p = await call(`/file-links/${token}`);
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ name: 'Comprobante pago.pdf', contentType: 'application/pdf', viewable: true, sharedBy: 'Ana' });
    const f = await call(`/file-links/${token}/file`);
    expect(f.status).toBe(302);
    const loc = decodeURIComponent(f.headers.get('location') ?? '');
    expect(loc).toContain('response-content-disposition=inline');
    expect((await call(`/file-links/${token}/file?download=1`)).headers.get('location')).toContain('attachment');
  });

  it('lo que no es seguro de ver (HTML) siempre se descarga', async () => {
    const token = (await call(`/attachments/${htmlId}/link`, { token: ana.token, body: {} })).json.url.split('/archivo/')[1];
    expect((await call(`/file-links/${token}`)).json.viewable).toBe(false);
    const loc = decodeURIComponent((await call(`/file-links/${token}/file`)).headers.get('location') ?? '');
    expect(loc).toContain('response-content-disposition=attachment');
    expect(loc).toContain('response-content-type=application/octet-stream');
  });

  it('quien lo creó lo desactiva y deja de abrir; nadie más puede', async () => {
    const token = (await call(`/attachments/${pdfId}/link`, { token: ana.token, body: {} })).json.url.split('/archivo/')[1];
    expect((await call(`/file-links/${token}`, { method: 'DELETE', token: extra.token })).status).toBe(404);
    expect((await call(`/file-links/${token}`, { method: 'DELETE', token: ana.token })).status).toBe(200);
    expect((await call(`/file-links/${token}`)).status).toBe(404);
    expect((await call(`/file-links/${token}/file`)).status).toBe(404);
  });

  it('un token inventado o el de un mensaje borrado no sirven', async () => {
    expect((await call('/file-links/no-existe-este-token-aaaa')).status).toBe(404);
    expect((await call('/file-links/x')).status).toBe(404);
    const token = (await call(`/attachments/${pdfId}/link`, { token: ana.token, body: {} })).json.url.split('/archivo/')[1];
    expect((await call(`/messages/${messageId}`, { method: 'DELETE', token: ana.token })).status).toBeLessThan(300);
    expect((await call(`/file-links/${token}`)).status).toBe(404);
    expect((await call(`/file-links/${token}/file`)).status).toBe(404);
  });
});

describe('eliminar lo que se trajo arrastrando (correo o WhatsApp), para todos', () => {
  let ana: Actor, beto: Actor, generalId: string;
  afterAll(async () => { await pool.end(); });
  beforeAll(async () => {
    ana = await signup('Ana2');
    const ws = await call('/workspaces', { token: ana.token, body: { name: `Borrar ${run}` } });
    generalId = ws.json.generalConversationId;
    beto = await signup('Beto2');
    const inv = await call(`/workspaces/${ws.json.id}/invitations`, { token: ana.token, body: { role: 'member', conversationIds: [generalId] } });
    await call(`/invitations/${inv.json.token}/accept`, { token: beto.token, body: {} });
  });
  /** Una tarjeta como la que deja /mail/share: mensaje de sistema «mail.shared» de quien la trajo y su fila en shared_emails. */
  async function sharedCard(by: Actor, k: 'mail.shared' | 'wa.shared') {
    const m = await call(`/conversations/${generalId}/messages`, { token: by.token, body: { clientMessageId: randomUUID(), body: 'tarjeta' } });
    const id = m.json.message?.id ?? m.json.id;
    const e = await pool.query(`INSERT INTO shared_emails (conversation_id, shared_by, provider, external_id, direction, subject, message_id) VALUES ($1,$2,$3,'x','in','Cobro',$4) RETURNING id`, [generalId, by.id, k === 'wa.shared' ? 'whatsapp' : 'google', id]);
    await pool.query("UPDATE messages SET kind = 'system', body = $2 WHERE id = $1", [id, JSON.stringify({ k, emailId: e.rows[0].id, text: '' })]);
    return { id, emailId: e.rows[0].id as string };
  }
  it('quien lo trajo lo borra: desaparece la tarjeta y queda «eliminado» para todos', async () => {
    for (const k of ['mail.shared', 'wa.shared'] as const) {
      const card = await sharedCard(ana, k);
      expect((await call(`/messages/${card.id}`, { method: 'PATCH', token: ana.token, body: { body: 'editado' } })).status).toBe(403);
      expect((await call(`/messages/${card.id}`, { method: 'DELETE', token: beto.token })).status).toBe(403);
      const r = await call(`/messages/${card.id}`, { method: 'DELETE', token: ana.token });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ kind: 'text', body: '' });
      expect(r.json.deletedAt).toBeTruthy();
      expect((await pool.query('SELECT 1 FROM shared_emails WHERE id = $1', [card.emailId])).rowCount).toBe(0);
      expect((await call(`/mail/shared/${card.emailId}`, { token: beto.token })).status).toBe(404);
    }
  });
  it('otros mensajes de sistema siguen sin poderse borrar', async () => {
    const { rows } = await pool.query("SELECT id FROM messages WHERE conversation_id = $1 AND kind = 'system' LIMIT 1", [generalId]);
    if (rows[0]) expect((await call(`/messages/${rows[0].id}`, { method: 'DELETE', token: ana.token })).status).toBe(403);
  });
});
