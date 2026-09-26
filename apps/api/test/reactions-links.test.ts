/**
 * Reacciones (forma canónica, límite, no leídos, acciones 👀/✅, push agrupado al autor, permisos) y biblioteca
 * de enlaces (índice por tipo, filtros, búsqueda, «Ver después» personal, edición, borrado, historial, resumen IA).
 * API + worker (API_URL) con push falso (FAKE_PUSH_URL) y DeepSeek falso.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeEmoji } from '@tiecoms/contracts';
import { classifyUrl, extractUrls, readableText } from '../src/modules/links.ts';
import { oembedEndpoint, parseDuration } from '../src/modules/link-preview.ts';

const API = process.env.API_URL ?? 'http://localhost:3020';
const FAKE_PUSH = process.env.FAKE_PUSH_URL ?? 'http://localhost:59045';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    name, email: `${name.toLowerCase().replace(/\W/g, '')}.rx.${run}@example.com`, password: 'clave-segura-123', ...(orgInviteToken ? { orgInviteToken } : { orgName: `${name} SAS ${run}` }),
    device: { deviceId: randomUUID(), name: 'vitest', platform: 'ios' },
  }) });
  const j: any = await res.json();
  expect(res.status).toBe(200);
  return { token: j.accessToken, id: j.user.id, orgId: j.user.primaryOrgId };
}
const send = async (a: Actor, conv: string, body: string) =>
  (await call(`/conversations/${conv}/messages`, { token: a.token, body: { clientMessageId: randomUUID(), body } })).json.message;
const react = (a: Actor, messageId: string, emoji: string, on = true, body?: unknown) =>
  call(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { token: a.token, method: on ? 'PUT' : 'DELETE', ...(body ? { body } : {}) });
const boot = async (a: Actor) => (await call('/bootstrap', { token: a.token })).json;
const pushes = async () => (await (await fetch(`${FAKE_PUSH}/sent`)).json()) as any[];
const msgs = async (a: Actor, conv: string) => (await call(`/conversations/${conv}/messages?limit=100`, { token: a.token })).json.messages as any[];

let ana: Actor, laura: Actor, beto: Actor, extra: Actor, groupId: string;

beforeAll(async () => {
  ana = await signup('Ana');
  const inv = async () => (await call(`/organizations/${ana.orgId}/invitations`, { token: ana.token, body: {} })).json.token;
  laura = await signup('Laura Gómez', await inv());
  beto = await signup('Beto', await inv());
  extra = await signup('Extra Persona');
  groupId = (await call('/chats', { token: ana.token, body: { userIds: [laura.id, beto.id], name: 'Reacciones' } })).json.id;
});

describe('funciones puras', () => {
  it('forma canónica de emojis', () => {
    expect(normalizeEmoji('❤')).toBe('❤️');
    expect(normalizeEmoji('👍️')).toBe('👍');
    expect(normalizeEmoji('👍🏽')).toBe('👍🏽');
    expect(normalizeEmoji('1⃣')).toBe('1️⃣');
    expect(normalizeEmoji('👍👍')).toBeNull();
    expect(normalizeEmoji('ok')).toBeNull();
  });
  it('clasifica enlaces por plataforma y tipo', () => {
    expect(classifyUrl('https://www.youtube.com/watch?v=abc')).toMatchObject({ provider: 'youtube', kind: 'video' });
    expect(classifyUrl('https://youtube.com/shorts/abc')).toMatchObject({ provider: 'youtube', kind: 'short' });
    expect(classifyUrl('https://vm.tiktok.com/ZM123/')).toMatchObject({ provider: 'tiktok', kind: 'short' });
    expect(classifyUrl('https://www.instagram.com/reel/C1/')).toMatchObject({ provider: 'instagram', kind: 'short' });
    expect(classifyUrl('https://www.instagram.com/p/C1/')).toMatchObject({ provider: 'instagram', kind: 'post' });
    expect(classifyUrl('https://x.com/a/status/1')).toMatchObject({ provider: 'x', kind: 'post' });
    expect(classifyUrl('https://docs.google.com/document/d/1')).toMatchObject({ provider: 'google', kind: 'doc' });
    expect(classifyUrl('https://example.com/informe.PDF')).toMatchObject({ provider: null, kind: 'doc' });
    expect(classifyUrl('https://music.youtube.com/watch?v=1')).toMatchObject({ kind: 'audio' });
    expect(classifyUrl('https://blog.example.com/nota')).toMatchObject({ provider: null, kind: 'link', host: 'blog.example.com' });
  });
  it('extrae enlaces sin repetir ni puntuación final', () => {
    expect(extractUrls('mira https://a.com/x, y https://b.com/y. otra vez https://a.com/x!')).toEqual(['https://a.com/x', 'https://b.com/y']);
    expect(extractUrls('(https://es.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://es.wikipedia.org/wiki/Foo_(bar)']);
  });
  it('duración y oEmbed', () => {
    expect(parseDuration('PT4M13S')).toBe(253);
    expect(parseDuration('PT1H2M')).toBe(3720);
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('mucho')).toBeNull();
    expect(oembedEndpoint('youtube', 'https://youtu.be/x')).toContain('youtube.com/oembed');
    expect(oembedEndpoint('tiktok', 'https://tiktok.com/@a/video/1')).toContain('tiktok.com/oembed');
    expect(oembedEndpoint(null, 'https://a.com')).toBeNull();
  });
  it('texto legible de una página', () => {
    const t = readableText('<html><nav>menú</nav><article><h1>Título</h1><p>Uno &amp; dos</p><script>x()</script></article><footer>pie</footer></html>');
    expect(t).toContain('Uno & dos');
    expect(t).not.toContain('menú');
    expect(t).not.toContain('x()');
  });
});

describe('reacciones', () => {
  it('reacciona, deduplica, normaliza y quita; no suma no leídos ni marca editado', async () => {
    const m = await send(ana, groupId, 'Propuesta lista para revisar');
    await call(`/conversations/${groupId}/read`, { token: laura.token, body: { seq: m.seq } });
    const r1 = await react(laura, m.id, '❤');
    expect(r1.status).toBe(200);
    expect(r1.json.message.reactions).toEqual([{ emoji: '❤️', userIds: [laura.id] }]);
    expect(r1.json.message.editedAt).toBeNull();
    await react(laura, m.id, '❤️'); // misma reacción: no duplica
    const r2 = await react(beto, m.id, '❤️');
    expect(r2.json.message.reactions[0].userIds).toEqual([laura.id, beto.id]);
    await react(beto, m.id, '👍');
    const conv = (await boot(laura)).conversations.find((c: any) => c.id === groupId);
    expect(conv.unread).toBe(0);
    const del = await react(laura, m.id, '❤️', false);
    expect(del.json.message.reactions).toEqual([{ emoji: '❤️', userIds: [beto.id] }, { emoji: '👍', userIds: [beto.id] }]);
    // Llega en vivo por eventos como message.updated.
    const ev = (await call(`/conversations/${groupId}/events?after=0&limit=200`, { token: ana.token })).json.events;
    expect(ev.some((e: any) => e.type === 'message.updated' && e.message.id === m.id && e.message.reactions?.length === 2)).toBe(true);
  });

  it('rechaza lo que no es un emoji y más de 20 distintos', async () => {
    const m = await send(ana, groupId, 'muchas');
    expect((await react(laura, m.id, 'ok')).status).toBe(400);
    const list = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙'];
    for (const e of list) expect((await react(laura, m.id, e)).status).toBe(200);
    expect((await react(beto, m.id, '🤔')).status).toBe(409);
    expect((await react(beto, m.id, '😀')).status).toBe(200); // uno existente sí se puede sumar
  });

  it('solo quien participa puede reaccionar; un mensaje eliminado pierde sus reacciones', async () => {
    const m = await send(ana, groupId, 'borrar luego');
    expect((await react(extra, m.id, '👍')).status).toBe(404);
    await react(laura, m.id, '👍');
    const d = await call(`/messages/${m.id}`, { token: ana.token, method: 'DELETE' });
    expect(d.json.reactions).toEqual([]);
    expect((await react(laura, m.id, '👍')).status).toBe(400);
  });

  it('👀 crea un recordatorio, quitarlo lo cancela; ✅ lo cierra y reemplaza a 👀', async () => {
    const m = await send(ana, groupId, '¿Pueden revisar el contrato?');
    const at = new Date(Date.now() + 3600_000).toISOString();
    const look = await react(laura, m.id, '👀', true, { remindAt: at });
    expect(look.json.reminder).toMatchObject({ messageId: m.id, remindAt: at });
    let mine = (await call('/reminders', { token: laura.token })).json.reminders;
    expect(mine.some((r: any) => r.id === look.json.reminder.id)).toBe(true);
    const off = await react(laura, m.id, '👀', false);
    expect(off.json.closedReminderIds).toEqual([look.json.reminder.id]);
    mine = (await call('/reminders', { token: laura.token })).json.reminders;
    expect(mine.some((r: any) => r.id === look.json.reminder.id)).toBe(false);

    const again = await react(laura, m.id, '👀');
    const done = await react(laura, m.id, '✅');
    expect(done.json.closedReminderIds).toContain(again.json.reminder.id);
    expect(done.json.message.reactions).toEqual([{ emoji: '✅', userIds: [laura.id] }]);
  });

  it('✅ sobre el mensaje que abrió un asunto avisa para cerrarlo', async () => {
    const ws = await call('/groups', { token: ana.token, body: { name: 'Asuntos rx', target: { kind: 'org' }, memberIds: [laura.id] } });
    const conv = ws.json.conversationId;
    const m = await send(ana, conv, 'Enviar la cotización');
    const issue = await call(`/conversations/${conv}/issues`, { token: ana.token, body: { title: 'Enviar la cotización', originMessageId: m.id } });
    expect(issue.status).toBeLessThan(300);
    const done = await react(laura, m.id, '✅');
    expect(done.json.openIssueId).toBe(issue.json.id);
  });

  it('la empresa puede apagar las reacciones con acción (solo administración)', async () => {
    expect((await call(`/organizations/${ana.orgId}/reaction-actions`, { token: laura.token, method: 'PUT', body: { reactionActions: false } })).status).toBe(403);
    expect((await call(`/organizations/${ana.orgId}/reaction-actions`, { token: ana.token, method: 'PUT', body: { reactionActions: false } })).json.reactionActions).toBe(false);
    const m = await send(ana, groupId, 'sin acciones');
    const look = await react(laura, m.id, '👀');
    expect(look.json.reminder).toBeUndefined();
    expect((await boot(laura)).organizations.find((o: any) => o.id === ana.orgId).reactionActions).toBe(false);
    await call(`/organizations/${ana.orgId}/reaction-actions`, { token: ana.token, method: 'PUT', body: { reactionActions: true } });
  });

  it('al autor le llega un solo push agrupado', async () => {
    const token = `apns-rx-${run}`;
    await call('/push/token', { token: ana.token, method: 'PUT', body: { provider: 'apns', token } });
    const m = await send(ana, groupId, 'Quedó aprobado el piloto');
    await react(laura, m.id, '🎉');
    await react(beto, m.id, '👏');
    await react(ana, m.id, '🙌'); // la propia no avisa
    let hits: any[] = [];
    for (let i = 0; i < 80 && !hits.length; i++) { await sleep(500); hits = (await pushes()).filter((p) => p.token === token && p.body.type === 'reaction' && p.body.messageId === m.id); }
    expect(hits.length).toBe(1);
    expect(hits[0].body.aps.alert.title).toMatch(/Laura y Beto reaccionaron 🎉👏/);
    expect(hits[0].body.aps.alert.body).toContain('Quedó aprobado el piloto');
  }, 60_000);
});

describe('biblioteca de enlaces', () => {
  let msgId: string;
  it('indexa cada enlace con su tipo y filtra por tipo y búsqueda', async () => {
    const m = await send(laura, groupId, 'Miren https://www.youtube.com/shorts/abc123 y el informe https://files.example.com/informe-q3.pdf y https://blog.example.com/nota');
    msgId = m.id;
    const all = (await call(`/conversations/${groupId}/links`, { token: ana.token })).json;
    const mine = all.links.filter((l: any) => l.messageId === m.id);
    expect(mine.map((l: any) => [l.kind, l.provider])).toEqual([['short', 'youtube'], ['doc', null], ['link', null]]);
    expect(mine[0]).toMatchObject({ savedAt: null, seenAt: null, messageSeq: m.seq, authorId: laura.id });
    const videos = (await call(`/conversations/${groupId}/links?kind=video`, { token: ana.token })).json.links;
    expect(videos.map((l: any) => l.url)).toContain('https://www.youtube.com/shorts/abc123');
    expect(videos.some((l: any) => l.kind === 'doc')).toBe(false);
    const docs = (await call(`/conversations/${groupId}/links?kind=doc`, { token: ana.token })).json.links;
    expect(docs.map((l: any) => l.url)).toEqual(['https://files.example.com/informe-q3.pdf']);
    const found = (await call(`/conversations/${groupId}/links?q=informe`, { token: ana.token })).json.links;
    expect(found.length).toBe(1);
    expect((await boot(ana)).conversations.find((c: any) => c.id === groupId).linkCount).toBeGreaterThanOrEqual(3);
    expect((await call(`/conversations/${groupId}/links`, { token: extra.token })).status).toBe(404);
  });

  it('«Ver después» es personal; editar conserva el enlace guardado; borrar lo saca', async () => {
    const link = (await call(`/conversations/${groupId}/links?kind=doc`, { token: ana.token })).json.links[0];
    const saved = await call(`/links/${link.id}/state`, { token: ana.token, method: 'PUT', body: { saved: true } });
    expect(saved.json.savedAt).toBeTruthy();
    let list = (await call('/links/saved', { token: ana.token })).json;
    expect(list.pending).toBe(1);
    expect(list.links[0].id).toBe(link.id);
    // Beto no ve el estado de Ana.
    expect((await call(`/conversations/${groupId}/links?kind=doc`, { token: beto.token })).json.links[0].savedAt).toBeNull();
    expect((await call('/links/saved', { token: beto.token })).json.links).toEqual([]);
    expect((await call(`/links/${link.id}/state`, { token: extra.token, method: 'PUT', body: { saved: true } })).status).toBe(404);

    // Laura edita el mensaje: quita el video y deja el informe.
    await call(`/messages/${msgId}`, { token: laura.token, method: 'PATCH', body: { body: 'Solo el informe https://files.example.com/informe-q3.pdf y https://blog.example.com/nota' } });
    const after = (await call(`/conversations/${groupId}/links`, { token: ana.token })).json.links.filter((l: any) => l.messageId === msgId);
    expect(after.map((l: any) => l.url)).toEqual(['https://files.example.com/informe-q3.pdf', 'https://blog.example.com/nota']);
    expect(after[0].id).toBe(link.id);
    expect(after[0].savedAt).toBeTruthy();

    const seen = await call(`/links/${link.id}/state`, { token: ana.token, method: 'PUT', body: { seen: true } });
    expect(seen.json.seenAt).toBeTruthy();
    list = (await call('/links/saved', { token: ana.token })).json;
    expect(list.pending).toBe(0);
    expect(list.links).toEqual([]);
    expect((await call('/links/saved?state=seen', { token: ana.token })).json.links[0].id).toBe(link.id);

    await call(`/messages/${msgId}`, { token: laura.token, method: 'DELETE' });
    expect((await call(`/conversations/${groupId}/links`, { token: ana.token })).json.links.some((l: any) => l.messageId === msgId)).toBe(false);
    expect((await call('/links/saved?state=all', { token: ana.token })).json.links).toEqual([]);
  });

  it('quien entra después sin historial no ve los enlaces anteriores', async () => {
    const chat = (await call('/chats', { token: ana.token, body: { userIds: [laura.id], name: 'Historial rx' } })).json.id;
    await send(ana, chat, 'viejo https://old.example.com/a');
    await call(`/conversations/${chat}/members`, { token: ana.token, body: { userIds: [beto.id], history: 'now' } });
    await send(ana, chat, 'nuevo https://new.example.com/b');
    const seen = (await call(`/conversations/${chat}/links`, { token: beto.token })).json.links.map((l: any) => l.url);
    expect(seen).toEqual(['https://new.example.com/b']);
  });

  it('vista previa compacta por conversación (preferencia personal)', async () => {
    await call(`/conversations/${groupId}/prefs`, { token: beto.token, method: 'PUT', body: { linkPreviews: 'compact' } });
    expect((await boot(beto)).conversations.find((c: any) => c.id === groupId).linkPreviews).toBe('compact');
    expect((await boot(ana)).conversations.find((c: any) => c.id === groupId).linkPreviews).toBeUndefined();
    await call(`/conversations/${groupId}/prefs`, { token: beto.token, method: 'PUT', body: { pinned: true } });
    expect((await boot(beto)).conversations.find((c: any) => c.id === groupId).linkPreviews).toBe('compact');
  });

  it('resumen con IA bajo pedido (con caché)', async () => {
    const m = await send(beto, groupId, 'Referencia: https://example.com/');
    let link: any = null;
    // El worker lee la página (red real): example.com trae título y poco texto → resumen de la descripción.
    for (let i = 0; i < 40; i++) {
      link = (await call(`/conversations/${groupId}/links`, { token: ana.token })).json.links.find((l: any) => l.messageId === m.id);
      if (link?.preview) break;
      await sleep(400);
    }
    if (!link?.preview) return; // sin red: no hay nada que resumir
    const s1 = await call(`/links/${link.id}/summary`, { token: ana.token, body: { lang: 'es' } });
    expect(s1.status).toBe(200);
    expect(s1.json).toMatchObject({ basis: 'description', lang: 'es' });
    expect(s1.json.summary).toMatch(/Descripción|Artículo/);
    const s2 = await call(`/links/${link.id}/summary`, { token: laura.token, body: { lang: 'es' } });
    expect(s2.json.summary).toBe(s1.json.summary);
    const withPreview = (await msgs(ana, groupId)).find((x) => x.id === m.id);
    expect(withPreview.linkPreviews?.[0]?.title).toBeTruthy();
  }, 30_000);
});
