/**
 * Título «Empresa - Grupo» de las notificaciones de grupos (groupLabels), con la regla del árbol de Grupos.
 * Necesita el API (API_URL) y la misma base (DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupLabels } from '../src/modules/push.ts';
import { pool } from '../src/db.ts';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 6);
async function call(path: string, token?: string, body?: unknown) {
  const r = await fetch(`${API}/api/v1${path}`, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const signup = async (name: string, extra: object) => {
  const r = await call('/auth/signup', undefined, { name, email: `${name.toLowerCase()}.lbl.${run}@example.com`, password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' }, ...extra });
  return { token: r.accessToken as string, id: r.user.id as string, orgId: r.user.primaryOrgId as string };
};

describe('títulos Empresa - Grupo', () => {
  let ana: Awaited<ReturnType<typeof signup>>, laura: typeof ana, beto: typeof ana;
  const A = `Xertify ${run}`, B = `Estudio Norte ${run}`;
  beforeAll(async () => {
    ana = await signup('Ana', { orgName: A });
    laura = await signup('Laura', { orgInviteToken: (await call(`/organizations/${ana.orgId}/invitations`, ana.token, {})).token });
    beto = await signup('Beto', { orgName: B });
  });
  afterAll(async () => { await pool.end(); });

  it('grupo interno: la empresa propia', async () => {
    const g = await call('/groups', ana.token, { name: 'General', target: { kind: 'org' }, memberIds: [laura.id] });
    const l = await groupLabels(g.conversationId, [ana.id, laura.id]);
    expect(l.get(ana.id)).toBe(`${A} - General`);
    expect(l.get(laura.id)).toBe(`${A} - General`);
  });

  it('relación: cada lado ve a la otra empresa; pendiente usa el nombre de la contraparte', async () => {
    const g = await call('/groups', ana.token, { name: 'Lanzamiento', target: { kind: 'company', companyName: B }, memberIds: [laura.id], shareLink: true });
    expect((await groupLabels(g.conversationId, [ana.id])).get(ana.id)).toBe(`${B} - Lanzamiento`);
    await call(`/invitations/${g.inviteCode}/accept`, beto.token, {});
    const l = await groupLabels(g.conversationId, [ana.id, beto.id]);
    expect(l.get(ana.id)).toBe(`${B} - Lanzamiento`);
    expect(l.get(beto.id)).toBe(`${A} - Lanzamiento`);
  });

  it('directos: sin etiqueta', async () => {
    const dm = await call('/chats', ana.token, { userIds: [laura.id] });
    expect((await groupLabels(dm.id, [ana.id])).size).toBe(0);
  });
});
