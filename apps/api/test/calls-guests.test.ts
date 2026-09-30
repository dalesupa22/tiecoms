/**
 * Invitados por enlace (proveedor falso: CALLS_ENABLED=true CALLS_PROVIDER=fake).
 * Quien está en la llamada crea el enlace; un tercero sin cuenta ve la llamada, entra con su nombre, late y sale.
 * El enlace no sirve a quien no está dentro, ni quitado, ni con la llamada terminada; los invitados no la sostienen.
 * «Nueva llamada» (POST /calls/instant): conversación de reunión + llamada + enlace; el invitado entra con nombre y correo.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'x-forwarded-for': ip(), ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const post = (path: string, token: string, body: unknown = {}) => call(path, { token, body });
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const r = await call('/auth/signup', { body: {
    name, email: `${name.toLowerCase()}.invitado.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken, id: r.json.user.id, orgId: r.json.user.primaryOrgId };
}

describe('invitados por enlace', () => {
  let ana: Actor, beto: Actor, chatId: string, callId: string, token: string;
  beforeAll(async () => {
    ana = await signup('Ana');
    beto = await signup('Beto', (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token);
    chatId = (await post('/chats', ana.token, { userIds: [beto.id], name: 'Con clientes' })).json.id;
  });

  it('solo quien está dentro crea el enlace', async () => {
    const start = await post(`/conversations/${chatId}/call`, ana.token, { kind: 'video' });
    expect(start.status).toBe(200);
    callId = start.json.call.id;
    expect((await post(`/calls/${callId}/link`, beto.token)).json.error.code).toBe('not_in_call');
    const link = await post(`/calls/${callId}/link`, ana.token);
    expect(link.status).toBe(200);
    expect(link.json.url).toMatch(/\/llamada\/[A-Za-z0-9_-]{16,}$/);
    token = link.json.token;
  });

  it('el tercero ve la llamada, entra con su nombre y todos lo ven', async () => {
    const pv = await call(`/call-links/${token}`);
    expect(pv.status).toBe(200);
    expect(pv.json).toMatchObject({ title: 'Con clientes', hostName: 'Ana', kind: 'video', active: true });
    expect(pv.json.conversationId).toBeUndefined();
    expect((await call('/call-links/no-existe-este-token-123')).status).toBe(404);

    const j = await call(`/call-links/${token}/join`, { body: { name: '  Laura (cliente)  ', email: ' Laura.Cliente@Example.COM ' } });
    expect(j.status).toBe(200);
    expect(j.json.attendee.Attendee.ExternalUserId).toBe(`guest:${j.json.guestId}`);
    expect(j.json.call.guests).toEqual([{ id: j.json.guestId, name: 'Laura (cliente)' }]);
    expect(j.json.call.names[ana.id]).toBe('Ana');

    // Los de chaggu ven también el correo (en minúsculas); el invitado no (arriba).
    const active = await call(`/conversations/${chatId}/call`, { token: ana.token });
    expect(active.json.call.guests).toEqual([{ id: j.json.guestId, name: 'Laura (cliente)', email: 'laura.cliente@example.com' }]);

    const hb = await call(`/call-guests/${j.json.guestId}/heartbeat`, { body: { secret: j.json.secret } });
    expect(hb.status).toBe(200);
    expect(hb.json.activeUserIds).toEqual([ana.id]);
    expect((await call(`/call-guests/${j.json.guestId}/heartbeat`, { body: { secret: 'x'.repeat(32) } })).status).toBe(404);

    expect((await call(`/call-guests/${j.json.guestId}/leave`, { body: { secret: j.json.secret } })).status).toBe(200);
    expect((await call(`/conversations/${chatId}/call`, { token: ana.token })).json.call.guests).toBeUndefined();
  });

  it('un enlace quitado ya no deja entrar', async () => {
    expect((await call(`/calls/${callId}/link`, { method: 'DELETE', token: ana.token })).status).toBe(200);
    const j = await call(`/call-links/${token}/join`, { body: { name: 'Otro', email: 'otro@example.com' } });
    expect(j.json.error.code).toBe('link_revoked');
    expect((await call(`/call-links/${token}`)).json.active).toBe(false);
  });

  it('los invitados no sostienen la llamada: si sale el último de chaggu, termina y el enlace muere', async () => {
    const t2 = (await post(`/calls/${callId}/link`, ana.token)).json.token;
    const g = (await call(`/call-links/${t2}/join`, { body: { name: 'Pedro', email: 'pedro@example.com' } })).json;
    expect(g.guestId).toBeTruthy();
    await post(`/calls/${callId}/leave`, ana.token);
    const hb = await call(`/call-guests/${g.guestId}/heartbeat`, { body: { secret: g.secret } });
    expect(hb.json.error.code).toBe('not_in_call');
    // Terminada: el enlace solo vivía durante la llamada (410 call_ended al verlo y al entrar).
    const late = await call(`/call-links/${t2}/join`, { body: { name: 'Tarde', email: 'tarde@example.com' } });
    expect(late.status).toBe(410);
    expect(late.json.error.code).toBe('call_ended');
    const pv = await call(`/call-links/${t2}`);
    expect(pv.status).toBe(410);
    expect(pv.json.error.code).toBe('call_ended');
  });
});

describe('«Nueva llamada» con enlace (POST /calls/instant)', () => {
  let dani: Actor, colega: Actor, extra: Actor, inst: any;
  beforeAll(async () => {
    dani = await signup('Dani');
    colega = await signup('Colega', (await post(`/organizations/${dani.orgId}/invitations`, dani.token)).json.token);
    extra = await signup('Extra');
  });

  it('crea la conversación de reunión, la llamada ya iniciada con quien la pide y el enlace', async () => {
    const r = await post('/calls/instant', dani.token, {});
    expect(r.status).toBe(201);
    inst = r.json;
    expect(inst.conversationId).toBeTruthy();
    expect(inst.call).toMatchObject({ conversationId: inst.conversationId, kind: 'audio', startedBy: dani.id, endedAt: null, activeUserIds: [dani.id] });
    expect(inst.call.myDevices).toEqual([]);
    expect(inst.link.url).toMatch(new RegExp(`/llamada/${inst.link.token}$`));
    // Nombre por defecto y marcada como reunión; no le suena a nadie ni aparece para los colegas.
    const boot = (await call('/bootstrap', { token: dani.token })).json;
    const conv = boot.conversations.find((c: any) => c.id === inst.conversationId);
    expect(conv).toMatchObject({ name: 'Llamada de Dani', kind: 'multi', meeting: true, memberIds: [dani.id] });
    expect((await call('/bootstrap', { token: colega.token })).json.conversations.some((c: any) => c.id === inst.conversationId)).toBe(false);
    // El enlace funciona de una vez.
    const pv = await call(`/call-links/${inst.link.token}`);
    expect(pv.json).toMatchObject({ title: 'Llamada de Dani', hostName: 'Dani', kind: 'audio', active: true });
  });

  it('con título y video; título de más de 80 no', async () => {
    const r = await post('/calls/instant', colega.token, { title: '  Demo con el cliente  ', video: true });
    expect(r.status).toBe(201);
    expect(r.json.call.kind).toBe('video');
    expect((await call(`/call-links/${r.json.link.token}`)).json.title).toBe('Demo con el cliente');
    expect((await post('/calls/instant', colega.token, { title: 'x'.repeat(81) })).status).toBe(400);
    await post(`/calls/${r.json.call.id}/end`, colega.token);
  });

  it('el cliente entra con el flujo normal y queda un solo dispositivo', async () => {
    const j = await post(`/conversations/${inst.conversationId}/call`, dani.token, { kind: 'audio', deviceKey: 'webtest1' });
    expect(j.status).toBe(200);
    expect(j.json.call.id).toBe(inst.call.id);
    expect(j.json.call.activeUserIds).toEqual([dani.id]);
    expect(j.json.call.myDevices.map((x: any) => x.deviceKey)).toEqual(['webtest1']);
    expect(j.json.attendee.Attendee.ExternalUserId).toBe(`${dani.id}#webtest1`);
  });

  it('el invitado necesita un correo válido', async () => {
    const path = `/call-links/${inst.link.token}/join`;
    const none = await call(path, { body: { name: 'Sin correo' } });
    expect(none.status).toBe(400);
    expect(none.json.error.code).toBe('email_required');
    const blank = await call(path, { body: { name: 'Vacío', email: '   ' } });
    expect(blank.json.error.code).toBe('email_required');
    for (const email of ['no-es-correo', 'a@b', 'a b@c.com', '@x.com']) {
      const bad = await call(path, { body: { name: 'Malo', email } });
      expect(bad.status, email).toBe(400);
      expect(bad.json.error.code, email).toBe('invalid_email');
    }
  });

  it('el correo se guarda y solo lo ven los de chaggu de la llamada', async () => {
    const j = await call(`/call-links/${inst.link.token}/join`, { body: { name: 'Marta', email: 'MARTA@Cliente.co' } });
    expect(j.status).toBe(200);
    expect(j.json.call.guests).toEqual([{ id: j.json.guestId, name: 'Marta' }]);
    expect(JSON.stringify(j.json)).not.toContain('marta@cliente.co');
    const hb = await call(`/call-guests/${j.json.guestId}/heartbeat`, { body: { secret: j.json.secret } });
    expect(JSON.stringify(hb.json)).not.toContain('marta@cliente.co');
    const mine = await call(`/conversations/${inst.conversationId}/call`, { token: dani.token });
    expect(mine.json.call.guests).toEqual([{ id: j.json.guestId, name: 'Marta', email: 'marta@cliente.co' }]);
    const act = (await call('/calls/active', { token: dani.token })).json.calls.find((x: any) => x.call.id === inst.call.id);
    expect(act.call.guests[0].email).toBe('marta@cliente.co');
    // Quien no está en la conversación no ve la llamada (ni el correo).
    expect((await call(`/conversations/${inst.conversationId}/call`, { token: extra.token })).status).toBe(404);
    expect((await call('/calls/active', { token: colega.token })).json.calls.some((x: any) => x.call.id === inst.call.id)).toBe(false);
  });

  it('al terminar, el enlace muere (410) y la conversación vacía sale de la bandeja; el historial trae el título', async () => {
    await post(`/calls/${inst.call.id}/leave`, dani.token, { deviceKey: 'webtest1' });
    const pv = await call(`/call-links/${inst.link.token}`);
    expect(pv.status).toBe(410);
    expect(pv.json.error.code).toBe('call_ended');
    const j = await call(`/call-links/${inst.link.token}/join`, { body: { name: 'Tarde', email: 'tarde@example.com' } });
    expect(j.status).toBe(410);
    expect(j.json.error.code).toBe('call_ended');
    const boot = (await call('/bootstrap', { token: dani.token })).json;
    expect(boot.conversations.some((c: any) => c.id === inst.conversationId)).toBe(false);
    const hist = (await call('/calls', { token: dani.token })).json.calls.find((x: any) => x.call.id === inst.call.id);
    expect(hist).toMatchObject({ title: 'Llamada de Dani', meeting: true });
  });

  it('si alguien escribe en ella, vuelve a aparecer como un chat más', async () => {
    const m = await post(`/conversations/${inst.conversationId}/messages`, dani.token, { body: 'Notas de la llamada', clientMessageId: randomUUID() });
    expect(m.status).toBeLessThan(300);
    const boot = (await call('/bootstrap', { token: dani.token })).json;
    expect(boot.conversations.find((c: any) => c.id === inst.conversationId)).toMatchObject({ meeting: true });
  });
});
