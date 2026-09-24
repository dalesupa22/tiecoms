/**
 * Eliminar la cuenta contra un API real (API_URL), con datos propios.
 *   API_URL=http://localhost:3041 npx vitest run test/account.test.ts
 */
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
const PASSWORD = 'clave-segura-123';

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const device = () => ({ deviceId: randomUUID(), name: 'vitest', platform: 'ios' });

describe('eliminar cuenta', () => {
  it('anonimiza, saca de todo, revoca sesiones y traspasa la empresa', async () => {
    const email = `borrar.${run}@example.com`;
    const a = (await call('/auth/signup', { body: { name: 'Borra Me', email, password: PASSWORD, orgName: `Borrar ${run}`, device: device() } })).json;
    const inv = (await call(`/organizations/${a.user.primaryOrgId}/invitations`, { token: a.accessToken, body: {} })).json;
    const colega = (await call('/auth/signup', { body: { name: 'Colega Queda', email: `colega.${run}@example.com`, password: PASSWORD, orgInviteToken: inv.token, device: device() } })).json;
    const ws = (await call('/workspaces', { token: a.accessToken, body: { name: `Espacio ${run}` } })).json;
    const winv = (await call(`/workspaces/${ws.id}/invitations`, { token: a.accessToken, body: { role: 'member', conversationIds: [ws.generalConversationId] } })).json;
    expect((await call(`/invitations/${winv.token}/accept`, { token: colega.accessToken, body: {} })).status).toBe(200);
    const sent = await call(`/conversations/${ws.generalConversationId}/messages`, { token: a.accessToken, body: { clientMessageId: randomUUID(), body: 'queda en el registro' } });
    expect(sent.status).toBe(201);

    const socket = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: a.accessToken } });
    await new Promise((r) => socket.once('ready', r));
    const kicked = new Promise((r) => socket.once('disconnect', r));

    // Confirmaciones inválidas.
    expect((await call('/account', { method: 'DELETE', token: a.accessToken, body: { confirmEmail: 'otro@example.com', password: PASSWORD } })).status).toBe(400);
    expect((await call('/account', { method: 'DELETE', token: a.accessToken, body: { confirmEmail: email, password: 'no-es-esta-clave' } })).status).toBe(403);

    const del = await call('/account', { method: 'DELETE', token: a.accessToken, body: { confirmEmail: email.toUpperCase(), password: PASSWORD } });
    expect(del.status).toBe(200);
    await kicked;

    // Ya no entra ni refresca.
    expect((await call('/auth/login', { body: { email, password: PASSWORD, device: device() } })).status).toBe(401);
    expect((await call('/auth/refresh', { body: { refreshToken: a.refreshToken } })).status).toBe(401);
    // Se puede volver a registrar con el mismo correo.
    expect((await call('/auth/signup', { body: { name: 'Nueva', email, password: PASSWORD, orgName: `Otra ${run}`, device: device() } })).status).toBe(200);

    // El colega hereda la empresa, sigue viendo el mensaje y ya no ve a la persona.
    const boot = (await call('/bootstrap', { token: colega.accessToken })).json;
    expect(boot.organizations.find((o: any) => o.id === a.user.primaryOrgId)?.myRole).toBe('owner');
    expect(boot.people.some((p: any) => p.id === a.user.id)).toBe(false);
    const conv = boot.conversations.find((c: any) => c.id === ws.generalConversationId);
    expect(conv.memberIds).not.toContain(a.user.id);
    const msgs = (await call(`/conversations/${ws.generalConversationId}/messages`, { token: colega.accessToken })).json.messages;
    expect(msgs.some((m: any) => m.body === 'queda en el registro')).toBe(true);
    socket.close();
  }, 30_000);
});
