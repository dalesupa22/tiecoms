/**
 * Correo con Brevo contra un Brevo falso local (no necesita el API ni la BD).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: http.Server;
let last: { headers: http.IncomingHttpHeaders; body: any } | null = null;
let reply = { status: 201, body: { messageId: '<abc@smtp-relay.mailin.fr>' } as any };
let mail: typeof import('../src/mail.ts');

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      last = { headers: req.headers, body: JSON.parse(data) };
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.DATABASE_URL ??= 'postgres://x@localhost/x';
  process.env.JWT_SECRET ??= 'x'.repeat(40);
  process.env.BREVO_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3/smtp/email`;
  process.env.BREVO_API_KEY = 'xkeysib-test';
  mail = await import('../src/mail.ts');
});
afterAll(() => server.close());

const invite = () => mail.invitationMail({
  lang: 'es', to: 'lucia@nexo.co', inviterName: 'Ana <b>', inviterEmail: 'ana@xertify.co', targetName: 'Andes & Co',
  kind: 'workspace', url: 'https://app.tiecoms.com/invite/tok"en', expiresAt: new Date('2026-10-01T12:00:00Z'),
});

describe('mail', () => {
  it('envía con la llave, el remitente admin@tiecoms.com y responder-a de quien invita', async () => {
    const id = await mail.sendMail(invite());
    expect(id).toBe('<abc@smtp-relay.mailin.fr>');
    expect(last!.headers['api-key']).toBe('xkeysib-test');
    expect(last!.body.sender).toEqual({ email: 'admin@tiecoms.com', name: 'TieComs' });
    expect(last!.body.to).toEqual([{ email: 'lucia@nexo.co' }]);
    expect(last!.body.replyTo).toEqual({ email: 'ana@xertify.co', name: 'Ana <b>' });
    expect(last!.body.tags).toEqual(['workspace-invitation']);
    expect(last!.body.subject).toBe('Ana <b> te invitó a Andes & Co en TieComs');
  });

  it('escapa el HTML de nombres y enlaces', () => {
    const m = invite();
    expect(m.html).toContain('Ana &lt;b&gt;');
    expect(m.html).toContain('Andes &amp; Co');
    expect(m.html).toContain('href="https://app.tiecoms.com/invite/tok&quot;en"');
    expect(m.html).not.toContain('<b>Ana <b>');
    expect(m.text).toContain('https://app.tiecoms.com/invite/tok"en');
  });

  it('en inglés cambia asunto y botón', () => {
    const m = mail.invitationMail({ ...{ lang: 'en', to: 'a@b.co', inviterName: 'Ana', inviterEmail: 'a@x.co', targetName: 'Xertify', kind: 'org', url: 'https://x', expiresAt: new Date() } });
    expect(m.subject).toBe('Ana invited you to Xertify on TieComs');
    expect(m.html).toContain('Accept invitation');
    expect(m.tags).toEqual(['org-invitation']);
  });

  it('un rechazo de Brevo no rompe a quien invita (trySendMail devuelve false)', async () => {
    reply = { status: 400, body: { code: 'invalid_parameter', message: 'sender not valid' } };
    await expect(mail.sendMail(invite())).rejects.toThrow(/Brevo respondió 400: invalid_parameter sender not valid/);
    expect(await mail.trySendMail(invite())).toBe(false);
    reply = { status: 201, body: { messageId: 'x' } };
  });

  it('sin llave no intenta enviar', async () => {
    delete process.env.BREVO_API_KEY;
    last = null;
    expect(mail.mailEnabled()).toBe(false);
    expect(await mail.trySendMail(invite())).toBe(false);
    expect(last).toBeNull();
    process.env.BREVO_API_KEY = 'xkeysib-test';
  });
});
