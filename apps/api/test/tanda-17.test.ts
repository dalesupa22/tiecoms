/**
 * Tanda 1.7 (docs/TANDA-1.7.md): #grupos, «es hoy», tarea hecha y vencida, comentarios agrupados, búsqueda en el
 * chat y mensajes de una sola vista. Necesita el API (API_URL) con S3 (en local, test/fake-s3.mjs) y el worker
 * corriendo con OVERDUE_CHECK_MS corto (p. ej. 3000) para «es hoy» y «No cumplimos».
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { fold, parseQuery, snippetFor } from '../src/modules/search-text.ts';
import { todayDecision } from '../src/modules/today.ts';

const API = process.env.API_URL ?? 'http://localhost:3020';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, opts: { method?: string; token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string>; abs?: boolean } = {}) {
  const res = await fetch(opts.abs ? `${API}${path}` : `${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : opts.raw ? { 'content-type': 'application/octet-stream' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : opts.raw,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = {};
  try { json = JSON.parse(buf.toString()); } catch {}
  return { status: res.status, json, buf };
}
const post = (path: string, token: string, body: unknown = {}) => call(path, { token, body });
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function signup(name: string, orgInviteToken?: string): Promise<Actor> {
  const res = await fetch(`${API}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({
    name, email: `${name.toLowerCase()}.t17.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa6b3a5c90000000049454e44ae426082', 'hex');
const send = (a: Actor, conv: string, body: unknown) => post(`/conversations/${conv}/messages`, a.token, { clientMessageId: randomUUID(), ...(body as object) });
const messages = async (a: Actor, conv: string) => (await call(`/conversations/${conv}/messages?limit=100`, { token: a.token })).json.messages as any[];
const sysOf = (list: any[], k: string) => list.filter((m) => m.kind === 'system' && (() => { try { return JSON.parse(m.body).k === k; } catch { return false; } })()).map((m) => ({ ...m, b: JSON.parse(m.body) }));
async function until<T>(fn: () => Promise<T | undefined | false>, what: string, tries = 60, every = 500): Promise<T> {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error(`no llegó ${what}`);
}

describe('utilidades de búsqueda y «es hoy» (sin API)', () => {
  it('fold quita tildes y mayúsculas sin cambiar el largo', () => {
    expect(fold('Reunión ÑANDÚ Ça')).toBe('reunion nandu ca');
    expect(fold('Reunión').length).toBe('Reunión'.length);
  });
  it('from:Nombre se separa de la consulta', () => {
    expect(parseQuery('from:Ana presupuesto')).toEqual({ text: 'presupuesto', from: 'Ana' });
    expect(parseQuery('hola from:"Ana María"')).toEqual({ text: 'hola', from: 'Ana María' });
  });
  it('el fragmento marca las coincidencias', () => {
    const s = snippetFor('Mañana revisamos la REUNIÓN y otra reunion', 'reunion');
    expect(s.matches.length).toBe(2);
    expect(fold(s.snippet.slice(s.matches[0]![0], s.matches[0]![0] + s.matches[0]![1]))).toBe('reunion');
  });
  it('«es hoy» respeta la zona, las 07:00 y los 10 minutos', () => {
    const tz = 'America/Bogota'; // UTC-5
    const ev = (start: string, created: string) => ({ startsAt: new Date(start), endsAt: new Date(Date.parse(start) + 3600_000), createdAt: new Date(created), timezone: tz });
    // Evento a las 15:00 de Bogotá creado ayer: 06:59 espera, 07:00 publica.
    expect(todayDecision(ev('2026-10-01T20:00:00Z', '2026-09-30T15:00:00Z'), new Date('2026-10-01T11:59:00Z'))).toBe('wait');
    expect(todayDecision(ev('2026-10-01T20:00:00Z', '2026-09-30T15:00:00Z'), new Date('2026-10-01T12:00:00Z'))).toBe('post');
    // Mañana en Bogotá (aunque en UTC ya sea el mismo día): espera.
    expect(todayDecision(ev('2026-10-02T06:00:00Z', '2026-09-30T15:00:00Z'), new Date('2026-10-01T20:00:00Z'))).toBe('wait');
    // Creado hoy después de las 07:00 con 5 min por delante: no avisa (bastan event.created y «empieza en 10 min»).
    expect(todayDecision(ev('2026-10-01T20:00:00Z', '2026-10-01T19:50:00Z'), new Date('2026-10-01T19:55:00Z'))).toBe('skip');
    // Ya terminó: no avisa.
    expect(todayDecision(ev('2026-10-01T13:00:00Z', '2026-09-30T15:00:00Z'), new Date('2026-10-01T15:00:00Z'))).toBe('skip');
  });
});

describe('tanda 1.7 contra el API', () => {
  let ana: Actor, beto: Actor, diego: Actor, carla: Actor;
  let chat: string, otherChat: string, carlaChat: string;
  beforeAll(async () => {
    ana = await signup('Ana');
    const inv = async () => (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token;
    beto = await signup('Beto', await inv());
    diego = await signup('Diego', await inv());
    carla = await signup('Carla');
    chat = (await post('/chats', ana.token, { userIds: [beto.id], name: `Principal ${run}` })).json.id;
    otherChat = (await post('/chats', ana.token, { userIds: [beto.id, diego.id], name: `Operación ${run}` })).json.id;
    // Carla es de otra empresa: Ana la conoce por una invitación a un grupo.
    const g = await post('/groups', ana.token, { name: `Con Carla ${run}`, target: { kind: 'org' }, memberIds: [] });
    carlaChat = g.json.conversationId;
  });

  // ---------- 1. #grupos ----------
  it('refs: se guardan las válidas con el nombre y se descartan las que el autor no puede leer', async () => {
    const body = `Mira #Operación y #Nada y #Principal`;
    const r = await send(ana, chat, { body, refs: [
      { conversationId: otherChat, start: body.indexOf('#Operación'), length: '#Operación'.length },
      { conversationId: randomUUID(), start: body.indexOf('#Nada'), length: 5 },
      // Mal ubicado (no empieza con #): se descarta.
      { conversationId: chat, start: 0, length: 4 },
    ] });
    expect(r.status).toBe(201);
    expect(r.json.message.refs).toEqual([{ conversationId: otherChat, name: `Operación ${run}`, start: body.indexOf('#Operación'), length: '#Operación'.length }]);
    // Beto no está en el grupo con Carla: su ref se descarta sin error.
    const b2 = `Ver #Carla`;
    const r2 = await send(beto, chat, { body: b2, refs: [{ conversationId: carlaChat, start: 4, length: 6 }] });
    expect(r2.status).toBe(201);
    expect(r2.json.message.refs ?? []).toEqual([]);
    // Editar con refs nuevas.
    const e = await call(`/messages/${r.json.message.id}`, { method: 'PATCH', token: ana.token, body: { body: '#Principal', refs: [{ conversationId: chat, start: 0, length: 10 }] } });
    expect(e.status).toBe(200);
    expect(e.json.refs).toEqual([{ conversationId: chat, name: `Principal ${run}`, start: 0, length: 10 }]);
  });

  // ---------- 3. Tarea completada ----------
  it('issue.done al completar (y otro si se reabre y se cierra otra vez)', async () => {
    const issue = (await post(`/conversations/${chat}/issues`, ana.token, { title: 'Enviar propuesta' })).json;
    expect(issue.id).toBeTruthy();
    const patch = (body: unknown) => call(`/issues/${issue.id}`, { method: 'PATCH', token: beto.token, body });
    expect((await patch({ status: 'done' })).status).toBe(200);
    let done = sysOf(await messages(ana, chat), 'issue.done');
    expect(done).toHaveLength(1);
    expect(done[0].b).toMatchObject({ issueId: issue.id, title: 'Enviar propuesta', byId: beto.id, byName: 'Beto' });
    await patch({ status: 'open' });
    await patch({ status: 'done' });
    done = sysOf(await messages(ana, chat), 'issue.done');
    expect(done).toHaveLength(2);
    // Una tarea privada no avisa en el chat.
    const priv = (await post(`/conversations/${chat}/issues`, ana.token, { title: 'Privada', visibility: 'private' })).json;
    await call(`/issues/${priv.id}`, { method: 'PATCH', token: ana.token, body: { status: 'done' } });
    expect(sysOf(await messages(ana, chat), 'issue.done').some((m) => m.b.issueId === priv.id)).toBe(false);
  });

  // ---------- 5. Comentarios agrupados ----------
  it('comentarios de tareas: se agrupan dentro de los últimos 15 mensajes y crean uno nuevo después', async () => {
    const issue = (await post(`/conversations/${otherChat}/issues`, ana.token, { title: 'Revisar contrato' })).json;
    await post(`/issues/${issue.id}/comments`, ana.token, { body: 'Primero' });
    await post(`/issues/${issue.id}/comments`, beto.token, { body: 'Segundo comentario' });
    let notes = sysOf(await messages(ana, otherChat), 'issue.comments').filter((m) => m.b.issueId === issue.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].b).toMatchObject({ count: 2, lastById: beto.id, lastByName: 'Beto', lastExcerpt: 'Segundo comentario', title: 'Revisar contrato' });
    // La actualización no sube el seq (no cuenta como no leído).
    const before = (await call('/bootstrap', { token: diego.token })).json.conversations.find((c: any) => c.id === otherChat).lastMessageSeq;
    await post(`/issues/${issue.id}/comments`, beto.token, { body: 'Tercero' });
    const after = (await call('/bootstrap', { token: diego.token })).json.conversations.find((c: any) => c.id === otherChat).lastMessageSeq;
    expect(after).toBe(before);
    for (let i = 0; i < 15; i++) await send(beto, otherChat, { body: `relleno ${i}` });
    await post(`/issues/${issue.id}/comments`, diego.token, { body: 'Después de mucho' });
    notes = sysOf(await messages(ana, otherChat), 'issue.comments').filter((m) => m.b.issueId === issue.id);
    expect(notes).toHaveLength(2);
    expect(notes[1].b).toMatchObject({ count: 1, lastByName: 'Diego' });
    expect(notes[0].b.count).toBe(3);
  }, 120_000);

  it('comentarios de eventos: GET/POST, commentCount, lastComments y aviso event.comments', async () => {
    const start = new Date(Date.now() + 3 * 86400_000);
    const ev = (await post(`/conversations/${chat}/events`, ana.token, { title: 'Demo', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString(), timezone: 'America/Bogota' })).json;
    expect(ev.id).toBeTruthy();
    expect(ev.commentCount).toBe(0);
    const c1 = await post(`/events/${ev.id}/comments`, beto.token, { body: 'Llevo la presentación' });
    expect(c1.status).toBe(201);
    expect(c1.json.comment).toMatchObject({ eventId: ev.id, authorId: beto.id, body: 'Llevo la presentación' });
    await post(`/events/${ev.id}/comments`, ana.token, { body: 'Perfecto' });
    await post(`/events/${ev.id}/comments`, ana.token, { body: 'Y el acta' });
    const got = (await call(`/events/${ev.id}`, { token: beto.token })).json;
    expect(got.commentCount).toBe(3);
    expect(got.lastComments.map((c: any) => c.body)).toEqual(['Perfecto', 'Y el acta']);
    expect((await call(`/events/${ev.id}/comments`, { token: beto.token })).json.comments).toHaveLength(3);
    // Quien no está en el chat no lee ni comenta.
    expect((await call(`/events/${ev.id}/comments`, { token: carla.token })).status).toBe(404);
    expect((await post(`/events/${ev.id}/comments`, carla.token, { body: 'x' })).status).toBe(404);
    const notes = sysOf(await messages(ana, chat), 'event.comments').filter((m) => m.b.eventId === ev.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].b).toMatchObject({ count: 3, title: 'Demo', lastByName: 'Ana', lastExcerpt: 'Y el acta' });
  });

  // ---------- 6. Búsqueda ----------
  it('búsqueda: sin tildes ni mayúsculas, con from:, respetando el historial', async () => {
    const m1 = (await send(ana, otherChat, { body: `Reunión con ÑANDÚ ${run}` })).json.message;
    await send(beto, otherChat, { body: `otra reunion ${run}` });
    const s = await call(`/conversations/${otherChat}/search?q=${encodeURIComponent(`reunion`)}`, { token: diego.token });
    expect(s.status).toBe(200);
    const mine = s.json.results.filter((r: any) => r.message.body.includes(run));
    expect(mine.length).toBe(2);
    expect(mine[1].message.id).toBe(m1.id);
    expect(mine[1].matches[0]).toEqual([0, 7]);
    expect((await call(`/conversations/${otherChat}/search?q=nandu`, { token: diego.token })).json.results.map((r: any) => r.message.id)).toContain(m1.id);
    const from = await call(`/conversations/${otherChat}/search?q=${encodeURIComponent(`from:Beto ${run}`)}`, { token: ana.token });
    expect(from.json.results.every((r: any) => r.message.authorId === beto.id)).toBe(true);
    expect(from.json.results.length).toBeGreaterThan(0);
    // Paginación con before.
    const p1 = await call(`/conversations/${otherChat}/search?q=${run}&limit=1`, { token: ana.token });
    expect(p1.json.hasMore).toBe(true);
    const p2 = await call(`/conversations/${otherChat}/search?q=${run}&limit=1&before=${p1.json.results[0].message.seq}`, { token: ana.token });
    expect(p2.json.results[0].message.seq).toBeLessThan(p1.json.results[0].message.seq);
    expect((await call(`/conversations/${otherChat}/search?q=a`, { token: ana.token })).status).toBe(400);
    // Quien entra sin historial no encuentra lo anterior; quien no está, 404.
    const fresh = await signup('Elena', (await post(`/organizations/${ana.orgId}/invitations`, ana.token)).json.token);
    expect((await post(`/conversations/${otherChat}/members`, ana.token, { userIds: [fresh.id], history: 'now' })).status).toBeLessThan(300);
    expect((await call(`/conversations/${otherChat}/search?q=nandu`, { token: fresh.token })).json.results).toEqual([]);
    expect((await call(`/conversations/${otherChat}/search?q=nandu`, { token: carla.token })).status).toBe(404);
    // Nombres de adjuntos.
    const up = await call(`/conversations/${otherChat}/attachments`, { token: ana.token, raw: Buffer.from('%PDF-1.4 x'), headers: { 'x-file-name': 'Presupuesto-Final.pdf', 'x-file-type': 'application/pdf' } });
    if (up.status === 503) return; // sin S3 en este entorno
    await send(ana, otherChat, { body: '', attachmentIds: [up.json.id] });
    const byName = await call(`/conversations/${otherChat}/search?q=presupuesto-final`, { token: beto.token });
    expect(byName.json.results[0]).toMatchObject({ field: 'attachment' });
  });

  // ---------- 7. Una sola vista ----------
  it('una sola vista: oculto para todos, se abre una vez, 410 la segunda y 409 al reenviar/fijar/editar/tarea', async () => {
    const r = await send(ana, chat, { body: 'clave del wifi: 1234', viewOnce: true });
    expect(r.status).toBe(201);
    expect(r.json.message).toMatchObject({ viewOnce: true, body: '', viewOnceState: 'sent', openedBy: [] });
    const id = r.json.message.id;
    const forBeto = (await messages(beto, chat)).find((m) => m.id === id);
    expect(forBeto).toMatchObject({ viewOnce: true, body: '', viewOnceState: 'unopened' });
    // No aparece en la búsqueda ni en la vista previa de la lista.
    expect((await call(`/conversations/${chat}/search?q=wifi`, { token: beto.token })).json.results).toEqual([]);
    const conv = (await call('/bootstrap', { token: beto.token })).json.conversations.find((c: any) => c.id === chat);
    expect(conv.lastMessagePreview).toBe('①');
    expect(conv.lastHumanPreview).toMatchObject({ messageId: id, body: '', viewOnce: true });
    // El autor no lo abre.
    expect((await post(`/messages/${id}/open`, ana.token)).status).toBe(403);
    const o = await post(`/messages/${id}/open`, beto.token);
    expect(o.status).toBe(200);
    expect(o.json).toEqual({ body: 'clave del wifi: 1234', attachments: [] });
    const again = await post(`/messages/${id}/open`, beto.token);
    expect(again.status).toBe(410);
    expect(again.json.error.code).toBe('already_opened');
    expect((await messages(beto, chat)).find((m) => m.id === id)).toMatchObject({ viewOnceState: 'opened', body: '' });
    const forAna = (await messages(ana, chat)).find((m) => m.id === id);
    expect(forAna.viewOnceState).toBe('sent');
    expect(forAna.openedBy.map((x: any) => x.userId)).toEqual([beto.id]);
    // 409 view_once: reenviar, fijar, editar y crear tarea.
    const fwd = await send(beto, otherChat, { body: 'reenvío', forwarded: { source: 'tiecoms', fromConversationId: chat, messageId: id } });
    expect([fwd.status, fwd.json.error?.code]).toEqual([409, 'view_once']);
    expect((await post(`/messages/${id}/pin`, beto.token)).json.error?.code).toBe('view_once');
    expect((await call(`/messages/${id}`, { method: 'PATCH', token: ana.token, body: { body: 'otra' } })).json.error?.code).toBe('view_once');
    expect((await post(`/conversations/${chat}/issues`, beto.token, { title: 'Desde una vista', originMessageId: id })).json.error?.code).toBe('view_once');
    // Un reenvío no puede ser de una sola vista.
    expect((await send(ana, chat, { body: 'x', viewOnce: true, forwarded: { source: 'whatsapp' } })).status).toBe(400);
  });

  it('una sola vista con foto: sin URL en los DTO, 403 en el endpoint general y URL firmada al abrir', async () => {
    const up = await call(`/conversations/${chat}/attachments`, { token: ana.token, raw: PNG, headers: { 'x-file-name': 'foto.png', 'x-file-type': 'image/png' } });
    if (up.status === 503) return; // sin S3 en este entorno
    expect(up.status).toBe(200);
    const r = await send(ana, chat, { body: '', attachmentIds: [up.json.id], viewOnce: true });
    expect(r.status).toBe(201);
    const att = r.json.message.attachments[0];
    expect(att).toMatchObject({ url: '', thumbUrl: null, contentType: 'image/png' });
    expect((await call(`/attachments/${up.json.id}`, { token: beto.token })).status).toBe(403);
    expect((await call(`/attachments/${up.json.id}`, { token: ana.token })).status).toBe(403);
    const o = await post(`/messages/${r.json.message.id}/open`, beto.token);
    expect(o.status).toBe(200);
    expect(o.json.attachments[0].url).toMatch(/^\/api\/v1\/once\?t=/);
    // La URL firmada sirve sin Bearer, solo a esa persona.
    const file = await call(o.json.attachments[0].url, { abs: true });
    expect(file.status).toBe(200);
    expect(file.buf.equals(PNG)).toBe(true);
    expect((await call(`${o.json.attachments[0].url}x`, { abs: true })).status).toBe(403);
    // Reenviar el adjunto: 409.
    const fwd = await send(beto, otherChat, { body: '', forwardAttachmentIds: [up.json.id] });
    expect(fwd.status).toBe(409);
    // Un PDF no puede ir en una sola vista.
    const pdf = await call(`/conversations/${chat}/attachments`, { token: ana.token, raw: Buffer.from('%PDF-1.4 x'), headers: { 'x-file-name': 'a.pdf', 'x-file-type': 'application/pdf' } });
    expect((await send(ana, chat, { body: '', attachmentIds: [pdf.json.id], viewOnce: true })).status).toBe(400);
  });

  // ---------- «No molestar» y modo sueño nunca impiden escribir ----------
  it('enviar a quien tiene No molestar o modo sueño activo responde 201 normal', async () => {
    expect((await call('/me/dnd', { method: 'PUT', token: beto.token, body: { until: new Date(Date.now() + 3600_000).toISOString() } })).status).toBe(200);
    const r1 = await send(ana, chat, { body: 'hola con No molestar' });
    expect(r1.status).toBe(201);
    // Sueño de 00:00 a 23:59 en su zona: siempre dentro del horario.
    expect((await call('/me/sleep', { method: 'PUT', token: beto.token, body: { on: true, start: '00:00', end: '23:59', tz: 'America/Bogota' } })).status).toBe(200);
    const r2 = await send(ana, chat, { body: 'hola con modo sueño', viewOnce: true });
    expect(r2.status).toBe(201);
    const r3 = await send(ana, chat, { body: '#Principal', refs: [{ conversationId: chat, start: 0, length: 10 }] });
    expect(r3.status).toBe(201);
    await call('/me/dnd', { method: 'PUT', token: beto.token, body: { until: null } });
    await call('/me/sleep', { method: 'PUT', token: beto.token, body: { on: false } });
  });

  // ---------- Worker: «es hoy» y «No cumplimos» ----------
  it('event.today se publica una sola vez en la zona del evento (worker)', async () => {
    const now = new Date();
    const start = new Date(now.getTime() + 60 * 60_000);
    const hourIn = (tz: string, d: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));
    const dateIn = (tz: string, d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
    const zones = Array.from({ length: 27 }, (_, i) => i - 12).map((o) => (o === 0 ? 'Etc/GMT' : `Etc/GMT${o > 0 ? '-' : '+'}${Math.abs(o)}`));
    // Una zona donde ya pasaron las 07:00 y el inicio es hoy; otra donde aún es de madrugada (o el inicio es mañana).
    const yes = zones.find((z) => hourIn(z, now) >= 7 && dateIn(z, now) === dateIn(z, start))!;
    const no = zones.find((z) => (hourIn(z, now) < 6 && dateIn(z, now) === dateIn(z, start)) || dateIn(z, now) !== dateIn(z, start))!;
    const mk = (tz: string, title: string) => post(`/conversations/${chat}/events`, ana.token, { title, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 1800_000).toISOString(), timezone: tz });
    const evYes = (await mk(yes, `Hoy sí ${run}`)).json;
    const evNo = (await mk(no, `Hoy no ${run}`)).json;
    const found = await until(async () => sysOf(await messages(beto, chat), 'event.today').find((m) => m.b.eventId === evYes.id), 'event.today', 60);
    expect(found.b).toMatchObject({ eventId: evYes.id, title: `Hoy sí ${run}`, timezone: yes, startsAt: start.toISOString() });
    await sleep(17_000);
    const list = sysOf(await messages(beto, chat), 'event.today');
    expect(list.filter((m) => m.b.eventId === evYes.id)).toHaveLength(1);
    expect(list.some((m) => m.b.eventId === evNo.id)).toBe(false);
  }, 60_000);

  it('issue.overdue una vez por fecha límite (y otra si la nueva fecha también vence)', async () => {
    const bog = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(d);
    const yesterday = bog(new Date(Date.now() - 86400_000));
    const twoDays = bog(new Date(Date.now() - 2 * 86400_000));
    const issue = (await post(`/conversations/${chat}/issues`, ana.token, { title: `Vencida ${run}`, ownerId: beto.id, dueDate: yesterday })).json;
    const futureIssue = (await post(`/conversations/${chat}/issues`, ana.token, { title: `A tiempo ${run}`, dueDate: bog(new Date(Date.now() + 86400_000)) })).json;
    const first = await until(async () => sysOf(await messages(ana, chat), 'issue.overdue').find((m) => m.b.issueId === issue.id), 'issue.overdue', 40);
    expect(first.b).toMatchObject({ issueId: issue.id, title: `Vencida ${run}`, ownerId: beto.id, ownerName: 'Beto', dueDate: yesterday });
    await sleep(7000);
    expect(sysOf(await messages(ana, chat), 'issue.overdue').filter((m) => m.b.issueId === issue.id)).toHaveLength(1);
    await call(`/issues/${issue.id}`, { method: 'PATCH', token: beto.token, body: { dueDate: twoDays } });
    await until(async () => sysOf(await messages(ana, chat), 'issue.overdue').filter((m) => m.b.issueId === issue.id).length === 2 || undefined, 'segundo issue.overdue', 40);
    expect(sysOf(await messages(ana, chat), 'issue.overdue').some((m) => m.b.issueId === futureIssue.id)).toBe(false);
  }, 60_000);
});
