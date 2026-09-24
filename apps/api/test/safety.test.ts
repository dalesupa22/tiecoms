import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const BREVO = process.env.BREVO_URL ?? 'http://localhost:59100';
const run = randomUUID().slice(0, 8);
async function call(path: string, token?: string, method = 'GET', body?: unknown) {
  const r = await fetch(`${API}/api/v1${path}`, { method, headers: { ...(/^http:\/\/(localhost|127\.0\.0\.1):/.test(API) ? { 'x-forwarded-for': '127.0.2.44' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() as any };
}
async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/auth/signup', undefined, 'POST', { name, email: `${name}.${run}@example.com`, password: 'clave-segura-123',
    ...(orgInviteToken ? { orgInviteToken } : { orgName: `Safety ${run} ${name}` }), device: { deviceId: randomUUID(), name: 'vitest', platform: 'ios' } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, org: r.json.user.primaryOrgId as string };
}
let ana: Awaited<ReturnType<typeof signup>>, beto: Awaited<ReturnType<typeof signup>>, outsider: Awaited<ReturnType<typeof signup>>;
let dm: string, message: string, group: string, groupMessage: string;
beforeAll(async () => {
  ana = await signup('ana');
  const inv = await call(`/organizations/${ana.org}/invitations`, ana.token, 'POST', {});
  beto = await signup('beto', inv.json.token);
  outsider = await signup('outsider');
  dm = (await call('/directs', ana.token, 'POST', { userId: beto.id })).json.id;
  message = (await call(`/conversations/${dm}/messages`, beto.token, 'POST', { body: 'Contenido para reporte', clientMessageId: randomUUID() })).json.message.id;
  const ws = (await call('/workspaces', ana.token, 'POST', { name: `Compartido ${run}` })).json;
  group = ws.generalConversationId;
  const invite = await call(`/workspaces/${ws.id}/invitations`, ana.token, 'POST', { role: 'member', conversationIds: [group] });
  expect((await call(`/invitations/${invite.json.token}/accept`, beto.token, 'POST', {})).status).toBe(200);
  groupMessage = (await call(`/conversations/${group}/messages`, ana.token, 'POST', { body: 'Origen de derivada', clientMessageId: randomUUID() })).json.message.id;
});

describe('seguridad de usuarios y contenido', () => {
  it('requiere sesión y rechaza autorreporte, persona invisible y mensaje ajeno al alcance', async () => {
    expect((await call('/reports', undefined, 'POST', { messageId: message, reason: 'Contenido indebido' })).status).toBe(401);
    expect((await call('/reports', outsider.token, 'POST', { messageId: message, reason: 'Contenido indebido' })).status).toBe(404);
    expect((await call('/reports', ana.token, 'POST', { userId: outsider.id, reason: 'Contenido indebido' })).status).toBe(404);
    expect((await call('/reports', beto.token, 'POST', { messageId: message, reason: 'Contenido indebido' })).status).toBe(400);
    expect((await call('/reports', ana.token, 'POST', { userId: ana.id, messageId: message, reason: 'Autor incorrecto' })).status).toBe(400);
  });
  it('guarda el reporte y el worker avisa a soporte sin copiar contenido privado al correo', async () => {
    const r = await call('/reports', ana.token, 'POST', { messageId: message, reason: 'Este mensaje contiene acoso' });
    expect(r.status).toBe(200);
    expect(r.json.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect.poll(async () => {
      const mails = await (await fetch(`${BREVO}/sent`)).json() as any[];
      return mails.find((m) => m.subject.includes(r.json.id));
    }, { timeout: 10_000 }).toMatchObject({ to: [{ email: 'soporte@tiecoms.com' }] });
    const mails = await (await fetch(`${BREVO}/sent`)).json() as any[];
    expect(JSON.stringify(mails.find((m) => m.subject.includes(r.json.id)))).not.toContain('Contenido para reporte');
  });
  it('bloquea ambos sentidos, nuevos directos y la evasión con un chat nombrado', async () => {
    expect((await call(`/blocks/${beto.id}`, ana.token, 'PUT')).status).toBe(200);
    expect((await call('/blocks', ana.token)).json.userIds).toContain(beto.id);
    for (const person of [ana, beto]) {
      const r = await call(`/conversations/${dm}/messages`, person.token, 'POST', { body: 'Bloqueado', clientMessageId: randomUUID() });
      expect(r.status).toBe(403); expect(r.json.error.code).toBe('blocked_user');
    }
    expect((await call('/directs', beto.token, 'POST', { userId: ana.id })).status).toBe(403);
    expect((await call('/chats', beto.token, 'POST', { userIds: [ana.id], name: 'Evasión' })).status).toBe(403);
    expect((await call(`/conversations/${group}/derive`, beto.token, 'POST', { messageId: groupMessage, kind: 'same' })).status).toBe(403);
    // Los grupos ya compartidos siguen funcionando; los clientes ocultan al autor bloqueado.
    expect((await call(`/conversations/${group}/messages`, beto.token, 'POST', { body: 'Registro compartido', clientMessageId: randomUUID() })).status).toBe(201);
    expect((await call(`/blocks/${ana.id}`, ana.token, 'PUT')).status).toBe(400);
    expect((await call(`/blocks/${outsider.id}`, ana.token, 'PUT')).status).toBe(404);
  });
  it('desbloquear permite volver a enviar', async () => {
    expect((await call(`/blocks/${beto.id}`, ana.token, 'DELETE')).status).toBe(200);
    expect((await call('/blocks', ana.token)).json.userIds).not.toContain(beto.id);
    expect((await call(`/conversations/${dm}/messages`, beto.token, 'POST', { body: 'De nuevo permitido', clientMessageId: randomUUID() })).status).toBe(201);
  });
});
