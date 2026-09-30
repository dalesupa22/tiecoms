import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.sleep.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'ios' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const send = (a: Actor, conv: string, body: string, mentions?: unknown[]) =>
  call(`/conversations/${conv}/messages`, { token: a.token, body: { clientMessageId: randomUUID(), body, ...(mentions ? { mentions } : {}) } });

/**
 * Modo sueño (PUT /me/sleep): encendido por defecto 22:00–07:00 America/Bogota, validación,
 * bootstrap me.sleep, horario visible a los contactos (people[].sleep) y la función SQL
 * tiecoms_sleeping que usa el filtro de push (ventanas normales y que cruzan medianoche).
 *   API_URL=http://localhost:3072 DATABASE_URL=… npx vitest run test/sleep.test.ts
 */
import pg from 'pg';
const put = (a: Actor, body: unknown) => call('/me/sleep', { token: a.token, method: 'PUT', body });
let ana: Actor, beto: Actor;
beforeAll(async () => {
  ana = await signup('Ana');
  beto = await signup('Beto', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  await call('/chats', { token: ana.token, body: { userIds: [beto.id] } });
});

describe('modo sueño', () => {
  it('viene encendido por defecto y se ve en el bootstrap', async () => {
    const me = (await call('/bootstrap', { token: beto.token })).json.me;
    expect(me.sleep).toEqual({ on: true, start: '22:00', end: '07:00', tz: 'America/Bogota', tzAuto: true });
    const p = (await call('/bootstrap', { token: ana.token })).json.people.find((x: any) => x.id === beto.id);
    expect(p.sleep).toEqual({ start: '22:00', end: '07:00', tz: 'America/Bogota' });
  });

  it('valida y guarda; la zona fijada a mano deja de ser automática', async () => {
    expect((await put(beto, { start: '25:00' })).status).toBe(400);
    expect((await put(beto, { tz: 'Marte/Olympus' })).status).toBe(400);
    expect((await call('/me/sleep', { method: 'PUT', body: {} })).status).toBe(401);
    expect((await put(beto, { start: '23:30', end: '06:15', tz: 'America/Mexico_City' })).json.sleep)
      .toEqual({ on: true, start: '23:30', end: '06:15', tz: 'America/Mexico_City', tzAuto: false });
    expect((await put(beto, { tz: 'Europe/Madrid', tzAuto: true })).json.sleep.tzAuto).toBe(true);
    expect((await put(beto, { on: false })).json.sleep.on).toBe(false);
    const p = (await call('/bootstrap', { token: ana.token })).json.people.find((x: any) => x.id === beto.id);
    expect(p.sleep).toBeNull();
  });

  it('tiecoms_sleeping: dentro y fuera de la ventana, incluso cruzando medianoche', async () => {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
    await db.connect();
    try {
      const q = async (on: boolean, s: string, e: string) => (await db.query(
        `SELECT tiecoms_sleeping($1, $2::time, $3::time, 'UTC') AS v`, [on, s, e])).rows[0].v;
      const h = new Date().getUTCHours();
      const f = (n: number) => `${String((n + 24) % 24).padStart(2, '0')}:00`;
      expect(await q(true, f(h - 1), f(h + 1))).toBe(true);   // ventana alrededor de ahora (puede cruzar medianoche)
      expect(await q(true, f(h + 1), f(h + 3))).toBe(false);  // más tarde
      expect(await q(true, f(h + 2), f(h - 2))).toBe(false);  // ventana larga que excluye ahora
      expect(await q(true, f(h + 20), f(h + 1))).toBe(true);  // cruza medianoche y cubre ahora
      expect(await q(false, f(h - 1), f(h + 1))).toBe(false); // apagado
      expect(await q(true, '08:00', '08:00')).toBe(false);    // ventana vacía
    } finally { await db.end(); }
  });
});
