/**
 * Citas por enlace (docs/CITAS.md). Necesita el API (API_URL) con MEETINGS_ENABLED=true y MEETINGS_GOOGLE_* apuntando a
 * test/fake-meetings.mjs (FAKE_MEETINGS), y Brevo falso (BREVO_FAKE) con MAIL_SUPPRESS_DOMAINS distinto de example.com.
 * Esto NO prueba OAuth ni la agenda real de Google: prueba la lógica de horarios, reservas y avisos.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { zonedToUtc } from '../src/modules/booking.ts';

const API = process.env.API_URL ?? 'http://127.0.0.1:3088';
const FAKE = process.env.FAKE_MEETINGS ?? 'http://127.0.0.1:59308';
const BREVO = process.env.BREVO_FAKE ?? 'http://127.0.0.1:59100';
const run = randomUUID().slice(0, 8);
interface Actor { token: string; id: string; orgId: string; email: string }
const hash = (s: string) => createHash('sha256').update(s).digest('base64url');
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), 'x-forwarded-for': ip() },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
async function signup(name: string): Promise<Actor> {
  const email = `${name.toLowerCase()}.cita.${run}@example.com`;
  const r = await call('/auth/signup', { body: { name, email, password: 'clave-segura-123', orgName: `${name} SAS ${run}`, device: { deviceId: randomUUID(), name: 'vitest', platform: 'web' } } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken, id: r.json.user.id, orgId: r.json.user.primaryOrgId, email };
}
async function connectGoogle(a: Actor) {
  const verifier = randomBytes(32).toString('base64url');
  const start = await call('/meetings/connect/google', { token: a.token, body: { platform: 'web', proofChallenge: hash(verifier) } });
  expect(start.status).toBe(200);
  const auth = await fetch(start.json.url, { redirect: 'manual' });
  const cb = await fetch(auth.headers.get('location')!, { redirect: 'manual' });
  const receipt = new URL(cb.headers.get('location')!).searchParams.get('receipt')!;
  expect((await call('/meetings/connect/confirm', { token: a.token, body: { receipt, proofVerifier: verifier } })).json).toEqual({ ok: true, provider: 'google' });
}
const control = (body: object) => fetch(`${FAKE}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const fakeStats = async () => (await (await fetch(`${FAKE}/stats`)).json()) as { google: number; patched: number; deleted: number };
const fakeEvents = async () => (await (await fetch(`${FAKE}/events`)).json()) as any[];
const mailsTo = async (email: string) => ((await (await fetch(`${BREVO}/sent`)).json()) as any[]).filter((m) => m.to[0].email === email);

/** Espera (hasta 8 s) a que algo que se hace en segundo plano aparezca: la base está detrás de un túnel. */
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 40; i++) { const v = await fn(); if (ok(v)) return v; await new Promise((r) => setTimeout(r, 200)); }
  return fn();
}
const ymd = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
const at = (daysAhead: number, hhmm: string) => `${ymd(daysAhead)}T${hhmm}:00.000Z`;
const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [['09:00', '17:00']]]));
const pageBody = (slug: string, hostIds: string[], mode: 'collective' | 'round_robin', extra: object = {}) => ({
  slug, title: `Cita ${slug}`, description: 'Hablemos', mode, durationMin: 30, bufferMin: 0, stepMin: 30, minNoticeMin: 0, horizonDays: 20, timezone: 'UTC', hours, hostIds, ...extra,
});
const guest = (n: string, startsAt: string, extra: object = {}) => ({ startsAt, name: `Tercero ${n}`, email: `tercero${n}.${run}@guests-test.dev`, timezone: 'America/Bogota', lang: 'es', ...extra });
const slotsOf = async (slug: string, from = 1, to = 4) => (await call(`/book/${slug}/slots?from=${encodeURIComponent(`${ymd(from)}T00:00:00Z`)}&to=${encodeURIComponent(`${ymd(to)}T00:00:00Z`)}`)).json.slots as string[];

let a: Actor, b: Actor, c: Actor, outsider: Actor;
const slugRR = `rr-${run}`, slugAll = `all-${run}`;

