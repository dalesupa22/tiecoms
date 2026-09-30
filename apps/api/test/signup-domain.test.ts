/**
 * Registro por empresa con correo corporativo (docs/REGISTRO.md). Necesita el Brevo falso:
 *   node test/fake-brevo.mjs 59111   y en el API: BREVO_API_KEY=xkeysib-falsa BREVO_API_URL=http://localhost:59111/v3/smtp/email
 *   API_URL=… BREVO_FAKE=http://localhost:59111 npx vitest run test/signup-domain.test.ts
 * El primero de la empresa la crea al confirmar su correo; los demás con el mismo dominio se suman al confirmar.
 * Si dos se registran a la vez, el que confirma después se suma a la del primero (la empresa no se parte).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const BREVO = process.env.BREVO_FAKE ?? 'http://localhost:59111';
const run = randomUUID().slice(0, 8);
const domain = `acme-${run}.test`;
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const device = () => ({ deviceId: randomUUID(), name: 'vitest', platform: 'web' as const });

async function call(path: string, body?: unknown, token?: string) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-forwarded-for': ip(), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const signup = (local: string, name: string, extra: Record<string, unknown> = {}) =>
  call('/auth/signup', { name, email: `${local}@${domain}`, password: 'clave-segura-123', orgName: `${name} SAS`, device: device(), ...extra });

/** Token del último correo de confirmación que recibió esa dirección. */
async function linkFor(email: string) {
  for (let i = 0; i < 20; i++) {
    const sent = (await (await fetch(`${BREVO}/sent`)).json()) as any[];
    const m = sent.filter((x) => x.to?.some((t: any) => t.email === email) && x.tags?.includes('signup-confirm')).at(-1);
    if (m) return String(m.textContent.match(/\/confirmar\/([A-Za-z0-9_-]+)/)![1]);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no llegó el correo a ${email}`);
}
const confirm = (token: string) => call('/auth/signup/confirm', { token, device: device() });

describe('registro por empresa con correo corporativo', () => {
  let anaOrg: string;

  it('con correo corporativo la cuenta no nace hasta confirmar el correo', async () => {
    const r = await signup('ana', 'Ana');
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('email_confirm_sent');
    expect(r.json.error.message).toContain(`ana@${domain}`);
    const login = await call('/auth/login', { email: `ana@${domain}`, password: 'clave-segura-123', device: device() });
    expect(login.status).toBe(401);
  });

  it('dos de la misma empresa a la vez: la primera en confirmar la crea y el segundo se suma (no se parte)', async () => {
    const beto = await signup('beto', 'Beto');
    expect(beto.json.error.code).toBe('email_confirm_sent');
    const anaToken = await linkFor(`ana@${domain}`);
    const betoToken = await linkFor(`beto@${domain}`);
    expect((await call(`/auth/signup/confirm/${anaToken}`)).json).toMatchObject({ email: `ana@${domain}`, orgName: 'Ana SAS', joining: false });

    const ana = await confirm(anaToken);
    expect(ana.status).toBe(200);
    anaOrg = ana.json.user.primaryOrgId;
    expect(ana.json.accessToken).toBeTruthy();

    // Beto pidió el enlace antes de que existiera la empresa; al confirmar ya existe y se suma.
    expect((await call(`/auth/signup/confirm/${betoToken}`)).json).toMatchObject({ orgName: 'Ana SAS', joining: true });
    const b = await confirm(betoToken);
    expect(b.status).toBe(200);
    expect(b.json.user.primaryOrgId).toBe(anaOrg);
    const boot = await call('/bootstrap', undefined, b.json.accessToken);
    expect(boot.json.organizations.find((o: any) => o.id === anaOrg)?.name).toBe('Ana SAS');
  });

  it('quien llega después ve a qué empresa entra y se suma al confirmar', async () => {
    const r = await signup('carla', 'Carla', { orgName: 'Otra cosa' });
    expect(r.json.error.code).toBe('email_confirm_sent');
    expect(r.json.error.message).toContain('Ana SAS');
    const token = await linkFor(`carla@${domain}`);
    expect((await call(`/auth/signup/confirm/${token}`)).json).toMatchObject({ orgName: 'Ana SAS', joining: true });
    const c = await confirm(token);
    expect(c.json.user.primaryOrgId).toBe(anaOrg);
    // El enlace es de un solo uso; con la cuenta hecha, entra con su contraseña.
    expect((await confirm(token)).json.error.code).toBe('confirm_used');
    expect((await call('/auth/login', { email: `carla@${domain}`, password: 'clave-segura-123', device: device() })).status).toBe(200);
    expect((await signup('carla', 'Carla')).json.error.code).toBe('conflict');
  });

  it('enlaces inventados o vencidos no sirven', async () => {
    expect((await call('/auth/signup/confirm/abcdefghijklmnopqrstuvwxyz0123')).status).toBe(404);
    expect((await confirm('abcdefghijklmnopqrstuvwxyz0123')).status).toBe(404);
  });

  it('correos personales y con invitación siguen entrando al momento', async () => {
    const personal = await call('/auth/signup', { name: 'Pepe', email: `pepe.${run}@example.com`, password: 'clave-segura-123', orgName: 'Pepe SAS', device: device() });
    expect(personal.status).toBe(200);
    const inv = await call(`/organizations/${personal.json.user.primaryOrgId}/invitations`, {}, personal.json.accessToken);
    const invited = await call('/auth/signup', { name: 'Dora', email: `dora@otra-${run}.test`, password: 'clave-segura-123', orgInviteToken: inv.json.token, device: device() });
    expect(invited.status).toBe(200);
    expect(invited.json.user.primaryOrgId).toBe(personal.json.user.primaryOrgId);
  });
});

describe('registro: empresa opcional con correo corporativo', () => {
  it('el colega no tiene que escribir la empresa; con correo personal sí', async () => {
    const r = await call('/auth/signup', { name: 'Sin Empresa', email: `sinempresa@${domain}`, password: 'clave-segura-123', device: device() });
    expect(r.json.error.code).toBe('email_confirm_sent');
    expect(r.json.error.message).toContain('Ana SAS');
    const personal = await call('/auth/signup', { name: 'Pepa', email: `pepa.${run}@example.com`, password: 'clave-segura-123', device: device() });
    expect(personal.status).toBe(400);
  });
});
