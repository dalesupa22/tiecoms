/**
 * Pedidos de Lorena (7-oct-2026), proveedor falso (CALLS_ENABLED=true CALLS_PROVIDER=fake CALLS_STT_PROVIDER=fake):
 * - el invitado por enlace también transcribe su micrófono (/call-guests/:id/audio con su secreto);
 * - la reunión improvisada (sala) queda en la agenda de su dueño, sin duplicarse al volver a entrar.
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
    name, email: `${name.toLowerCase()}.lorena.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken, id: r.json.user.id, orgId: r.json.user.primaryOrgId };
}
/** Pedazo de audio falso del invitado («texto:…» lo devuelve el STT falso tal cual). */
const guestAudio = (guestId: string, secret: string | null, text: string, segId: string, offsetMs = 0) => fetch(`${API}/api/v1/call-guests/${guestId}/audio`, {
  method: 'POST', body: Buffer.from(text),
  headers: { 'x-forwarded-for': ip(), 'content-type': 'application/octet-stream', ...(secret ? { 'x-guest-secret': secret } : {}), 'x-file-type': 'audio/webm;codecs=opus', 'x-seg-id': segId, 'x-offset-ms': String(offsetMs), 'x-duration-ms': '15000' },
}).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as any }));

describe('pedidos de Lorena: invitados transcritos y salas en la agenda', () => {
  let ana: Actor, beto: Actor, chatId: string, socket: Socket;
  const account: any[] = [];
  beforeAll(async () => {
    ana = await signup('Ana');
    beto = await signup('Beto', (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token);
    chatId = (await post('/chats', ana.token, { userIds: [beto.id], name: 'Con cliente' })).json.id;
    socket = await new Promise((res, rej) => {
      const s = io(API, { path: '/api/socket.io', transports: ['websocket'], auth: { token: ana.token } });
      s.on('account.event', (e) => account.push(e));
      s.once('ready', () => res(s)); s.once('connect_error', rej);
    });
  });
  afterAll(() => socket?.disconnect());
  async function waitFor<T>(fn: () => T | undefined, what: string): Promise<T> {
    for (let i = 0; i < 40; i++) { const v = fn(); if (v) return v; await sleep(150); }
    throw new Error(`no llegó ${what}`);
  }

  it('el invitado por enlace manda su audio: queda con su nombre, sin duplicar, y solo con su secreto', async () => {
    const start = await post(`/conversations/${chatId}/call`, ana.token, { kind: 'audio' });
    expect(start.status).toBe(200);
    const callId = start.json.call.id;
    const link = (await post(`/calls/${callId}/link`, ana.token)).json.token;
    const g = (await call(`/call-links/${link}/join`, { body: { name: 'Laura' } })).json;
    expect(g.guestId).toBeTruthy();
    // Sabe cuándo empezó la llamada (sus pedazos se ubican desde ahí).
    expect(g.call.startedAt).toBe(start.json.call.startedAt);

    // Apagada: no se acepta.
    expect((await guestAudio(g.guestId, g.secret, 'texto:hola', 'seg-g-0')).status).toBe(400);
    await post(`/calls/${callId}/transcription`, ana.token, { on: true });
    // Sin secreto o con otro: no.
    expect((await guestAudio(g.guestId, null, 'texto:hola', 'seg-g-x')).status).toBe(400);
    expect((await guestAudio(g.guestId, 'x'.repeat(32), 'texto:hola', 'seg-g-x')).status).toBe(404);

    const before = account.length;
    const r1 = await guestAudio(g.guestId, g.secret, 'texto:Necesito la propuesta el viernes', 'seg-g-1', 2000);
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    expect(r1.json).toMatchObject({ saved: 1, segments: [{ speakerUserId: null, speakerName: 'Laura', text: 'Necesito la propuesta el viernes', startMs: 2000 }] });
    // El mismo pedazo reintentado no duplica.
    expect((await guestAudio(g.guestId, g.secret, 'texto:Necesito la propuesta el viernes', 'seg-g-1', 2000)).json.saved).toBe(0);
    // Ana (dentro) recibe «Procesando…» y las frases, con el invitado como "guest:{id}".
    await waitFor(() => account.slice(before).find((e) => e.type === 'call.processing' && e.segId === 'seg-g-1' && e.userId === `guest:${g.guestId}`), 'call.processing');
    const tr: any = await waitFor(() => account.slice(before).find((e) => e.type === 'call.transcript' && e.segId === 'seg-g-1'), 'call.transcript');
    expect(tr.segments[0]).toMatchObject({ speakerName: 'Laura', speakerUserId: null });

    // Ana también habla (su pedazo sigue igual que antes).
    const up = await fetch(`${API}/api/v1/calls/${callId}/audio`, {
      method: 'POST', body: Buffer.from('texto:Listo, te la mando'),
      headers: { authorization: `Bearer ${ana.token}`, 'content-type': 'application/octet-stream', 'x-file-type': 'audio/webm', 'x-seg-id': 'seg-ana-1', 'x-offset-ms': '9000', 'x-duration-ms': '15000' },
    });
    expect(up.status).toBe(200);

    // Fuera de la llamada (salió hace rato o la llamada terminó hace rato) ya no; justo al salir, el último pedazo sí entra.
    expect((await call(`/call-guests/${g.guestId}/leave`, { body: { secret: g.secret } })).status).toBe(200);
    expect((await guestAudio(g.guestId, g.secret, 'texto:y una cosa más', 'seg-g-2', 12000)).json.saved).toBe(1);

    await post(`/calls/${callId}/end`, ana.token);
    const t = await call(`/calls/${callId}/transcript`, { token: beto.token });
    expect(t.json.segments.map((x: any) => [x.speakerName, x.text])).toEqual([
      ['Laura', 'Necesito la propuesta el viernes'], ['Ana', 'Listo, te la mando'], ['Laura', 'y una cosa más'],
    ]);
  });

  it('la reunión improvisada (sala) queda en la agenda de quien la crea, una vez por llamada', async () => {
    const room = (await post('/rooms', ana.token, { title: '' })).json;
    const from = new Date(Date.now() - 3600_000).toISOString(), to = new Date(Date.now() + 3 * 3600_000).toISOString();
    const mine = async () => (await call(`/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { token: ana.token })).json.events
      .filter((e: any) => e.location === room.url);

    const e1 = await post(`/rooms/${room.id}/enter`, ana.token, {});
    expect(e1.status).toBe(200);
    expect(e1.json.call.roomId).toBe(room.id);
    let evs = await mine();
    expect(evs.length).toBe(1);
    const ev = evs[0];
    expect(ev.title).toBe(`Reunión ${room.code}`);
    expect(ev.description).toContain(room.url);
    expect(Date.parse(ev.endsAt) - Date.parse(ev.startsAt)).toBe(30 * 60_000);
    expect(Math.abs(Date.parse(ev.startsAt) - Date.now())).toBeLessThan(2 * 60_000);
    // Sin invitar a nadie: solo la dueña, que ya dijo que sí.
    expect(ev.invitees).toEqual([{ userId: ana.id, rsvp: 'yes' }]);
    // Beto (misma empresa) no la ve en su agenda: está en el chat «Tú» de Ana.
    const betoEvs = (await call(`/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { token: beto.token })).json.events;
    expect(betoEvs.some((e: any) => e.location === room.url)).toBe(false);

    // Volver a entrar a la misma llamada no duplica.
    const e2 = await post(`/rooms/${room.id}/enter`, ana.token, {});
    expect(e2.json.call.id).toBe(e1.json.call.id);
    expect((await mine()).length).toBe(1);

    // Una llamada nueva de la sala (otro día, otra reunión) sí es otro evento.
    await post(`/calls/${e1.json.call.id}/leave`, ana.token, {});
    const e3 = await post(`/rooms/${room.id}/enter`, ana.token, {});
    expect(e3.json.call.id).not.toBe(e1.json.call.id);
    evs = await mine();
    expect(evs.length).toBe(2);
    await post(`/calls/${e3.json.call.id}/leave`, ana.token, {});

    // Una sala con título lo usa en la agenda.
    const named = (await post('/rooms', ana.token, { title: 'Demo con cliente' })).json;
    await post(`/rooms/${named.id}/enter`, ana.token, {});
    const all = (await call(`/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { token: ana.token })).json.events;
    expect(all.find((e: any) => e.location === named.url)?.title).toBe('Demo con cliente');
  });
});
