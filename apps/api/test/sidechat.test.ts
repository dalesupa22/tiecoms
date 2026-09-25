/**
 * Sidechats: push del mensaje con la forma nueva (type 'side', TC_SIDE, sideOf) y resumen sugerido para
 * «Llevar al hilo» (POST /conversations/:sideId/return/suggest) con DeepSeek falso y con respaldo.
 * API + worker con los falsos de push (FAKE_PUSH_URL) y de DeepSeek (FAKE_VOICE_URL).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const FAKE_PUSH = process.env.FAKE_PUSH_URL ?? 'http://localhost:59045';
const FAKE_AI = process.env.FAKE_VOICE_URL ?? 'http://127.0.0.1:59048';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.sc.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'ios' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const send = (a: Actor, conv: string, body: string) => call(`/conversations/${conv}/messages`, { token: a.token, body: { clientMessageId: randomUUID(), body } });
const pushes = async () => (await (await fetch(`${FAKE_PUSH}/sent`)).json()) as any[];

let ana: Actor, laura: Actor, beto: Actor, generalId: string, anchorId: string, sideId: string;

beforeAll(async () => {
  ana = await signup('Ana');
  laura = await signup('Laura', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  beto = await signup('Beto');
  const ws = await call('/workspaces', { token: ana.token, body: { name: `Sidechats ${run}` } });
  generalId = ws.json.generalConversationId;
  const inv = await call(`/workspaces/${ws.json.id}/invitations`, { token: ana.token, body: { role: 'member', conversationIds: [generalId] } });
  await call(`/invitations/${inv.json.token}/accept`, { token: beto.token, body: {} });
  anchorId = (await send(beto, generalId, '¿Qué penalidad aplicamos si el proveedor de logística entrega tarde el lote de octubre?')).json.message.id;
});

describe('sidechats', () => {
  it('el push de la pregunta llega como sidechat (APNs y FCM)', async () => {
    const apns = `apns-laura-side-${run}`, fcm = `fcm-laura-side-${run}`;
    await call('/push/token', { token: laura.token, method: 'PUT', body: { provider: 'apns', token: apns } });
    const l2 = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email: `laura.sc.${run}@example.com`, password: 'clave-segura-123', device: { deviceId: randomUUID(), name: 'android', platform: 'android' } }) });
    await call('/push/token', { token: ((await l2.json()) as any).accessToken, method: 'PUT', body: { provider: 'fcm', token: fcm } });
    const r = await call(`/conversations/${generalId}/side`, { token: ana.token, body: { messageId: anchorId, userIds: [laura.id], question: 'Laura, ¿qué cláusula aplica aquí?' } });
    expect(r.status).toBe(200);
    sideId = r.json.id;
    let a: any = null, f: any = null;
    for (let i = 0; i < 40 && !(a && f); i++) {
      await sleep(300);
      const all = await pushes();
      a ??= all.find((p) => p.token === apns && p.body.conversationId === sideId);
      f ??= all.find((p) => p.token === fcm && p.body.message.data.conversationId === sideId);
    }
    expect(a.body).toMatchObject({
      type: 'side', conversationId: sideId, authorId: ana.id, authorName: 'Ana',
      sideOf: { conversationId: generalId, messageId: anchorId },
      aps: { category: 'TC_SIDE', 'thread-id': sideId, alert: { title: '💬 Sidechat de Ana', body: 'Laura, ¿qué cláusula aplica aquí?' } },
    });
    expect(a.body.aps.alert.subtitle).toMatch(/^Sobre: «¿Qué penalidad aplicamos si/);
    expect(a.body.sideOf.excerpt.length).toBeLessThanOrEqual(60);
    const d = f.body.message.data;
    expect(d).toMatchObject({ type: 'side', category: 'TC_SIDE', title: '💬 Sidechat de Ana', sideOfConversationId: generalId, sideOfMessageId: anchorId });
    expect(JSON.parse(d.sideOf)).toMatchObject({ conversationId: generalId, messageId: anchorId });
    expect(Object.values(d).every((v) => typeof v === 'string')).toBe(true);
    // Las respuestas en el sidechat siguen con la misma forma (Ana recibe la de Laura).
    const anaApns = `apns-ana-side-${run}`;
    await call('/push/token', { token: ana.token, method: 'PUT', body: { provider: 'apns', token: anaApns, lang: 'en' } });
    const reply = (await send(laura, sideId, 'La cláusula 4, tope del 10 %.')).json.message;
    let b: any = null;
    for (let i = 0; i < 40 && !b; i++) { await sleep(300); b = (await pushes()).find((p) => p.token === anaApns && p.body.messageId === reply.id); }
    expect(b.body.aps.alert).toMatchObject({ title: '💬 Sidechat from Laura', body: 'La cláusula 4, tope del 10 %.' });
    expect(b.body.aps.alert.subtitle).toMatch(/^About: «/);
  });

  it('return/suggest: resumen de DeepSeek con contexto, respaldo si falla, y solo miembros', async () => {
    const r = await call(`/conversations/${sideId}/return/suggest`, { token: ana.token, body: {} });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ summary: 'Lo consulté: aplica la cláusula 4 con tope del 10 %.', source: 'ai' });
    const llm = ((await (await fetch(`${FAKE_AI}/sent`)).json()) as any[]).filter((x) => x.kind === 'llm').at(-1);
    const sys = llm.messages.find((m: any) => m.role === 'system').content;
    expect(sys).toContain('Quien publicará el resumen en el grupo: Ana');
    expect(sys).toContain('(de Beto)');
    expect(sys).toContain('Grupo: General');
    expect(llm.messages.find((m: any) => m.role === 'user').content).toContain('Laura: La cláusula 4, tope del 10 %.');
    await fetch(`${FAKE_AI}/fail-llm`, { method: 'POST' });
    const fb = await call(`/conversations/${sideId}/return/suggest`, { token: ana.token, body: {} });
    expect(fb.json).toEqual({ summary: 'La cláusula 4, tope del 10 %.', source: 'fallback' });
    expect((await call(`/conversations/${sideId}/return/suggest`, { token: beto.token, body: {} })).status).toBe(404);
    expect((await call(`/conversations/${generalId}/return/suggest`, { token: ana.token, body: {} })).status).toBe(400);
    // Sugerir no publica nada.
    const last = (await call(`/conversations/${generalId}/messages`, { token: beto.token })).json.messages.at(-1);
    expect(last.id).toBe(anchorId);
  });
});
