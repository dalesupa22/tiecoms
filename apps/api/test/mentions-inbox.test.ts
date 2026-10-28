/**
 * Bandeja «Menciones» para responder desde un solo lugar: answered (ya escribí después o la respondí citándola),
 * pending=1 (solo las sin responder) y q (texto, autor o grupo, sin tildes). Grupo, directo y chat múltiple.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase().replace(/\W/g, '')}.inbox.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'ios' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const mention = (a: Actor, conv: string, before: string, name: string, userId: string, after: string, replyTo?: string) =>
  call(`/conversations/${conv}/messages`, { token: a.token, body: { clientMessageId: randomUUID(), body: `${before}@${name}${after}`, mentions: [{ userId, start: before.length, length: name.length + 1 }], ...(replyTo ? { replyTo } : {}) } });
const say = (a: Actor, conv: string, body: string, replyTo?: string) =>
  call(`/conversations/${conv}/messages`, { token: a.token, body: { clientMessageId: randomUUID(), body, ...(replyTo ? { replyTo } : {}) } });
const inbox = async (a: Actor, qs = '') => (await call(`/mentions${qs}`, { token: a.token })).json;

let ana: Actor, laura: Actor, beto: Actor, groupId: string, dmId: string, multiId: string;

beforeAll(async () => {
  ana = await signup('Ana');
  laura = await signup('Laura Gómez', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  beto = await signup('Beto', (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token);
  groupId = (await call('/chats', { token: ana.token, body: { userIds: [laura.id, beto.id], name: 'Proyecto Cañón' } })).json.id;
  dmId = (await call('/chats', { token: ana.token, body: { userIds: [laura.id] } })).json.id;
  multiId = (await call('/chats', { token: beto.token, body: { userIds: [laura.id, ana.id] } })).json.id;
});

describe('bandeja de menciones para responder', () => {
  it('marca respondida al escribir después o al citarla; pending deja solo las otras', async () => {
    const g = (await mention(ana, groupId, '', 'Laura Gómez', laura.id, ' ¿me revisas la cotización?')).json.message;
    const d = (await mention(ana, dmId, 'Oye ', 'Laura Gómez', laura.id, ' mañana a las 9')).json.message;
    const m = (await mention(beto, multiId, 'Ojo ', 'Laura Gómez', laura.id, ' con el contrato')).json.message;
    let all = await inbox(laura);
    expect(all.mentions.map((x: any) => x.message.id)).toEqual([m.id, d.id, g.id]);
    expect(all.mentions.every((x: any) => x.answered === false)).toBe(true);

    // Respuesta citando el mensaje del grupo; en el directo escribe algo después (sin citar).
    expect((await say(laura, groupId, 'Listo, ya la revisé', g.id)).status).toBe(201);
    expect((await say(laura, dmId, 'Dale')).status).toBe(201);
    all = await inbox(laura);
    expect(Object.fromEntries(all.mentions.map((x: any) => [x.message.id, x.answered]))).toEqual({ [g.id]: true, [d.id]: true, [m.id]: false });
    const pending = await inbox(laura, '?pending=1');
    expect(pending.mentions.map((x: any) => x.message.id)).toEqual([m.id]);
    // Escribir otros (no yo) no cuenta como respondida.
    await say(beto, multiId, 'Laura sigue pendiente');
    expect((await inbox(laura, '?pending=1')).mentions.map((x: any) => x.message.id)).toEqual([m.id]);
  });

  it('q busca sin tildes en el texto, en quién escribió y en el nombre del grupo', async () => {
    expect((await inbox(laura, '?q=cotizacion')).mentions.length).toBe(1);
    expect((await inbox(laura, `?q=${encodeURIComponent('CAÑON')}`)).mentions.length).toBe(1);
    expect((await inbox(laura, '?q=canon')).mentions.length).toBe(1);
    expect((await inbox(laura, '?q=beto')).mentions.length).toBe(1);
    expect((await inbox(laura, '?q=beto&pending=1')).mentions.length).toBe(1);
    expect((await inbox(laura, `?q=${encodeURIComponent('100%')}`)).mentions.length).toBe(0);
    expect((await inbox(laura, '?q=nada-que-ver')).mentions).toEqual([]);
    // Otra persona no ve mis menciones aunque busque lo mismo.
    expect((await inbox(beto, '?q=cotizacion')).mentions).toEqual([]);
  });

  it('valida los parámetros', async () => {
    expect((await call('/mentions?pending=quizas', { token: laura.token })).status).toBe(400);
    expect((await call(`/mentions?q=${'x'.repeat(101)}`, { token: laura.token })).status).toBe(400);
  });
});
