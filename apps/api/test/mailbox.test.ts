/**
 * Correo en el chat (docs/CORREO.md). Necesita el API (API_URL) con MAIL_ENABLED=true y MAIL_* apuntando a
 * test/fake-mail.mjs (FAKE_MAIL), S3 falso (test/fake-s3.mjs). Esto NO prueba OAuth ni permisos reales de Google/Microsoft.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { cleanBody, gmailQuery, graphListUrl, htmlToText, parseAddressList } from '../src/modules/mailbox.ts';

const API = process.env.API_URL ?? 'http://localhost:3097';
const FAKE = process.env.FAKE_MAIL ?? 'http://localhost:59397';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const hash = (s: string) => createHash('sha256').update(s).digest('base64url');

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = {};
  try { json = JSON.parse(buf.toString()); } catch {}
  return { status: res.status, json, buf, headers: res.headers };
}
const post = (path: string, token: string, body: unknown = {}) => call(path, { token, body });
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.mail.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
async function connect(a: Actor, provider: 'google' | 'microsoft') {
  const verifier = randomBytes(32).toString('base64url');
  const start = await post(`/mail/connect/${provider}`, a.token, { platform: 'web', proofChallenge: hash(verifier) });
  expect(start.status).toBe(200);
  const auth = await fetch(start.json.url, { redirect: 'manual' });
  const cb = await fetch(auth.headers.get('location')!, { redirect: 'manual' });
  expect(cb.status).toBe(302);
  const back = new URL(cb.headers.get('location')!);
  expect(back.pathname).toBe('/correo');
  const receipt = back.searchParams.get('receipt')!;
  // El recibo solo sirve con la prueba de quien empezó.
  expect((await post('/mail/connect/confirm', a.token, { receipt, proofVerifier: randomBytes(32).toString('base64url') })).status).toBe(409);
  const again = await post(`/mail/connect/${provider}`, a.token, { platform: 'web', proofChallenge: hash(verifier) });
  const cb2 = await fetch((await fetch(again.json.url, { redirect: 'manual' })).headers.get('location')!, { redirect: 'manual' });
  const r2 = new URL(cb2.headers.get('location')!).searchParams.get('receipt')!;
  expect((await post('/mail/connect/confirm', a.token, { receipt: r2, proofVerifier: verifier })).json).toEqual({ ok: true, provider });
}
const stats = async () => (await (await fetch(`${FAKE}/stats`)).json()) as { batch: number; gmailGet: number; gmailList: number; graphGet: number; graphAttachments: number };
const sentOut = async (): Promise<any[]> => (await (await fetch(`${FAKE}/sent`)).json()) as any[];
const sysOf = async (a: Actor, conv: string, k: string) => ((await call(`/conversations/${conv}/messages?limit=100`, { token: a.token })).json.messages as any[])
  .filter((m) => m.kind === 'system' && m.body.startsWith(`{"k":"${k}"`)).map((m) => ({ ...m, b: JSON.parse(m.body) }));

describe('utilidades (sin API)', () => {
  it('filtros → consulta de Gmail (incluye pestaña Principal y fecha hasta inclusiva)', () => {
    expect(gmailQuery({ provider: 'google', box: 'inbox', category: 'primary', q: 'presentación', from: 'Jorge Ramírez', after: '2026-09-01', before: '2026-09-29', attachments: '1' } as any))
      .toBe('in:inbox category:primary presentación from:"Jorge Ramírez" after:2026/09/01 before:2026/09/30 has:attachment');
    expect(gmailQuery({ provider: 'google', box: 'sent', category: 'primary' } as any)).toBe('in:sent');
  });
  it('filtros → Graph: $filter sin texto, $search KQL con texto', () => {
    const f = new URL(graphListUrl({ provider: 'microsoft', box: 'inbox', category: 'focused', unread: '1', after: '2026-09-01' } as any));
    expect(f.pathname).toMatch(/mailFolders\/inbox\/messages$/);
    expect(f.searchParams.get('$filter')).toBe("receivedDateTime ge 2026-09-01T00:00:00Z and isRead eq false and inferenceClassification eq 'focused'");
    const s = new URL(graphListUrl({ provider: 'microsoft', box: 'all', q: 'pago', from: 'banco' } as any));
    expect(s.searchParams.get('$search')).toBe('"pago AND from:banco"');
    expect(s.searchParams.has('$orderby')).toBe(false);
  });
  it('se guarda solo lo nuevo: sin historial citado ni firma', () => {
    expect(cleanBody('Confirmo, gracias.\n\n-- \nAna\nCoordinadora\n\nEl mar, 8 jul 2025 a las 10:53, Lorena escribió:\n> hola')).toEqual({ text: 'Confirmo, gracias.', trimmed: true });
    expect(cleanBody('Va el acta.\r\n\r\nOn Tue, Jul 8, 2025 at 10:53 AM Lorena <l@x.co> wrote:\r\n> hi').text).toBe('Va el acta.');
    expect(cleanBody('Listo.\n________________________________\nDe: Jorge\nEnviado: martes').text).toBe('Listo.');
    expect(cleanBody('Hola equipo, todo bien por aquí.')).toEqual({ text: 'Hola equipo, todo bien por aquí.', trimmed: false });
    // Si cortar lo deja casi vacío, se guarda todo.
    expect(cleanBody('Ok\n\nEl lun, 1 sep 2026, Ana escribió:\n> el texto importante').trimmed).toBe(false);
    expect(cleanBody('x'.repeat(30_000)).text.length).toBe(20_000);
  });
  it('HTML a texto y direcciones', () => {
    expect(htmlToText('<p>Hola&nbsp;<b>Jorge</b></p><script>x</script><p>1 &amp; 2</p>')).toBe('Hola Jorge\n1 & 2');
    expect(parseAddressList('"Ramírez, Jorge" <J@X.co>, ana@y.co')).toEqual([{ name: 'Ramírez, Jorge', email: 'j@x.co' }, { name: null, email: 'ana@y.co' }]);
  });
});

describe('correo en el chat (API + proveedor falso)', () => {
  let ana: Actor, beto: Actor, carla: Actor, chat: string, emailId: string;
  beforeAll(async () => {
    ana = await signup('Ana');
    const inv = (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token;
    beto = await signup('Beto', inv);
    carla = await signup('Carla');
    chat = (await post('/chats', ana.token, { userIds: [beto.id], name: `Ventas ${run}` })).json.id;
    await connect(ana, 'google');
  });

  it('sin conectar: la lista pide conectar', async () => {
    const r = await call('/mail/messages?provider=google', { token: beto.token });
    expect(r.status).toBe(409);
    expect(r.json.code ?? r.json.error?.code).toBe('not_connected');
  });

  it('Recibidos muestra Principal por defecto; Notificaciones y búsqueda de correos viejos también', async () => {
    const primary = await call('/mail/messages?provider=google&box=inbox&category=primary', { token: ana.token });
    expect(primary.status).toBe(200);
    expect(primary.json.items.map((i: any) => i.id)).toEqual(['g1', 'g6', 'g5']);
    expect(primary.json.items[0].hasAttachments).toBe(true);
    // Una sola petición en lote para la metadata (no una por correo), y la misma lista otra vez sale de la caché.
    const s1 = await stats();
    await call('/mail/messages?provider=google&box=inbox&category=primary', { token: ana.token });
    expect(await stats()).toEqual(s1);
    await call('/mail/messages?provider=google&box=inbox&category=primary&fresh=1', { token: ana.token });
    const s2 = await stats();
    expect(s2.gmailList).toBe(s1.gmailList + 1);
    expect(s2.batch).toBe(s1.batch + 1);
    expect(s2.gmailGet).toBe(s1.gmailGet);
    const updates = await call('/mail/messages?provider=google&box=inbox&category=updates', { token: ana.token });
    expect(updates.json.items.map((i: any) => i.subject)).toEqual(['Recibiste un pago de $4.200.000']);
    const old = await call('/mail/messages?provider=google&box=all&q=presentaci%C3%B3n&before=2025-12-31', { token: ana.token });
    expect(old.json.items.map((i: any) => i.id)).toEqual(['g5']);
    const sent = await call('/mail/messages?provider=google&box=sent', { token: ana.token });
    expect(sent.json.items[0].box).toBe('sent');
  });

  it('compartir guarda solo ese correo y publica la tarjeta con el comentario', async () => {
    const r = await post('/mail/share', ana.token, { provider: 'google', messageId: 'g1', conversationId: chat, comment: 'Miren el correo de Jorge' });
    expect(r.status).toBe(201);
    emailId = r.json.id;
    expect(r.json).toMatchObject({ subject: 'Solicitud de presentación para el comité del jueves', direction: 'in', status: 'pending', comment: 'Miren el correo de Jorge' });
    expect(r.json.from).toEqual({ name: 'Jorge Ramírez', email: 'jorge.ramirez@uniandes.edu.co' });
    expect(r.json.attachments.map((a: any) => a.name)).toEqual(['Requisitos_comite.pdf', 'Formato_precios.xlsx']);
    const card = (await sysOf(beto, chat, 'mail.shared'))[0];
    expect(card.b).toMatchObject({ emailId, provider: 'google', comment: 'Miren el correo de Jorge' });
    // Beto (del chat) lo lee; Carla (fuera) no.
    // La tarjeta va sin cuerpo; el cuerpo sale con full=1.
    const card0 = await call(`/mail/shared/${emailId}`, { token: beto.token });
    expect(card0.json).toMatchObject({ body: '', full: false, trimmed: false });
    expect(card0.json.snippet).toContain('comité de la Facultad');
    const seen = await call(`/mail/shared/${emailId}?full=1`, { token: beto.token });
    expect(seen.json.full).toBe(true);
    expect(seen.json.body).toContain('comité de la Facultad');
    expect(seen.json.webLink).toBeNull();
    expect((await call(`/mail/shared/${emailId}`, { token: ana.token })).json.webLink).toContain('#all/g1');
    expect((await call(`/mail/shared/${emailId}`, { token: carla.token })).status).toBeGreaterThanOrEqual(403);
  });

  it('guarda solo lo nuevo y trae el original en vivo; tarjetas en lote; el evento en vivo no lleva el cuerpo', async () => {
    const r = await post('/mail/share', ana.token, { provider: 'google', messageId: 'g6', conversationId: chat });
    expect(r.status).toBe(201);
    const full = (await call(`/mail/shared/${r.json.id}?full=1`, { token: beto.token })).json;
    expect(full.body).toBe('Confirmo que ya aparecen en la cuenta de la facultad.');
    expect(full.trimmed).toBe(true);
    const orig = await call(`/mail/shared/${r.json.id}/original`, { token: beto.token });
    expect(orig.json.body).toContain('ya repusimos los 209 créditos');
    expect((await call(`/mail/shared/${r.json.id}/original`, { token: carla.token })).status).toBeGreaterThanOrEqual(403);
    const many = await call(`/mail/shared?ids=${emailId},${r.json.id},${randomUUID()}`, { token: beto.token });
    expect(many.json.emails.map((e: any) => e.id)).toEqual([emailId, r.json.id]);
    expect(many.json.emails.every((e: any) => e.body === '')).toBe(true);
    expect((await call(`/mail/shared?ids=${emailId}`, { token: carla.token })).json.emails).toEqual([]);
    const ev = await call(`/conversations/${chat}/events?after=0&limit=500`, { token: beto.token });
    const updates = (ev.json.events as any[]).filter((e) => e.type === 'mail.updated');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((e) => e.email.body === '')).toBe(true);
  });

  it('adjunto bajo demanda desde el buzón de quien compartió (sin guardarlo)', async () => {
    const e = (await call(`/mail/shared/${emailId}`, { token: beto.token })).json;
    const r = await call(`/mail/shared/${emailId}/attachments/${e.attachments[0].id}`, { token: beto.token });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.buf.toString()).toBe('%PDF-1.4 fake');
    expect((await call(`/mail/shared/${emailId}/attachments/${e.attachments[0].id}`, { token: carla.token })).status).toBeGreaterThanOrEqual(403);
  });

  it('comentarios al equipo con aviso agrupado', async () => {
    expect((await post(`/mail/shared/${emailId}/comments`, beto.token, { body: 'Tengo la presentación de agosto' })).status).toBe(201);
    await post(`/mail/shared/${emailId}/comments`, ana.token, { body: 'Usemos la tabla 2027' });
    const c = await call(`/mail/shared/${emailId}/comments`, { token: beto.token });
    expect(c.json.comments.map((x: any) => x.body)).toEqual(['Tengo la presentación de agosto', 'Usemos la tabla 2027']);
    const notices = await sysOf(ana, chat, 'mail.comments');
    expect(notices.length).toBe(1);
    expect(notices[0].b.count).toBe(2);
  });

  it('gg redacta; solo el dueño responde', async () => {
    const d = await post(`/mail/shared/${emailId}/draft`, ana.token, {});
    expect(d.json.body).toContain('Jorge');
    expect((await post(`/mail/shared/${emailId}/draft`, beto.token, {})).status).toBe(403);
    expect((await post(`/mail/shared/${emailId}/reply`, beto.token, { body: 'hola' })).status).toBe(403);
  });

  it('tarea desde el correo que se cierra al responder', async () => {
    const r = await post(`/mail/shared/${emailId}/task`, ana.token, { title: 'Enviar presentación', ownerId: beto.id, closeOnReply: true });
    expect(r.status).toBe(201);
    expect(r.json.email.issueId).toBe(r.json.issue.id);
    expect((await post(`/mail/shared/${emailId}/task`, ana.token, { title: 'Otra' })).status).toBe(409);
  });

  it('programar, cancelar y responder ya (a todos menos yo, con In-Reply-To)', async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const s = await post(`/mail/shared/${emailId}/reply`, ana.token, { body: 'Programada', sendAt: at });
    expect(s.json.status).toBe('scheduled');
    expect(s.json.scheduledReply.sendAt).toBe(at);
    expect((await call(`/mail/shared/${emailId}`, { token: beto.token })).json.scheduledReply).toBeNull();
    expect((await post(`/mail/shared/${emailId}/reply`, ana.token, { body: 'Otra' })).status).toBe(409);
    expect((await call(`/mail/shared/${emailId}/reply`, { token: ana.token, method: 'DELETE' })).json.status).toBe('pending');
    const before = (await sentOut()).length;
    const r = await post(`/mail/shared/${emailId}/reply`, ana.token, { body: 'Hola, Jorge. Va la presentación.' });
    expect(r.json.status).toBe('replied');
    const out = (await sentOut()).slice(before);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ provider: 'google', threadId: 't1', inReplyTo: '<g1@mock>' });
    expect(out[0].to).toContain('jorge.ramirez@uniandes.edu.co');
    expect(out[0].cc).toContain('oscar@uniandes.edu.co');
    expect(out[0].cc).not.toContain('mock.google@example.com');
    const subject = String(out[0].subject).replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_: string, b: string) => Buffer.from(b, 'base64').toString('utf8'));
    expect(subject).toBe('Re: Solicitud de presentación para el comité del jueves');
    expect((await sysOf(beto, chat, 'mail.replied')).length).toBe(1);
    const task = await call(`/issues/${(await call(`/mail/shared/${emailId}`, { token: ana.token })).json.issueId}`, { token: ana.token });
    expect(task.json.issue.status).toBe('done');
  });

  it('Outlook: Prioritarios, compartir y responder por Graph', async () => {
    await connect(beto, 'microsoft');
    const focused = await call('/mail/messages?provider=microsoft&box=inbox&category=focused', { token: beto.token });
    expect(focused.status).toBe(200);
    expect(focused.json.items.map((i: any) => i.id)).toEqual(['ms-g1', 'ms-g6', 'ms-g5']);
    const other = await call('/mail/messages?provider=microsoft&box=inbox&category=other', { token: beto.token });
    expect(other.json.items.map((i: any) => i.subject)).toContain('Recibiste un pago de $4.200.000');
    const shared = await post('/mail/share', beto.token, { provider: 'microsoft', messageId: 'ms-g2', conversationId: chat, comment: 'Llegó el pago' });
    expect(shared.status).toBe(201);
    // Correo y adjuntos en una sola petición a Graph ($expand).
    expect((await stats()).graphAttachments).toBe(0);
    expect((await call(`/mail/shared/${shared.json.id}?full=1`, { token: beto.token })).json.body).toContain('Recibiste un pago de Uniandes por $4.200.000 & ya está en tu cuenta.');
    const before = (await sentOut()).length;
    const r = await post(`/mail/shared/${shared.json.id}/reply`, beto.token, { body: 'Gracias.\nRecibido.' });
    expect(r.json.status).toBe('replied');
    const out = (await sentOut()).slice(before);
    expect(out[0]).toMatchObject({ provider: 'microsoft', id: 'ms-g2', to: 'avisos@banco.example', comment: 'Gracias.<br>Recibido.' });
  });

  it('WhatsApp: solo el dueño de la cuenta comparte sus mensajes', async () => {
    const r = await post('/whatsapp/share', beto.token, { accountId: randomUUID(), jid: '573001234567@s.whatsapp.net', messageId: 'x', conversationId: chat });
    expect(r.status).toBe(404);
  });

  it('desconectar corta la lista', async () => {
    await call('/mail/connections/google', { token: ana.token, method: 'DELETE' });
    expect((await call('/mail/messages?provider=google', { token: ana.token })).status).toBe(409);
    const att = await call(`/mail/shared/${emailId}/attachments/a1`, { token: beto.token });
    expect(att.status).toBe(409);
    expect(att.json.code ?? att.json.error?.code).toBe('attachment_unavailable');
  });
});