beforeAll(async () => {
  a = await signup('Ana'); b = await signup('Beto'); c = await signup('Carla'); outsider = await signup('Otro');
  // Beto y Carla pertenecen a la empresa de Ana (los anfitriones tienen que ser del mismo equipo).
  for (const u of [b, c]) await pool.query('INSERT INTO organization_memberships (org_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [a.orgId, u.id]);
  await connectGoogle(a); await connectGoogle(b); // Carla no conectó su calendario.
  await control({ busy: [] });
});
afterAll(async () => { await control({ busy: [] }); await pool.end(); });

describe('zonas horarias', () => {
  it('convierte la hora local respetando el cambio de horario', () => {
    expect(new Date(zonedToUtc('2026-03-07', '09:00', 'America/New_York')).toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(new Date(zonedToUtc('2026-03-09', '09:00', 'America/New_York')).toISOString()).toBe('2026-03-09T13:00:00.000Z');
    expect(new Date(zonedToUtc('2026-10-01', '09:00', 'America/Bogota')).toISOString()).toBe('2026-10-01T14:00:00.000Z');
  });
});

describe('administrar páginas', () => {
  it('valida nombre reservado, anfitriones de otra empresa y enlaces repetidos', async () => {
    expect((await call('/booking/pages', { token: a.token, body: pageBody('api', [a.id], 'round_robin') })).status).toBe(400);
    expect((await call('/booking/pages', { token: a.token, body: pageBody(`x-${run}`, [a.id, outsider.id], 'round_robin') })).status).toBe(403);
    expect((await call('/booking/pages', { token: a.token, body: pageBody(`x-${run}`, [a.id], 'round_robin', { hours: { '1': [['17:00', '09:00']] } }) })).status).toBe(400);
    const ok = await call('/booking/pages', { token: a.token, body: pageBody(slugRR, [a.id, b.id], 'round_robin') });
    expect(ok.status).toBe(200);
    expect(ok.json.url).toContain(`/${slugRR}`);
    expect(ok.json.hostsStatus.map((h: any) => h.calendar)).toEqual(['google', 'google']);
    expect((await call('/booking/pages', { token: b.token, body: pageBody(slugRR, [b.id], 'round_robin') })).json.error.code).toBe('slug_taken');
    const all = await call('/booking/pages', { token: a.token, body: pageBody(slugAll, [a.id, b.id, c.id], 'collective') });
    expect(all.status).toBe(200);
    expect(all.json.hostsStatus.find((h: any) => h.id === c.id).calendar).toBe('none');
    expect((await call('/booking/pages', { token: b.token })).json.pages.length).toBe(2);
    // Solo quien la creó la cambia.
    expect((await call(`/booking/pages/${ok.json.id}`, { token: b.token, method: 'PATCH', body: { title: 'Hackeada' } })).status).toBe(403);
  });
});

describe('página pública y horarios', () => {
  it('muestra la página sin cuenta y solo ofrece horas dentro del horario', async () => {
    const pub = await call(`/book/${slugRR}`);
    expect(pub.status).toBe(200);
    expect(pub.json).toMatchObject({ slug: slugRR, durationMin: 30, ready: true, mode: 'round_robin' });
    expect(pub.json.hosts.map((h: any) => h.name).sort()).toEqual(['Ana', 'Beto']);
    expect(pub.json.hosts[0].email).toBeUndefined();
    const s = await slotsOf(slugRR);
    expect(s.length).toBe(3 * 16);
    expect(s.every((x) => { const h = new Date(x).getUTCHours() + new Date(x).getUTCMinutes() / 60; return h >= 9 && h <= 16.5; })).toBe(true);
    expect((await call('/book/no-existe')).status).toBe(404);
    expect((await call(`/book/${slugRR}/slots?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`)).status).toBe(400);
  });

  it('oculta lo que está ocupado en el calendario real y lo devuelve al liberarse', async () => {
    const t = at(2, '10:00');
    expect(await slotsOf(slugRR)).toContain(t);
    await control({ busy: [{ id: 'busy1', start: { dateTime: at(2, '09:45') }, end: { dateTime: at(2, '10:15') } }] });
    const during = await slotsOf(slugRR);
    expect(during).not.toContain(at(2, '10:00'));
    expect(during).not.toContain(at(2, '09:30'));
    expect(during).toContain(at(2, '10:30'));
    // Un evento «disponible» o todo el día marcado como libre no bloquea.
    await control({ busy: [{ id: 'free1', transparency: 'transparent', start: { dateTime: at(2, '09:45') }, end: { dateTime: at(2, '10:15') } }] });
    expect(await slotsOf(slugRR)).toContain(t);
    await control({ busy: [] });
  });

  it('una página sin ningún calendario conectado no ofrece horarios', async () => {
    const r = await call('/booking/pages', { token: c.token, body: pageBody(`solo-c-${run}`, [c.id], 'round_robin') });
    expect(r.status).toBe(200);
    expect(r.json.ready).toBe(false);
    expect(await slotsOf(`solo-c-${run}`)).toEqual([]);
  });
});

describe('reservar', () => {
  it('reparte entre quienes están libres, crea el evento con Meet, avisa por correo y por gg', async () => {
    const t = at(3, '11:00');
    // Ana tiene una cita propia a esa hora: la reserva cae en Beto.
    const other = await call('/booking/pages', { token: a.token, body: pageBody(`otra-${run}`, [a.id], 'round_robin') });
    await pool.query(
      "INSERT INTO bookings (page_id, starts_at, ends_at, guest_name, guest_email, organizer_id, host_ids, status, manage_hash) VALUES ($1,$2,$3,'x','x@guests-test.dev',$4,$5,'confirmed',$6)",
      [other.json.id, t, at(3, '11:30'), a.id, [a.id], randomBytes(32)]);
    const before = await fakeStats();
    const r = await call(`/book/${slugRR}`, { body: guest('1', t, { note: 'Quiero ver una demo' }) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'confirmed', startsAt: t, guestName: 'Tercero 1' });
    expect(r.json.joinUrl).toMatch(/\/sala\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/); // la videollamada es una sala de chaggu, no Meet
    expect(r.json.manageToken).toHaveLength(43);
    expect(r.json.hosts.map((h: any) => h.name)).toEqual(['Beto']);
    expect((await fakeStats()).google).toBe(before.google + 1);
    const ev = (await fakeEvents()).find((e) => e.attendees?.some((x: any) => x.email === `tercero1.${run}@guests-test.dev`));
    expect(ev.summary).toContain('Tercero 1');
    // Correo al tercero con el enlace para cambiar o cancelar.
    const mails = await eventually(() => mailsTo(`tercero1.${run}@guests-test.dev`), (m) => m.length >= 1);
    expect(mails.length).toBe(1);
    expect(mails[0].subject).toContain('Confirmada');
    expect(mails[0].htmlContent).toContain(`/r/${r.json.manageToken}`);
    expect(mails[0].htmlContent).toContain(r.json.joinUrl);
    expect(ev.location).toBe(r.json.joinUrl);
    expect(ev.conferenceData?.createRequest).toBeUndefined();
    const sala = await call(`/rooms/${r.json.joinUrl.split('/sala/')[1]}`);
    expect(sala.json).toMatchObject({ hostName: 'Beto', title: `Cita ${slugRR}`, live: false });
    // gg le escribe directo a Beto.
    const gg = await eventually(() => pool.query(
      `SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN conversation_memberships cm ON cm.conversation_id = c.id
        WHERE cm.user_id = $1 AND m.author_id = '0a9a9a9a-0000-4000-8000-000000000066' AND m.body LIKE '%Nueva cita%'`, [b.id]), (r) => r.rows.length >= 1);
    expect(gg.rows.length).toBe(1);
    expect(gg.rows[0].body).toContain('Tercero 1');
    expect(gg.rows[0].body).toContain('Quiero ver una demo');
  });

  it('dos personas al mismo tiempo: gana una sola', async () => {
    const t = at(3, '14:00');
    const res = await Promise.all([call(`/book/${slugAll}`, { body: guest('2', t) }), call(`/book/${slugAll}`, { body: guest('3', t) })]);
    const codes = res.map((x) => x.status).sort();
    expect(codes).toEqual([200, 409]);
    expect(res.find((x) => x.status === 409)!.json.error.code).toBe('slot_taken');
    const ok = res.find((x) => x.status === 200)!.json;
    expect(ok.hosts.map((h: any) => h.name).sort()).toEqual(['Ana', 'Beto', 'Carla']);
  });

  it('collective: si falta uno de los anfitriones, el horario no sale', async () => {
    const t = at(4, '09:00');
    const other = await call('/booking/pages', { token: c.token, body: pageBody(`c-${run}`, [c.id], 'round_robin') });
    await pool.query(
      "INSERT INTO bookings (page_id, starts_at, ends_at, guest_name, guest_email, organizer_id, host_ids, status, manage_hash) VALUES ($1,$2,$3,'x','x@guests-test.dev',$4,$5,'confirmed',$6)",
      [other.json.id, t, at(4, '09:30'), c.id, [c.id], randomBytes(32)]);
    const s = await slotsOf(slugAll, 1, 6);
    expect(s).not.toContain(t);
    expect(s).toContain(at(4, '09:30'));
    expect((await call(`/book/${slugAll}`, { body: guest('4', t) })).json.error.code).toBe('slot_taken');
  });

  it('rechaza el campo trampa, horarios fuera de agenda y el exceso de citas por correo', async () => {
    expect((await call(`/book/${slugRR}`, { body: guest('5', at(5, '10:00'), { website: 'http://spam' }) })).status).toBe(400);
    expect((await call(`/book/${slugRR}`, { body: guest('5', at(5, '20:00')) })).json.error.code).toBe('slot_taken');
    expect((await call(`/book/${slugRR}`, { body: guest('5', at(5, '10:10')) })).json.error.code).toBe('slot_taken');
    expect((await call(`/book/${slugRR}`, { body: guest('5', at(-1, '10:00')) })).json.error.code).toBe('slot_taken');
    const email = `repetido.${run}@guests-test.dev`;
    const mk = (h: string) => call(`/book/${slugRR}`, { body: { ...guest('6', at(6, h)), email } });
    expect((await mk('09:00')).status).toBe(200);
    expect((await mk('10:00')).status).toBe(200);
    expect((await mk('11:00')).status).toBe(200);
    expect((await mk('12:00')).json.error.code).toBe('too_many_bookings');
  });
});

describe('cambiar y cancelar con el enlace', () => {
  it('ver, cambiar de horario (mismo evento) y cancelar; cancelar de nuevo no rompe', async () => {
    const t = at(7, '10:00'), t2 = at(7, '15:00');
    const r = await call(`/book/${slugRR}`, { body: guest('7', t, { lang: 'en' }) });
    expect(r.status).toBe(200);
    const token = r.json.manageToken;
    const v = await call(`/booking/${token}`);
    expect(v.json).toMatchObject({ status: 'confirmed', startsAt: t, guestName: 'Tercero 7' });
    expect(v.json.manageToken).toBeUndefined();
    expect((await call('/booking/' + 'x'.repeat(43))).status).toBe(404);

    const before = await fakeStats();
    const mv = await call(`/booking/${token}/reschedule`, { body: { startsAt: t2 } });
    expect(mv.status).toBe(200);
    expect(mv.json.startsAt).toBe(t2);
    expect((await fakeStats()).patched).toBe(before.patched + 1);
    expect((await slotsOf(slugRR, 1, 9))).not.toContain(t2); // Quien atiende ya no está libre a esa hora... pero sí el otro anfitrión
    expect((await call(`/booking/${token}/reschedule`, { body: { startsAt: at(7, '03:00') } })).json.error.code).toBe('slot_taken');

    const cx = await call(`/booking/${token}/cancel`, { body: {} });
    expect(cx.status).toBe(200);
    expect(cx.json.status).toBe('cancelled');
    expect((await fakeStats()).deleted).toBe(before.deleted + 1);
    expect((await call(`/booking/${token}/cancel`, { body: {} })).status).toBe(200);
    expect((await fakeStats()).deleted).toBe(before.deleted + 1);
    expect((await call(`/booking/${token}/reschedule`, { body: { startsAt: t } })).status).toBe(400);
    const mails = await eventually(() => mailsTo(`tercero7.${run}@guests-test.dev`), (m) => m.length >= 3);
    expect(mails.map((m) => m.subject).join('|')).toMatch(/Confirmed.*\|.*New time.*\|.*Cancelled/);
    // El horario cancelado vuelve a estar libre.
    expect(await slotsOf(slugRR, 6, 9)).toContain(t);
  });

  it('un anfitrión puede cancelar desde Ajustes, y un ajeno no', async () => {
    const r = await call(`/book/${slugRR}`, { body: guest('8', at(8, '10:00')) });
    const list = await call('/booking/bookings', { token: a.token });
    const mine = [...list.json.bookings, ...(await call('/booking/bookings', { token: b.token })).json.bookings].find((x: any) => x.guestName === 'Tercero 8');
    expect(mine).toBeTruthy();
    expect((await call(`/booking/bookings/${mine.id}/cancel`, { token: outsider.token, body: {} })).status).toBe(403);
    const host = mine.hostIds.includes(a.id) ? a : b;
    expect((await call(`/booking/bookings/${mine.id}/cancel`, { token: host.token, body: {} })).json).toEqual({ ok: true });
    expect((await call(`/booking/${r.json.manageToken}`)).json.status).toBe('cancelled');
    // La sala de la cita cancelada deja de servir.
    expect((await call(`/rooms/${r.json.joinUrl.split('/sala/')[1]}`)).status).toBe(410);
  });
});
