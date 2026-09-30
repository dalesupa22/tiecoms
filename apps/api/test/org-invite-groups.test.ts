/**
 * Invitar desde «Agregar al grupo» (28-sep-2026): la invitación a la empresa lleva grupos
 * (`conversationIds`, `workspaceId`, `history`) y puede ser enlace o código de varios usos.
 * Necesita el API (API_URL) con el Brevo falso (BREVO_URL): node test/fake-brevo.mjs
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const BREVO = process.env.BREVO_URL ?? 'http://localhost:59100';
const run = randomUUID().slice(0, 8);
// Cada empresa con su dominio: quien comparte el dominio de Xertify entra a Xertify (docs/REGISTRO.md).
const OWN_COMPANY = new Set(['gabi', 'hugo', 'intruso', 'otro', 'ajeno', 'uniandes1', 'mentor']);
const mailOf = (who: string) => (OWN_COMPANY.has(who) ? `${who}.${run}@${who}-${run}-pruebas.co` : `${who}.${run}@acme-${run}-pruebas.co`);

// Cada llamada desde una IP distinta (x-forwarded-for) para no chocar con el límite de altas por minuto.
let n = 0;
const ip = () => `127.9.${Math.floor(++n / 250)}.${n % 250 + 1}`;
async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'x-forwarded-for': ip(), ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
}
const device = () => ({ deviceId: randomUUID(), name: 'vitest', platform: 'web' });
async function signup(who: string, extra: Record<string, unknown>) {
  let r = await call('/auth/signup', { body: { name: who, email: mailOf(who), password: 'clave-segura-123', device: device(), ...extra } });
  // Correo corporativo sin invitación: la cuenta nace al confirmar el correo (docs/REGISTRO.md).
  if (r.json?.error?.code === 'email_confirm_sent') {
    const m = (await sentTo(mailOf(who))).filter((x) => x.tags?.includes('signup-confirm')).at(-1);
    r = await call('/auth/signup/confirm', { body: { token: /\/confirmar\/([A-Za-z0-9_-]+)/.exec(m.textContent)![1], device: device() } });
  }
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}
const sentTo = async (email: string) => ((await (await fetch(`${BREVO}/sent`)).json()) as any[]).filter((m) => m.to[0].email === email);
const tokenIn = (html: string) => decodeURIComponent(/signup\?org=([^"&]+)/.exec(html)![1]!.replace(/&amp;/g, '&'));
const send = (token: string, conv: string, body: string) => call(`/conversations/${conv}/messages`, { token, body: { clientMessageId: randomUUID(), body } });
const bodies = async (token: string, conv: string) => (await call(`/conversations/${conv}/messages`, { token })).json.messages.map((m: any) => m.body) as string[];

let ana: Awaited<ReturnType<typeof signup>>; // owner de Xertify
let beto: Awaited<ReturnType<typeof signup>>; // miembro (no admin) de Xertify
let home: { workspaceId: string; conversationId: string };
let rel: { workspaceId: string; conversationId: string };

beforeAll(async () => {
  ana = await signup('ana', { orgName: `Xertify ${run}` });
  const t = (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token;
  beto = await signup('beto', { orgInviteToken: t });
  home = (await call('/groups', { token: beto.token, body: { name: 'Pagos', target: { kind: 'org' } } })).json;
  rel = (await call('/groups', { token: beto.token, body: { name: 'Mentorías', target: { kind: 'company', companyName: `Uniandes ${run}` } } })).json;
  await send(beto.token, home.conversationId, 'mensaje viejo de Pagos');
  await send(beto.token, rel.conversationId, 'mensaje viejo de Mentorías');
});

describe('De mi empresa: invitación a la empresa con grupo', () => {
  it('un miembro (no admin) invita por correo a un colega a un grupo de Tu organización', async () => {
    const r = await call(`/organizations/${beto.orgId}/invitations`, { token: beto.token, body: { email: mailOf('carla'), conversationIds: [home.conversationId], history: 'now', lang: 'es' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ emailSent: true, code: null });
    expect(r.json.url).toContain('/signup?org=');
    const [m] = await sentTo(mailOf('carla'));
    expect(tokenIn(m.htmlContent)).toBe(r.json.token);
    // La vista previa del registro trae el grupo.
    const pv = (await call(`/org-invitations/${encodeURIComponent(r.json.token)}`)).json;
    expect(pv).toMatchObject({ orgName: `Xertify ${run}`, groupNames: ['Pagos'], valid: true, multiUse: false });
    // Pendientes: beto ve la suya con sus grupos; puede anularla y reenviarla.
    const pend = (await call(`/organizations/${beto.orgId}/invitations`, { token: beto.token })).json.invitations;
    expect(pend).toHaveLength(1);
    expect(pend[0]).toMatchObject({ email: mailOf('carla'), canManage: true, conversationIds: [home.conversationId] });
  });

  it('al registrarse con el enlace queda en mi empresa y en el grupo, sin historial', async () => {
    const [m] = await sentTo(mailOf('carla'));
    const carla = await signup('carla', { orgInviteToken: tokenIn(m.htmlContent) });
    expect(carla.orgId).toBe(ana.orgId);
    const boot = (await call('/bootstrap', { token: carla.token })).json;
    const ws = boot.workspaces.find((w: any) => w.id === home.workspaceId);
    expect(ws).toMatchObject({ isOrgHome: true });
    expect(ws.myRole).toBe('member');
    expect(boot.conversations.map((c: any) => c.id)).toContain(home.conversationId);
    expect(await bodies(carla.token, home.conversationId)).not.toContain('mensaje viejo de Pagos');
    // Sale de pendientes y el enlace ya no sirve.
    expect((await call(`/organizations/${beto.orgId}/invitations`, { token: beto.token })).json.invitations).toHaveLength(0);
    expect((await call(`/org-invitations/${encodeURIComponent(tokenIn(m.htmlContent))}`)).json.valid).toBe(false);
  });

  it('en una relación entra al espacio como persona de mi empresa, con historial si se eligió', async () => {
    const r = await call(`/organizations/${beto.orgId}/invitations`, { token: beto.token, body: { email: mailOf('dario'), workspaceId: rel.workspaceId, conversationIds: [rel.conversationId], history: 'all' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const dario = await signup('dario', { orgInviteToken: r.json.token });
    const boot = (await call('/bootstrap', { token: dario.token })).json;
    const ws = boot.workspaces.find((w: any) => w.id === rel.workspaceId);
    expect(ws.myRole).toBe('member');
    expect(ws.organizationIds).toEqual([ana.orgId]);
    expect(await bodies(dario.token, rel.conversationId)).toContain('mensaje viejo de Mentorías');
  });

  it('enlace y código de varios usos: sirve para registrarse y para quien ya tiene cuenta', async () => {
    const r = await call(`/organizations/${beto.orgId}/invitations`, { token: beto.token, body: { conversationIds: [home.conversationId], multiUse: true, expiresInDays: 14, history: 'all' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const e1 = await signup('eva', { orgInviteToken: r.json.token });
    const e2 = await signup('fede', { orgInviteToken: r.json.code.toLowerCase().replace('-', ' ') });
    for (const p of [e1, e2]) {
      expect(p.orgId).toBe(ana.orgId);
      expect(await bodies(p.token, home.conversationId)).toContain('mensaje viejo de Pagos');
    }
    // Alguien que ya usa Chaggu en otra empresa: la vista previa y la aceptación van por /invitations/:código.
    const gabi = await signup('gabi', { orgName: `Freelance ${run}` });
    const pv = await call(`/invitations/${encodeURIComponent(r.json.code)}`);
    expect(pv.status).toBe(200);
    expect(pv.json).toMatchObject({ kind: 'org', orgName: `Xertify ${run}`, groupNames: ['Pagos'], multiUse: true, valid: true, role: 'member' });
    const acc = await call(`/invitations/${encodeURIComponent(r.json.code)}/accept`, { token: gabi.token, body: {} });
    expect(acc.status, JSON.stringify(acc.json)).toBe(200);
    expect(acc.json).toMatchObject({ kind: 'org', orgId: ana.orgId, workspaceId: home.workspaceId, conversationIds: [home.conversationId] });
    const boot = (await call('/bootstrap', { token: gabi.token })).json;
    expect(boot.me.primaryOrgId).toBe(gabi.orgId); // su empresa principal no cambia
    expect(boot.organizations.map((o: any) => o.id)).toContain(ana.orgId);
    expect(boot.conversations.map((c: any) => c.id)).toContain(home.conversationId);
    // Aceptar otra vez no duplica ni falla.
    expect((await call(`/invitations/${encodeURIComponent(r.json.token)}/accept`, { token: gabi.token, body: {} })).status).toBe(200);
  });

  it('una de correo con sesión: solo para ese correo', async () => {
    const hugo = await signup('hugo', { orgName: `Hugo ${run}` });
    const r = await call(`/organizations/${beto.orgId}/invitations`, { token: beto.token, body: { email: mailOf('hugo'), conversationIds: [home.conversationId] } });
    expect(r.status).toBe(200);
    const intruso = await signup('intruso', { orgName: `Intrusos ${run}` });
    expect((await call(`/invitations/${encodeURIComponent(r.json.token)}/accept`, { token: intruso.token, body: {} })).status).toBe(403);
    const ok = await call(`/invitations/${encodeURIComponent(r.json.token)}/accept`, { token: hugo.token, body: {} });
    expect(ok.json.conversationIds).toEqual([home.conversationId]);
    expect((await call(`/invitations/${encodeURIComponent(r.json.token)}/accept`, { token: hugo.token, body: {} })).status).toBe(409);
  });

  it('permisos y validaciones', async () => {
    const o = `/organizations/${beto.orgId}/invitations`;
    // Sin grupo, o como admin, sigue siendo solo de quien administra.
    expect((await call(o, { token: beto.token, body: { email: mailOf('x1') } })).status).toBe(403);
    expect((await call(o, { token: beto.token, body: { email: mailOf('x2'), role: 'admin', conversationIds: [home.conversationId] } })).status).toBe(403);
    // Un grupo donde no participo.
    const solo = (await call('/groups', { token: ana.token, body: { name: 'Directivos', target: { kind: 'org' } } })).json;
    expect((await call(o, { token: beto.token, body: { conversationIds: [solo.conversationId], multiUse: true } })).status).toBe(400);
    // workspaceId que no coincide, grupos de dos espacios, enlace con correo.
    expect((await call(o, { token: beto.token, body: { workspaceId: rel.workspaceId, conversationIds: [home.conversationId] } })).status).toBe(400);
    expect((await call(o, { token: beto.token, body: { conversationIds: [home.conversationId, rel.conversationId] } })).status).toBe(400);
    expect((await call(o, { token: beto.token, body: { email: mailOf('x3'), multiUse: true, conversationIds: [home.conversationId] } })).status).toBe(400);
    // Otra empresa no puede invitar a la mía.
    const otro = await signup('otro', { orgName: `Otra ${run}` });
    expect((await call(o, { token: otro.token, body: { conversationIds: [home.conversationId] } })).status).toBe(404);
    // Beto solo ve y gestiona las suyas; Ana (owner) ve todas.
    await call(o, { token: ana.token, body: { email: mailOf('de-ana') } });
    const mine = (await call(o, { token: beto.token })).json.invitations.map((i: any) => i.email);
    expect(mine).not.toContain(mailOf('de-ana'));
    const all = (await call(o, { token: ana.token })).json.invitations;
    const deAna = all.find((i: any) => i.email === mailOf('de-ana'));
    expect(deAna).toBeTruthy();
    expect((await call(`${o}/${deAna.id}`, { method: 'DELETE', token: beto.token })).status).toBe(403);
  });

  it('cliente viejo: la invitación sin grupos funciona igual', async () => {
    const r = await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: { email: mailOf('vieja') } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ emailSent: true });
    const p = await signup('vieja', { orgInviteToken: r.json.token });
    expect(p.orgId).toBe(ana.orgId);
    const pv = (await call(`/org-invitations/${encodeURIComponent(r.json.token)}`)).json;
    expect(pv).toMatchObject({ valid: false, groupNames: [] });
  });
});

describe('Agregar al grupo: colegas que aún no están en el espacio', () => {
  it('se puede sumar a un colega de mi empresa a un grupo de Tu organización aunque no esté en el espacio', async () => {
    const t = (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token;
    const ivan = await signup('ivan', { orgInviteToken: t });
    const r = await call(`/conversations/${home.conversationId}/members`, { token: beto.token, body: { userIds: [ivan.id], history: 'now' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.added).toEqual([ivan.id]);
    const boot = (await call('/bootstrap', { token: ivan.token })).json;
    expect(boot.conversations.map((c: any) => c.id)).toContain(home.conversationId);
    // Alguien de otra empresa sin espacio compartido, no.
    const ajeno = await signup('ajeno', { orgName: `Ajena ${run}` });
    expect((await call(`/conversations/${home.conversationId}/members`, { token: beto.token, body: { userIds: [ajeno.id] } })).status).toBe(400);
  });
});

describe('De otra empresa y terceros (invitación del espacio, sin cambios)', () => {
  it('la primera persona de la otra empresa entra como admin (viralidad) y un tercero como guest', async () => {
    const m = await call(`/workspaces/${rel.workspaceId}/invitations`, { token: beto.token, body: { email: mailOf('uniandes1'), role: 'member', conversationIds: [rel.conversationId], history: 'now' } });
    expect(m.status).toBe(200);
    const u1 = await signup('uniandes1', { orgName: `Uniandes ${run}` });
    expect((await call(`/invitations/${encodeURIComponent(m.json.token)}/accept`, { token: u1.token, body: {} })).json.kind).toBe('workspace');
    let ws = (await call('/bootstrap', { token: u1.token })).json.workspaces.find((w: any) => w.id === rel.workspaceId);
    expect(ws.myRole).toBe('admin');
    const g = await call(`/workspaces/${home.workspaceId}/invitations`, { token: beto.token, body: { role: 'guest', conversationIds: [home.conversationId], multiUse: true, expiresInDays: 14 } });
    expect(g.json.code).toBeTruthy();
    const mentor = await signup('mentor', { orgName: `Mentor ${run}` });
    await call(`/invitations/${encodeURIComponent(g.json.code)}/accept`, { token: mentor.token, body: {} });
    ws = (await call('/bootstrap', { token: mentor.token })).json.workspaces.find((w: any) => w.id === home.workspaceId);
    expect(ws.myRole).toBe('guest');
    // Un tercero no puede invitar.
    expect((await call(`/workspaces/${home.workspaceId}/invitations`, { token: mentor.token, body: { role: 'guest', conversationIds: [home.conversationId], multiUse: true } })).status).toBe(403);
  });
});
