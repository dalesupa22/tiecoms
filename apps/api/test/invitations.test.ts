/**
 * Invitaciones por correo de punta a punta. Necesita el API (API_URL) apuntando al
 * Brevo falso (BREVO_URL, por defecto http://localhost:59100): node test/fake-brevo.mjs
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const BREVO = process.env.BREVO_URL ?? 'http://localhost:59100';
const run = randomUUID().slice(0, 8);
const mailOf = (who: string) => `${who}.${run}@acme-pruebas.co`;

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
}
const device = () => ({ deviceId: randomUUID(), name: 'vitest', platform: 'android' });
async function signup(who: string, extra: Record<string, unknown>) {
  const r = await call('/auth/signup', { body: { name: who, email: mailOf(who), password: 'clave-segura-123', device: device(), ...extra } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}
const sentTo = async (email: string) => ((await (await fetch(`${BREVO}/sent`)).json()) as any[]).filter((m) => m.to[0].email === email);
const tokenIn = (html: string, re: RegExp) => decodeURIComponent(re.exec(html)![1]!.replace(/&amp;/g, '&'));

let ana: Awaited<ReturnType<typeof signup>>;
let workspaceId: string;

beforeAll(async () => {
  ana = await signup('ana', { orgName: `Proveedor ${run}` });
  workspaceId = (await call('/workspaces', { token: ana.token, body: { name: `Proyecto ${run}` } })).json.id;
});

describe('invitación a la empresa por correo', () => {
  it('envía el correo desde admin@chaggu.com con un enlace que sirve para registrarse', async () => {
    const r = await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: { email: mailOf('colega'), lang: 'en' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ emailSent: true, emailStatus: 'sent' });
    const [m] = await sentTo(mailOf('colega'));
    expect(m.sender.email).toBe('admin@chaggu.com');
    expect(m.replyTo.email).toBe(mailOf('ana'));
    expect(m.subject).toBe(`ana invited you to Proveedor ${run} on Chaggu`);
    const token = tokenIn(m.htmlContent, /signup\?org=([^"&]+)/);
    expect(token).toBe(r.json.token);
    const pending = await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token });
    expect(pending.json.invitations).toHaveLength(1);
    expect(pending.json.invitations[0]).toMatchObject({ email: mailOf('colega'), emailStatus: 'sent', sendCount: 1, canManage: true, expired: false });
  });

  it('una segunda invitación al mismo correo reemplaza a la anterior', async () => {
    const first = (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json; // sin correo: no se lista
    const again = await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: { email: mailOf('colega') } });
    expect(again.json.emailSent).toBe(true);
    const pending = (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token })).json.invitations;
    expect(pending).toHaveLength(1);
    const olds = await sentTo(mailOf('colega'));
    const oldToken = tokenIn(olds[0].htmlContent, /signup\?org=([^"&]+)/);
    expect((await call(`/org-invitations/${encodeURIComponent(oldToken)}`)).json.valid).toBe(false);
    expect(first.emailSent).toBe(false);
  });

  it('reenviar cambia el enlace (el anterior deja de servir) y respeta la espera', async () => {
    const [inv] = (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token })).json.invitations;
    const soon = await call(`/organizations/${ana.orgId}/invitations/${inv.id}/resend`, { token: ana.token, body: {} });
    expect(soon.status).toBe(429);
    expect(soon.json.error.code).toBe('resend_too_soon');
    // El API de pruebas corre con INVITE_RESEND_COOLDOWN_S=2.
    await new Promise((r) => setTimeout(r, 2200));
    const before = (await sentTo(mailOf('colega'))).at(-1);
    const r = await call(`/organizations/${ana.orgId}/invitations/${inv.id}/resend`, { token: ana.token, body: {} });
    expect(r.json).toMatchObject({ emailSent: true, emailStatus: 'sent' });
    const after = (await sentTo(mailOf('colega'))).at(-1);
    const oldToken = tokenIn(before.htmlContent, /signup\?org=([^"&]+)/);
    const newToken = tokenIn(after.htmlContent, /signup\?org=([^"&]+)/);
    expect(newToken).toBe(r.json.token);
    // El enlace viejo ya no existe (su token se reemplazó).
    expect((await call(`/org-invitations/${encodeURIComponent(oldToken)}`)).status).toBe(404);
    expect((await call(`/org-invitations/${encodeURIComponent(newToken)}`)).json.valid).toBe(true);
    const [again] = (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token })).json.invitations;
    expect(again.sendCount).toBe(2);
  });

  it('no invita a quien ya es de la empresa', async () => {
    const r = await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: { email: mailOf('ana') } });
    expect(r.status).toBe(409);
  });

  it('si Brevo rechaza el correo, la invitación existe y queda marcada como no enviada', async () => {
    const r = await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: { email: `rebota.${run}@acme-pruebas.co` } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ emailSent: false, emailStatus: 'failed' });
    const inv = (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token })).json.invitations.find((i: any) => i.email.startsWith('rebota'));
    expect(inv).toMatchObject({ emailStatus: 'failed', emailSentAt: null, sendCount: 0 });
  });

  it('la persona invitada se registra con el enlace del correo y sale de pendientes', async () => {
    const [m] = (await sentTo(mailOf('colega'))).slice(-1);
    const token = tokenIn(m.htmlContent, /signup\?org=([^"&]+)/);
    const joined = await call('/auth/signup', { body: { name: 'colega', email: mailOf('colega'), password: 'clave-segura-123', device: device(), orgInviteToken: token } });
    expect(joined.status).toBe(200);
    expect(joined.json.user.primaryOrgId).toBe(ana.orgId);
    const pending = (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token })).json.invitations;
    expect(pending.map((i: any) => i.email)).not.toContain(mailOf('colega'));
  });
});

describe('invitación a un espacio por correo', () => {
  let invId: string;
  it('envía el correo con el enlace /invite y lo lista como pendiente', async () => {
    const r = await call(`/workspaces/${workspaceId}/invitations`, { token: ana.token, body: { email: mailOf('beto'), role: 'member', conversationIds: [] } });
    expect(r.json.emailSent).toBe(true);
    const [m] = await sentTo(mailOf('beto'));
    expect(m.subject).toBe(`ana te invitó a Proyecto ${run} en Chaggu`);
    expect(tokenIn(m.htmlContent, /\/invite\/([^"&]+)/)).toBe(r.json.token);
    const pending = (await call(`/workspaces/${workspaceId}/invitations`, { token: ana.token })).json.invitations;
    expect(pending).toHaveLength(1);
    invId = pending[0].id;
  });

  it('otra empresa no puede ver ni tocar las invitaciones del espacio', async () => {
    const intruso = await signup('intruso', { orgName: `Otra ${run}` });
    expect((await call(`/workspaces/${workspaceId}/invitations`, { token: intruso.token })).status).toBe(404);
    expect((await call(`/workspaces/${workspaceId}/invitations/${invId}`, { method: 'DELETE', token: intruso.token })).status).toBe(404);
    expect((await call(`/organizations/${ana.orgId}/invitations`, { token: intruso.token })).status).toBe(404);
  });

  it('revocar invalida el enlace del correo', async () => {
    const [m] = await sentTo(mailOf('beto'));
    const token = tokenIn(m.htmlContent, /\/invite\/([^"&]+)/);
    expect((await call(`/workspaces/${workspaceId}/invitations/${invId}`, { method: 'DELETE', token: ana.token })).status).toBe(200);
    expect((await call(`/invitations/${encodeURIComponent(token)}`)).json.valid).toBe(false);
    expect((await call(`/workspaces/${workspaceId}/invitations`, { token: ana.token })).json.invitations).toHaveLength(0);
    expect((await call(`/workspaces/${workspaceId}/invitations/${invId}/resend`, { token: ana.token, body: {} })).status).toBe(409);
  });
});
