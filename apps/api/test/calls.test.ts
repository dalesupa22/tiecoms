/**
 * Llamadas (Chime SDK) con el proveedor falso: API con CALLS_ENABLED=true y CALLS_PROVIDER=fake.
 * Empezar y entrar a la misma llamada, aviso «te están llamando», transcripción que se prende y apaga,
 * frases deduplicadas, colgar y leer la transcripción; nadie de afuera la ve.
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const post = (path: string, token: string, body: unknown = {}) => call(path, { token, body });
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.llamada.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}

describe('llamadas', () => {
  let ana: Actor, beto: Actor, extra: Actor, chatId: string, socket: Socket;
  const account: any[] = [];
  const conv: any[] = [];
  beforeAll(async () => {
    ana = await signup('Ana');
    beto = await signup('Beto', (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token);
    extra = await signup('Extra');
    chatId = (await post('/chats', ana.token, { userIds: [beto.id], name: 'Llamada' })).json.id;
    socket = await new Promise((res, rej) => {
      const s = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: beto.token } });
      s.on('account.event', (e) => account.push(e));
      s.on('conv.event', (e) => conv.push(e));
      s.once('ready', () => res(s)); s.once('connect_error', rej);
    });
  });
  afterAll(() => socket?.disconnect());

  async function waitFor<T>(fn: () => T | undefined, what: string): Promise<T> {
    for (let i = 0; i < 40; i++) { const v = fn(); if (v) return v; await sleep(150); }
    throw new Error(`no llegó ${what}`);
  }

  let callId: string;
  it('el bootstrap dice que las llamadas están prendidas', async () => {
    const b = await call('/bootstrap', { token: ana.token });
    expect(b.status, JSON.stringify(b.json).slice(0, 300)).toBe(200);
    expect(b.json.features).toMatchObject({ calls: true });
  });

  it('Ana llama: recibe reunión y attendee; a Beto le suena', async () => {
    const r = await post(`/conversations/${chatId}/call`, ana.token, { kind: 'video' });
    expect(r.status).toBe(200);
    expect(r.json.meeting.Meeting.MeetingId).toMatch(/^fake-/);
    expect(r.json.attendee.Attendee).toMatchObject({ ExternalUserId: ana.id });
    expect(r.json.attendee.Attendee.JoinToken).toBeTruthy();
    expect(r.json.call).toMatchObject({ kind: 'video', startedBy: ana.id, activeUserIds: [ana.id], transcribing: false, endedAt: null });
    callId = r.json.call.id;
    const ring = await waitFor(() => account.find((e) => e.type === 'call.ringing' && e.call.id === callId), 'call.ringing');
    expect(ring).toMatchObject({ callerName: 'Ana', conversationTitle: 'Llamada' });
  });

  it('Beto entra a la misma reunión; alguien de afuera no puede', async () => {
    const r = await post(`/conversations/${chatId}/call`, beto.token, { kind: 'audio' });
    expect(r.json.call.id).toBe(callId);
    expect(r.json.call.kind).toBe('video');
    expect(r.json.call.activeUserIds.sort()).toEqual([ana.id, beto.id].sort());
    expect((await post(`/calls/${callId}/join`, extra.token)).status).toBe(404);
    expect((await call(`/calls/${callId}/transcript`, { token: extra.token })).status).toBe(404);
    const active = await call(`/conversations/${chatId}/call`, { token: beto.token });
    expect(active.json.call.id).toBe(callId);
    expect((await post(`/calls/${callId}/heartbeat`, beto.token)).json).toEqual({ ok: true });
  });

  it('con la transcripción apagada no se guardan frases; al prenderla sí, sin duplicados', async () => {
    const seg = { resultId: 'r1', externalUserId: ana.id, language: 'es-US', text: 'Hola Beto, revisemos el contrato', startMs: 1000, endMs: 3200 };
    expect((await post(`/calls/${callId}/transcript`, ana.token, { segments: [seg] })).status).toBe(400);
    const on = await post(`/calls/${callId}/transcription`, ana.token, { on: true });
    expect(on.json.call.transcribing).toBe(true);
    await waitFor(() => conv.find((e) => e.type === 'call.updated' && e.call.transcribing), 'call.updated transcribing');
    // Ambos reportan la misma frase (los dos la reciben del SDK): queda una.
    expect((await post(`/calls/${callId}/transcript`, ana.token, { segments: [seg] })).json).toEqual({ saved: 1 });
    expect((await post(`/calls/${callId}/transcript`, beto.token, { segments: [seg, { resultId: 'r2', externalUserId: beto.id, text: 'Listo, lo firmo hoy', startMs: 3500, endMs: 4800 }] })).json).toEqual({ saved: 1 });
    // Un externalUserId que no está en la llamada no se atribuye a nadie.
    await post(`/calls/${callId}/transcript`, beto.token, { segments: [{ resultId: 'r3', externalUserId: extra.id, text: 'ruido', startMs: 5000, endMs: 5100 }] });
    const off = await post(`/calls/${callId}/transcription`, beto.token, { on: false });
    expect(off.json.call.transcribing).toBe(false);
    // Las últimas frases llegan unos segundos después de apagar.
    expect((await post(`/calls/${callId}/transcript`, ana.token, { segments: [{ resultId: 'r4', externalUserId: ana.id, text: 'Gracias', startMs: 6000, endMs: 6500 }] })).json).toEqual({ saved: 1 });
  });

  it('al colgar el último, la llamada termina y queda la transcripción para leer', async () => {
    await post(`/calls/${callId}/leave`, ana.token);
    const r = await post(`/calls/${callId}/leave`, beto.token);
    expect(r.json.call.endedAt).toBeTruthy();
    expect(r.json.call.hasTranscript).toBe(true);
    expect((await call(`/conversations/${chatId}/call`, { token: ana.token })).json.call).toBeNull();
    const t = await call(`/calls/${callId}/transcript`, { token: beto.token });
    expect(t.json.segments.map((s: any) => [s.speakerName, s.text])).toEqual([
      ['Ana', 'Hola Beto, revisemos el contrato'], ['Beto', 'Listo, lo firmo hoy'], [null, 'ruido'], ['Ana', 'Gracias'],
    ]);
    const msgs = await call(`/conversations/${chatId}/messages?limit=20`, { token: ana.token });
    const sysKeys = (msgs.json.messages ?? msgs.json.items ?? []).filter((m: any) => m.kind === 'system').map((m: any) => JSON.parse(m.body).k);
    expect(sysKeys).toEqual(expect.arrayContaining(['call.started', 'call.transcription.on', 'call.transcription.off', 'call.ended', 'call.transcript']));
    expect((await post(`/calls/${callId}/transcription`, ana.token, { on: true })).status).toBe(409);
  });

  it('MCP: list_calls y read_call_transcript leen la llamada con los permisos de la persona', async () => {
    const mcp = async (token: string, name: string, args: unknown) => {
      const res = await fetch(`${API}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      return ((await res.json()) as any).result;
    };
    const tBeto = (await post('/me/mcp-tokens', beto.token, {})).json.token;
    const tExtra = (await post('/me/mcp-tokens', extra.token, {})).json.token;
    const list = await mcp(tBeto, 'list_calls', { chat: chatId });
    expect(list.structuredContent.calls[0]).toMatchObject({ call_id: callId, hasTranscript: true });
    const msgs = await mcp(tBeto, 'read_messages', { chat: chatId });
    expect(msgs.structuredContent.messages.some((m: any) => m.text.includes(`call_id ${callId}`))).toBe(true);
    const byId = await mcp(tBeto, 'read_call_transcript', { call_id: callId });
    expect(byId.structuredContent.transcript).toContain('Beto: Listo, lo firmo hoy');
    expect((await mcp(tBeto, 'read_call_transcript', { chat: chatId })).structuredContent.call_id).toBe(callId);
    expect((await mcp(tExtra, 'read_call_transcript', { call_id: callId })).isError).toBe(true);
    expect((await mcp(tExtra, 'list_calls', {})).structuredContent.calls.some((c: any) => c.call_id === callId)).toBe(false);
  });

  it('una llamada nueva en la misma conversación es otra llamada', async () => {
    const r = await post(`/conversations/${chatId}/call`, beto.token, {});
    expect(r.json.call.id).not.toBe(callId);
    expect(r.json.call.kind).toBe('audio');
    const end = await post(`/calls/${r.json.call.id}/end`, ana.token);
    expect(end.json.call.endedAt).toBeTruthy();
    expect(end.json.call.hasTranscript).toBe(false);
  });

  it('historial: las dos llamadas, con quién y cuánto duró; nadie de afuera las ve', async () => {
    const h = await call('/calls?limit=10', { token: beto.token });
    expect(h.status).toBe(200);
    const mine = h.json.calls.filter((x: any) => x.call.conversationId === chatId);
    expect(mine).toHaveLength(2);
    const first = mine.find((x: any) => x.call.id === callId);
    expect(first.participantIds).toEqual([ana.id, beto.id]);
    expect(first.durationSec).toBeGreaterThanOrEqual(0);
    expect(first.call.hasTranscript).toBe(true);
    expect((await call('/calls?limit=10', { token: extra.token })).json.calls.some((x: any) => x.call.conversationId === chatId)).toBe(false);
  });

  it('compartir la transcripción en otro chat sale como mensaje mío; sin acceso al destino, no', async () => {
    const other = (await post('/chats', ana.token, { userIds: [beto.id], name: 'Otro chat' })).json.id;
    const r = await post(`/calls/${callId}/share`, ana.token, { conversationId: other, what: 'transcript' });
    expect(r.status).toBe(200);
    expect(r.json.message.authorId).toBe(ana.id);
    expect(r.json.message.body).toContain('Transcripción:');
    expect(r.json.message.body).toContain('Ana: Hola Beto, revisemos el contrato');
    expect((await post(`/calls/${callId}/share`, ana.token, { conversationId: other, what: 'summary' })).status).toBe(400);
    // Alguien de afuera no puede leer la llamada; Beto no puede publicar en un chat donde no está.
    expect((await post(`/calls/${callId}/share`, extra.token, { conversationId: other })).status).toBe(404);
    const solo = (await post('/chats', ana.token, { userIds: [extra.id], name: 'Sin Beto' })).json.id;
    if (solo) expect((await post(`/calls/${callId}/share`, beto.token, { conversationId: solo })).status).toBe(404);
  });

  it('sonidos: el de un chat y los predeterminados llegan en el bootstrap', async () => {
    expect((await call(`/conversations/${chatId}/prefs`, { method: 'PUT', token: ana.token, body: { sound: 'marimba' } })).status).toBe(200);
    expect((await call(`/conversations/${chatId}/prefs`, { method: 'PUT', token: ana.token, body: { sound: 'trompeta' } })).status).toBe(400);
    expect((await call('/me/sounds', { method: 'PUT', token: ana.token, body: { messageSound: 'gota', ringtone: 'suave' } })).json).toEqual({ messageSound: 'gota', ringtone: 'suave' });
    const b = (await call('/bootstrap', { token: ana.token })).json;
    expect(b.conversations.find((c: any) => c.id === chatId).sound).toBe('marimba');
    expect([b.me.messageSound, b.me.ringtone]).toEqual(['gota', 'suave']);
    // Volver al predeterminado.
    await call(`/conversations/${chatId}/prefs`, { method: 'PUT', token: ana.token, body: { sound: null } });
    const b2 = (await call('/bootstrap', { token: ana.token })).json;
    expect(b2.conversations.find((c: any) => c.id === chatId).sound).toBeUndefined();
    // Silenciar no borra el sonido elegido (y al revés).
    await call(`/conversations/${chatId}/prefs`, { method: 'PUT', token: beto.token, body: { sound: 'tambor' } });
    await call(`/conversations/${chatId}/prefs`, { method: 'PUT', token: beto.token, body: { pinned: true } });
    expect((await call('/bootstrap', { token: beto.token })).json.conversations.find((c: any) => c.id === chatId).sound).toBe('tambor');
  });

  it('transcripción con Groq por pedazos: «Procesando…», frases con quien habló, sin duplicar y sin voz no guarda nada', async () => {
    const c = (await post(`/conversations/${chatId}/call`, ana.token, { kind: 'audio' })).json.call;
    await post(`/conversations/${chatId}/call`, beto.token, {});
    const up = (tok: string, text: string, segId: string, offsetMs = 0): Promise<{ status: number; json: any }> => fetch(`${API}/api/v1/calls/${c.id}/audio`, {
      method: 'POST', body: Buffer.from(text),
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/octet-stream', 'x-file-type': 'audio/webm;codecs=opus', 'x-seg-id': segId, 'x-offset-ms': String(offsetMs), 'x-duration-ms': '15000' },
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
    // Apagada: no se acepta.
    expect((await up(ana.token, 'texto:hola', 'seg-ana-0')).status).toBe(400);
    await post(`/calls/${c.id}/transcription`, ana.token, { on: true });
    const before = account.length;
    const r1 = await up(ana.token, 'texto:Hola Beto, revisemos Xertify', 'seg-ana-1', 1000);
    expect(r1.json).toMatchObject({ saved: 1, segments: [{ speakerUserId: ana.id, speakerName: 'Ana', text: 'Hola Beto, revisemos Xertify', startMs: 1000 }] });
    // El mismo pedazo reintentado no duplica.
    expect((await up(ana.token, 'texto:Hola Beto, revisemos Xertify', 'seg-ana-1', 1000)).json.saved).toBe(0);
    // Sin voz (Whisper no devuelve frases) no guarda nada.
    expect((await up(beto.token, 'silencio', 'seg-beto-1', 16000)).json.saved).toBe(0);
    expect((await up(beto.token, 'texto:Listo, mañana lo firmo', 'seg-beto-2', 17000)).json.saved).toBe(1);
    // Beto recibió «Procesando…» y luego las frases de Ana.
    await waitFor(() => account.slice(before).find((e) => e.type === 'call.processing' && e.segId === 'seg-ana-1'), 'call.processing');
    const tr: any = await waitFor(() => account.slice(before).find((e) => e.type === 'call.transcript' && e.segId === 'seg-ana-1'), 'call.transcript');
    expect(tr.segments[0].text).toBe('Hola Beto, revisemos Xertify');
    // Alguien de afuera no puede mandar audio.
    expect((await up(extra.token, 'texto:intruso', 'seg-extra-1')).status).toBe(404);
    await post(`/calls/${c.id}/end`, ana.token);
    const t = await call(`/calls/${c.id}/transcript`, { token: beto.token });
    expect(t.json.segments.map((x: any) => [x.speakerName, x.text])).toEqual([['Ana', 'Hola Beto, revisemos Xertify'], ['Beto', 'Listo, mañana lo firmo']]);
  });

  it('agregar personas: a Carla (misma empresa, no está en el chat) le suena, entra y ve solo la llamada', async () => {
    const carla = await signup('Carla', (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token);
    const cs: Socket = await new Promise((res, rej) => {
      const s2 = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: carla.token } });
      s2.once('ready', () => res(s2)); s2.once('connect_error', rej);
    });
    const carlaEvents: any[] = [];
    cs.on('account.event', (e) => carlaEvents.push(e));
    try {
      const c = (await post(`/conversations/${chatId}/call`, ana.token, { kind: 'audio' })).json.call;
      // Fuera de la llamada no se puede agregar; alguien sin relación (Extra, otra empresa) tampoco.
      expect((await post(`/calls/${c.id}/invite`, beto.token, { userIds: [carla.id] })).status).toBe(409);
      expect((await post(`/calls/${c.id}/invite`, ana.token, { userIds: [extra.id] })).status).toBe(403);
      const inv = await post(`/calls/${c.id}/invite`, ana.token, { userIds: [carla.id] });
      expect(inv.status).toBe(200);
      expect(inv.json.call.invitedUserIds).toEqual([carla.id]);
      expect(inv.json.call.names[carla.id]).toBe('Carla');
      await waitFor(() => carlaEvents.find((e) => e.type === 'call.ringing' && e.call.id === c.id), 'ringing a Carla');
      const j = await post(`/calls/${c.id}/join`, carla.token);
      expect(j.status).toBe(200);
      expect(j.json.attendee.Attendee.ExternalUserId).toBe(carla.id);
      expect(j.json.call.activeUserIds.sort()).toEqual([ana.id, carla.id].sort());
      // Le llegan los cambios de la llamada por su cuenta (no está en la sala del chat).
      await post(`/conversations/${chatId}/call`, beto.token, {});
      await waitFor(() => carlaEvents.find((e) => e.type === 'call.updated' && e.call.activeUserIds.includes(beto.id)), 'call.updated a Carla');
      // No puede leer los mensajes del chat.
      expect((await call(`/conversations/${chatId}/messages?limit=5`, { token: carla.token })).status).toBe(404);
      expect((await post(`/calls/${c.id}/heartbeat`, carla.token)).status).toBe(200);
      await post(`/calls/${c.id}/end`, ana.token);
      // Después: la ve en su historial y puede abrir su detalle.
      expect((await call('/calls?limit=5', { token: carla.token })).json.calls.map((x: any) => x.call.id)).toContain(c.id);
      expect((await call(`/calls/${c.id}/transcript`, { token: carla.token })).status).toBe(200);
    } finally { cs.disconnect(); }
  });
});
