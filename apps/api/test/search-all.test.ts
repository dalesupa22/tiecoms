/** Buscar en todos los chats (GET /search/messages). Necesita el API (API_URL). */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3099';
const run = randomUUID().slice(0, 8);
const word = `presupuéstico${run.slice(0, 4)}`;
interface Actor { token: string; id: string; orgId: string }
async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = {}; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const post = (path: string, token: string, body: unknown = {}) => call(path, { token, body });
const ip = () => `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.sa.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const send = (a: Actor, conv: string, body: string, extra: object = {}) => post(`/conversations/${conv}/messages`, a.token, { clientMessageId: randomUUID(), body, ...extra });
const search = (a: Actor, q: string, before?: string) => call(`/search/messages?q=${encodeURIComponent(q)}${before ? `&before=${encodeURIComponent(before)}` : ''}&limit=2`, { token: a.token });

describe('buscar en todos los chats', () => {
  let ana: Actor, beto: Actor, eva: Actor, c1: string, c2: string, evaChat: string;
  beforeAll(async () => {
    ana = await signup('Ana');
    beto = await signup('Beto', (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token);
    eva = await signup('Eva', (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token);
    c1 = (await post('/chats', ana.token, { userIds: [beto.id], name: `Uno ${run}` })).json.id;
    c2 = (await post('/chats', ana.token, { userIds: [beto.id, eva.id], name: `Dos ${run}` })).json.id;
    evaChat = (await post('/chats', eva.token, { userIds: [beto.id], name: `Sin Ana ${run}` })).json.id;
    await send(ana, c1, `El ${word.toUpperCase()} de Uniandes`);
    await send(beto, c2, `Beto: revisé el ${word} ayer`);
    await send(eva, evaChat, `${word} secreto de Eva y Beto`);
    await send(ana, c2, `${word} una sola vista`, { viewOnce: true });
  });

  it('encuentra en todos mis chats, sin tildes ni mayúsculas, y nada de chats ajenos ni de una sola vista', async () => {
    const r = await call(`/search/messages?q=${encodeURIComponent(word.replace('é', 'e'))}`, { token: ana.token });
    expect(r.status).toBe(200);
    const convs = r.json.results.map((x: any) => x.message.conversationId);
    expect(new Set(convs)).toEqual(new Set([c1, c2]));
    expect(convs).not.toContain(evaChat);
    expect(r.json.results.every((x: any) => !x.message.viewOnce)).toBe(true);
    expect(r.json.results[0].matches.length).toBeGreaterThan(0);
  });

  it('from:Nombre filtra por autor', async () => {
    const r = await search(ana, `${word} from:Beto`);
    expect(r.json.results.map((x: any) => x.message.authorId)).toEqual([beto.id]);
  });

  it('pagina del más nuevo al más viejo', async () => {
    const p1 = await call(`/search/messages?q=${word}&limit=1`, { token: ana.token });
    expect(p1.json.hasMore).toBe(true);
    const p2 = await call(`/search/messages?q=${word}&limit=1&before=${encodeURIComponent(p1.json.results[0].message.createdAt)}`, { token: ana.token });
    expect(p2.json.results[0].message.id).not.toBe(p1.json.results[0].message.id);
  });

  it('pide al menos 2 caracteres', async () => {
    expect((await search(ana, 'a')).status).toBe(400);
  });
});
