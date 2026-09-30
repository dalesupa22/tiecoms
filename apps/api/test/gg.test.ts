/**
 * gg como chat y «Tú» (docs/GG-CHAT.md). Necesita el API (API_URL) y el worker corriendo, con DEEPSEEK_URL apuntando a
 * un modelo falso (test/fake-mail.mjs responde en /llm). No prueba la calidad de las respuestas de DeepSeek.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3099';
const GG = '0a9a9a9a-0000-4000-8000-000000000066';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
const ip = () => `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.gg.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const send = (a: Actor, conv: string, body: string) => post(`/conversations/${conv}/messages`, a.token, { clientMessageId: randomUUID(), body });
const messages = async (a: Actor, conv: string) => (await call(`/conversations/${conv}/messages?limit=100`, { token: a.token })).json.messages as any[];
async function until<T>(fn: () => Promise<T | undefined | false>, what: string, tries = 40): Promise<T> {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(750); }
  throw new Error(`no llegó ${what}`);
}

describe('«Tú» y gg como chat', () => {
  let ana: Actor, beto: Actor;
  beforeAll(async () => {
    ana = await signup('Ana');
    beto = await signup('Beto', (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token);
  });

  it('«Tú»: un directo contigo mismo, uno solo, donde puedes escribir', async () => {
    const a = await post('/me/notes', ana.token);
    const b = await post('/me/notes', ana.token);
    expect(a.json.id).toBe(b.json.id);
    expect((await send(ana, a.json.id, 'Comprar pan')).status).toBeLessThan(300);
    const boot = (await call('/bootstrap', { token: ana.token })).json;
    const self = boot.conversations.find((c: any) => c.id === a.json.id);
    expect(self.kind).toBe('direct');
    expect(self.memberIds).toEqual([ana.id]);
    // Nadie más lo ve.
    expect((await call(`/conversations/${a.json.id}/messages`, { token: beto.token })).status).toBeGreaterThanOrEqual(403);
  });

  it('gg está en el directorio y su chat pide permiso antes de usar IA', async () => {
    const boot = (await call('/bootstrap', { token: ana.token })).json;
    expect(boot.assistantId).toBe(GG);
    expect(boot.people.find((p: any) => p.id === GG)).toMatchObject({ name: 'gg', kind: 'agent' });
    expect(boot.me.aiConsent).toBe(false);
    const chat = (await post('/assistant/chat', ana.token)).json.id;
    await send(ana, chat, 'hola gg');
    const m = await until(async () => (await messages(ana, chat)).find((x) => x.authorId === GG), 'el aviso de permiso');
    expect(m.body).toContain('Autorizar gg');
  });

  it('con permiso, gg responde en su chat y el historial queda guardado', async () => {
    expect((await post('/assistant/consent', ana.token, { on: true })).json).toEqual({ aiConsent: true });
    expect((await call('/bootstrap', { token: ana.token })).json.me.aiConsent).toBe(true);
    const chat = (await post('/assistant/chat', ana.token)).json.id;
    const before = (await messages(ana, chat)).filter((x) => x.authorId === GG).length;
    await send(ana, chat, 'Ayúdame a responder a Jorge');
    await until(async () => (await messages(ana, chat)).filter((x) => x.authorId === GG).length > before, 'la respuesta de gg');
    const all = await messages(ana, chat);
    expect(all.filter((x) => x.authorId === ana.id).map((x) => x.body)).toContain('Ayúdame a responder a Jorge');
  });

  it('@gg en un grupo: responde ahí, citando la pregunta', async () => {
    const group = (await post('/chats', ana.token, { userIds: [beto.id], name: `Equipo ${run}` })).json.id;
    await send(ana, group, 'sin mención no respondo');
    const q = (await send(ana, group, '@gg resume lo que hablamos')).json.message;
    const r = await until(async () => (await messages(beto, group)).find((x) => x.authorId === GG), 'la respuesta en el grupo');
    expect(r.replyTo).toBe(q.id);
    // Solo respondió una vez (al mensaje con @gg).
    await sleep(1500);
    expect((await messages(beto, group)).filter((x) => x.authorId === GG)).toHaveLength(1);
  });

  it('@gg de quien no autorizó: gg le pide el permiso', async () => {
    const group = (await post('/chats', beto.token, { userIds: [ana.id], name: `Beto ${run}` })).json.id;
    await send(beto, group, 'oye @gg ayuda');
    const r = await until(async () => (await messages(ana, group)).find((x) => x.authorId === GG), 'el aviso a Beto');
    expect(r.body).toContain('permiso');
  });

  it('no se confirma una acción ajena ni en un mensaje que no es de gg', async () => {
    const chat = (await post('/assistant/chat', ana.token)).json.id;
    const mine = (await send(ana, chat, 'nota')).json.message;
    expect((await post('/assistant/actions/discard', beto.token, { messageId: mine.id, actionId: 'x' })).status).toBe(404);
  });
});
