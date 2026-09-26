/**
 * Grupos: «Tu organización» (espacio casa), relaciones con otras empresas, terceros invitados
 * que participan pero no abren asuntos, y supervisión de solo lectura para administradores.
 * Necesita el API (API_URL) y su worker corriendo.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const mail = (name: string) => `${name.toLowerCase()}.grupos.${run}@example.com`;
async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/auth/signup', { body: {
    name, ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }), email: mail(name),
    password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}
async function colleague(of: { token: string; orgId: string }, name: string, role: 'member' | 'admin' = 'member') {
  const inv = await call(`/organizations/${of.orgId}/invitations`, { token: of.token, body: { email: mail(name), role } });
  expect(inv.status).toBe(200);
  return signup(name, inv.json.token);
}

describe('grupos', () => {
  let danny: Awaited<ReturnType<typeof signup>>, laura: typeof danny, pedro: typeof danny, nestle: typeof danny, asesor: typeof danny;
  beforeAll(async () => {
    danny = await signup('Danny'); // owner de su empresa
    laura = await colleague(danny, 'Laura');
    pedro = await colleague(danny, 'Pedro');
    nestle = await signup('Nestor');
    asesor = await signup('Asesor');
  });

  it('un grupo interno va al espacio casa de la empresa, que se reutiliza', async () => {
    const a = await call('/groups', { token: laura.token, body: { name: 'Diseño', target: { kind: 'org' }, memberIds: [pedro.id] } });
    expect(a.status).toBe(200);
    const b = await call('/groups', { token: danny.token, body: { name: 'Comercial', target: { kind: 'org' } } });
    expect(b.status).toBe(200);
    expect(b.json.workspaceId).toBe(a.json.workspaceId);
    const boot = (await call('/bootstrap', { token: pedro.token })).json;
    const home = boot.workspaces.find((w: any) => w.id === a.json.workspaceId);
    expect(home).toMatchObject({ isOrgHome: true, organizationIds: [danny.orgId] });
    // Pedro ve Diseño (lo sumaron) pero no Comercial (no es miembro): solo ve en lo que está.
    const names = boot.conversations.filter((c: any) => c.workspaceId === home.id).map((c: any) => c.name);
    expect(names).toEqual(['Diseño']);
    // Un grupo interno no suma directamente a gente de otra empresa.
    const bad = await call('/groups', { token: danny.token, body: { name: 'Mixto', target: { kind: 'org' }, memberIds: [nestle.id] } });
    expect(bad.status).toBe(400);
  });

  it('la gente de fuera entra a un grupo interno solo como tercero', async () => {
    const home = (await call('/groups', { token: danny.token, body: { name: 'Estrategia', target: { kind: 'org' } } })).json;
    const asMember = await call(`/workspaces/${home.workspaceId}/invitations`, { token: danny.token, body: { email: mail('Asesor'), role: 'member', conversationIds: [home.conversationId] } });
    expect(asMember.status).toBe(400);
    const inv = await call(`/workspaces/${home.workspaceId}/invitations`, { token: danny.token, body: { email: mail('Asesor'), role: 'guest', conversationIds: [home.conversationId] } });
    expect(inv.status).toBe(200);
    expect((await call(`/invitations/${inv.json.token}/accept`, { token: asesor.token, body: {} })).status).toBe(200);
    const boot = (await call('/bootstrap', { token: danny.token })).json;
    // El espacio casa sigue siendo solo de la empresa.
    expect(boot.workspaces.find((w: any) => w.id === home.workspaceId).organizationIds).toEqual([danny.orgId]);

    // El tercero participa (escribe) pero no abre asuntos; un asunto abierto por otro sí lo puede mover.
    const msg = await call(`/conversations/${home.conversationId}/messages`, { token: asesor.token, body: { clientMessageId: randomUUID(), body: 'Hola, soy el asesor' } });
    expect(msg.status).toBe(201);
    const denied = await call(`/conversations/${home.conversationId}/issues`, { token: asesor.token, body: { title: 'Revisar precios' } });
    expect(denied.status).toBe(403);
    const issue = await call(`/conversations/${home.conversationId}/issues`, { token: danny.token, body: { title: 'Revisar precios', ownerId: asesor.id } });
    expect(issue.status).toBe(200);
    const moved = await call(`/issues/${issue.json.id}`, { method: 'PATCH', token: asesor.token, body: { status: 'in_progress' } });
    expect(moved.status).toBe(200);
    expect((await call(`/issues/${issue.json.id}/comments`, { token: asesor.token, body: { body: 'En eso estoy' } })).status).toBe(200);
  });

  it('una relación nueva se ve como pendiente hasta que la otra empresa entra', async () => {
    const r = await call('/groups', { token: danny.token, body: { name: 'Pagos', target: { kind: 'company', companyName: 'Nestlé' }, memberIds: [laura.id] } });
    expect(r.status).toBe(200);
    let ws = (await call('/bootstrap', { token: laura.token })).json.workspaces.find((w: any) => w.id === r.json.workspaceId);
    expect(ws).toMatchObject({ isOrgHome: false, counterpartName: 'Nestlé', organizationIds: [danny.orgId] });
    // Un segundo grupo en la misma relación.
    const g2 = await call('/groups', { token: laura.token, body: { name: 'Educación continua', target: { kind: 'workspace', workspaceId: r.json.workspaceId } } });
    expect(g2.status).toBe(200);
    const inv = await call(`/workspaces/${r.json.workspaceId}/invitations`, { token: danny.token, body: { email: mail('Nestor'), conversationIds: [r.json.conversationId] } });
    expect((await call(`/invitations/${inv.json.token}/accept`, { token: nestle.token, body: {} })).status).toBe(200);
    ws = (await call('/bootstrap', { token: nestle.token })).json.workspaces.find((w: any) => w.id === r.json.workspaceId);
    expect(ws.organizationIds).toEqual([danny.orgId, nestle.orgId]);
    // La persona de la otra empresa (no tercera) sí puede abrir asuntos y crear grupos en la relación.
    expect((await call(`/conversations/${r.json.conversationId}/issues`, { token: nestle.token, body: { title: 'Factura septiembre' } })).status).toBe(200);
    expect((await call('/groups', { token: nestle.token, body: { name: 'Compras', target: { kind: 'workspace', workspaceId: r.json.workspaceId } } })).status).toBe(200);
  });

  it('el administrador ve y lee en solo lectura los grupos donde está su gente', async () => {
    // Pedro abre un grupo en la relación con Nestlé sin Danny.
    const rel = (await call('/groups', { token: pedro.token, body: { name: 'Logística', target: { kind: 'company', companyName: 'Proveedor X' } } })).json;
    await call(`/conversations/${rel.conversationId}/messages`, { token: pedro.token, body: { clientMessageId: randomUUID(), body: 'Mensaje de Pedro' } });

    const list = await call(`/organizations/${danny.orgId}/oversight`, { token: danny.token });
    expect(list.status).toBe(200);
    const g = list.json.groups.find((x: any) => x.conversationId === rel.conversationId);
    expect(g).toMatchObject({ name: 'Logística', iAmMember: false, myOrgMemberIds: [pedro.id] });
    const msgs = await call(`/conversations/${rel.conversationId}/messages`, { token: danny.token });
    expect(msgs.status).toBe(200);
    expect(JSON.stringify(msgs.json)).toContain('Mensaje de Pedro');
    // Solo lectura: no puede escribir.
    const post = await call(`/conversations/${rel.conversationId}/messages`, { token: danny.token, body: { clientMessageId: randomUUID(), body: 'hola' } });
    expect(post.status).toBe(404);

    // Una persona que no administra no ve la supervisión ni lee grupos ajenos.
    expect((await call(`/organizations/${danny.orgId}/oversight`, { token: laura.token })).status).toBe(403);
    expect((await call(`/conversations/${rel.conversationId}/messages`, { token: laura.token })).status).toBe(404);
    // El administrador de otra empresa no ve grupos donde no está su gente.
    const other = await call(`/organizations/${nestle.orgId}/oversight`, { token: nestle.token });
    expect(other.json.groups.some((x: any) => x.conversationId === rel.conversationId)).toBe(false);
    expect((await call(`/conversations/${rel.conversationId}/messages`, { token: nestle.token })).status).toBe(404);
  });

  it('invitar con enlace directo o código corto: varias personas, vence y respeta el rol', async () => {
    const g = await call('/groups', { token: danny.token, body: { name: 'Mentoría financiera', target: { kind: 'company', companyName: 'Ongoing' }, shareLink: true } });
    expect(g.status).toBe(200);
    expect(g.json.inviteUrl).toMatch(/\/invite\//);
    expect(g.json.inviteCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const typed = ` ${g.json.inviteCode.toLowerCase().replace('-', ' ')} `;
    const pre = await call(`/invitations/${encodeURIComponent(typed)}`);
    expect(pre.json).toMatchObject({ valid: true, multiUse: true, groupNames: ['Mentoría financiera'], workspaceName: 'Ongoing' });
    const a = await signup('Mentor');
    const b = await signup('Startup');
    for (const u of [a, b]) expect((await call(`/invitations/${encodeURIComponent(typed)}/accept`, { token: u.token, body: {} })).status).toBe(200);
    const boot = (await call('/bootstrap', { token: b.token })).json;
    expect(boot.conversations.some((c: any) => c.id === g.json.conversationId)).toBe(true);
    // El enlace sigue sirviendo (varias personas) y un código inventado no existe.
    expect((await call(`/invitations/${encodeURIComponent(typed)}`)).json.valid).toBe(true);
    expect((await call('/invitations/ZZZZ-ZZZZ')).status).toBe(404);
    // Un enlace con correo no puede ser de varios usos.
    const bad = await call(`/workspaces/${g.json.workspaceId}/invitations`, { token: danny.token, body: { email: mail('Otro'), multiUse: true, conversationIds: [g.json.conversationId] } });
    expect(bad.status).toBe(400);
    // En un grupo interno, el enlace compartido entra como tercero (no suma la empresa).
    const home = await call('/groups', { token: danny.token, body: { name: 'Junta asesora', target: { kind: 'org' }, shareLink: true } });
    const c = await signup('Consultor');
    expect((await call(`/invitations/${home.json.inviteCode}/accept`, { token: c.token, body: {} })).status).toBe(200);
    const ws = (await call('/bootstrap', { token: c.token })).json.workspaces.find((w: any) => w.id === home.json.workspaceId);
    expect(ws.myRole).toBe('guest');
  });

  it('un tercero no crea grupos en la relación donde está invitado', async () => {
    const boot = (await call('/bootstrap', { token: asesor.token })).json;
    const home = boot.workspaces.find((w: any) => w.myRole === 'guest');
    const r = await call('/groups', { token: asesor.token, body: { name: 'Mío', target: { kind: 'workspace', workspaceId: home.id } } });
    expect(r.status).toBe(403);
  });
});
