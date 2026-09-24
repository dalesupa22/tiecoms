/**
 * Chats grupales entre personas de distintas empresas y vista previa de enlaces.
 * Necesita el API (API_URL) y su worker corriendo.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPreview, firstUrl, isPublicIp, parseMeta } from '../src/modules/link-preview.ts';

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
async function signup(name: string, orgInviteToken?: string) {
  const r = await call('/auth/signup', { body: {
    name, ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }), email: `${name.toLowerCase()}.chats.${run}@example.com`,
    password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken as string, id: r.json.user.id as string, orgId: r.json.user.primaryOrgId as string };
}

describe('lector de enlaces', () => {
  it('toma el primer enlace sin la puntuación final', () => {
    expect(firstUrl('mira https://tiecoms.com/c/123, ¿sí?')).toBe('https://tiecoms.com/c/123');
    expect(firstUrl('(ver https://es.wikipedia.org/wiki/Bogot%C3%A1_(ciudad))')).toBe('https://es.wikipedia.org/wiki/Bogot%C3%A1_(ciudad)');
    expect(firstUrl('sin enlace')).toBeNull();
    expect(firstUrl('javascript:alert(1)')).toBeNull();
  });
  it('no deja pasar direcciones internas', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) expect(isPublicIp(ip)).toBe(false);
    expect(isPublicIp('34.195.54.159')).toBe(true);
    for (const u of ['http://127.0.0.1/', 'http://localhost:3020/api/health/live', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://example.com:22/']) {
      await expect(buildPreview(u)).rejects.toThrow();
    }
  });
  it('lee Open Graph con comillas simples, entidades y título de respaldo', () => {
    const m = parseMeta(`<html><head><title>Respaldo &amp; más</title>
      <meta property='og:title' content='Hola &quot;TieComs&quot;'><meta name="description" content="Una red &#x2014; entre empresas">
      <meta property="og:image" content="/img/c.png"></head></html>`);
    expect(m).toMatchObject({ title: 'Hola "TieComs"', description: 'Una red — entre empresas', image: '/img/c.png' });
    expect(parseMeta('<title>Solo título</title>').title).toBe('Solo título');
  });
  it('arma la vista previa de una página real', async () => {
    const p = await buildPreview('https://github.com/');
    expect(p?.title).toBeTruthy();
    expect(p?.siteName).toBeTruthy();
  }, 20_000);
});

describe('chats grupales', () => {
  let ana: Awaited<ReturnType<typeof signup>>, laura: typeof ana, mateo: typeof ana, extraño: typeof ana;
  beforeAll(async () => {
    ana = await signup('Ana');
    const inv = await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} });
    laura = await signup('Laura', inv.json.token);           // misma empresa que Ana
    mateo = await signup('Mateo');                           // otra empresa, comparte un espacio
    extraño = await signup('Pedro');                         // nadie lo conoce
    const ws = await call('/workspaces', { token: ana.token, body: { name: `Proyecto ${run}` } });
    const wi = await call(`/workspaces/${ws.json.id}/invitations`, { token: ana.token, body: { role: 'member', conversationIds: [] } });
    expect((await call(`/invitations/${wi.json.token}/accept`, { token: mateo.token, body: {} })).status).toBe(200);
  });

  it('con una persona abre (y reutiliza) el directo, también con colegas de la empresa', async () => {
    const a = await call('/chats', { token: ana.token, body: { userIds: [laura.id] } });
    expect(a.json.kind).toBe('direct');
    const b = await call('/chats', { token: laura.token, body: { userIds: [ana.id] } });
    expect(b.json.id).toBe(a.json.id);
  });

  it('crea un chat entre personas de dos empresas y todas lo ven', async () => {
    const r = await call('/chats', { token: ana.token, body: { userIds: [laura.id, mateo.id], name: 'Lanzamiento' } });
    expect(r.status).toBe(200);
    expect(r.json.kind).toBe('multi');
    for (const who of [ana, laura, mateo]) {
      const b = await call('/bootstrap', { token: who.token });
      const c = b.json.conversations.find((x: any) => x.id === r.json.id);
      expect(c).toMatchObject({ kind: 'multi', name: 'Lanzamiento', workspaceId: null });
      expect(c.memberIds.sort()).toEqual([ana.id, laura.id, mateo.id].sort());
    }
    // Mateo ve a Laura (y su empresa) aunque no compartan espacio: están en el mismo chat.
    const mb = await call('/bootstrap', { token: mateo.token });
    expect(mb.json.people.some((p: any) => p.id === laura.id)).toBe(true);
    const sent = await call(`/conversations/${r.json.id}/messages`, { token: mateo.token, body: { clientMessageId: randomUUID(), body: 'Hola equipo' } });
    expect(sent.status).toBe(201);
  });

  it('no se puede meter a quien no conoces', async () => {
    expect((await call('/chats', { token: ana.token, body: { userIds: [laura.id, extraño.id] } })).status).toBe(403);
    const r = await call('/chats', { token: ana.token, body: { userIds: [laura.id, mateo.id] } });
    expect((await call(`/conversations/${r.json.id}/members`, { token: ana.token, body: { userIds: [extraño.id], history: 'now' } })).status).toBe(403);
    // Un chat grupal nuevo nunca reutiliza otro, aunque tenga las mismas personas.
    const again = await call('/chats', { token: ana.token, body: { userIds: [laura.id, mateo.id] } });
    expect(again.json.id).not.toBe(r.json.id);
    // Se puede salir de un chat grupal.
    expect((await call(`/conversations/${r.json.id}/members/${laura.id}`, { token: laura.token, method: 'DELETE' })).status).toBe(200);
  });

  it('un mensaje con enlace recibe su vista previa', async () => {
    const r = await call('/chats', { token: ana.token, body: { userIds: [laura.id, mateo.id] } });
    const sent = await call(`/conversations/${r.json.id}/messages`, { token: ana.token, body: { clientMessageId: randomUUID(), body: 'Miren esto https://github.com/' } });
    expect(sent.json.message.linkPreview ?? null).toBeNull();
    let preview: any = null;
    for (let i = 0; i < 40 && !preview; i++) {
      await new Promise((res) => setTimeout(res, 500));
      const page = await call(`/conversations/${r.json.id}/messages`, { token: mateo.token });
      preview = page.json.messages.find((m: any) => m.id === sent.json.message.id)?.linkPreview ?? null;
    }
    expect(preview?.title).toBeTruthy();
    expect(preview.url).toMatch(/^https:\/\/github\.com/);
  }, 30_000);
});
