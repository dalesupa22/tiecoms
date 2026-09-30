import { createHash, randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type {
  BookingDTO, BookingHostBookingDTO, BookingHostDTO, BookingHostStatusDTO, BookingHours, BookingPageDTO, BookingPageInput as BookingPageInputSchema,
  BookingPagePatch as BookingPagePatchSchema, BookingPagePublicDTO, BookingSlotsDTO,
} from '@tiecoms/contracts';
import { config } from '../config.ts';
import { audit, pool, tx, type Tx } from '../db.ts';
import { GG_ID } from './gg.ts';
import { appendMessage } from './messages.ts';
import { getOrCreateDirect } from './workspaces.ts';
import { ApiError, badRequest, forbidden, notFound } from '../errors.ts';
import { bookingMail, trySendMail } from '../mail.ts';
import {
  busyIntervals, cancelCalendarEvent, connectedCalendar, createCalendarEvent, forgetBusy, moveCalendarEvent, type BusyResult, type CalendarProvider, type Interval,
} from './booking-calendars.ts';

/**
 * Citas por enlace, tipo Calendly (docs/CITAS.md).
 * - Página pública por slug: cualquiera, sin cuenta, ve los horarios libres y reserva.
 * - Libre = dentro del horario de atención Y sin nada en la agenda de chaggu, ni en el calendario real
 *   (Google/Microsoft) de quien atiende, ni en otra cita. Nunca se muestra qué hay en las agendas.
 * - collective: todos los anfitriones tienen que estar libres (reunión con todo el equipo). round_robin: basta uno
 *   libre y la cita se reparte entre quienes tienen menos citas por delante.
 * - Reservar crea el evento con Meet/Teams en el calendario de quien organiza; el proveedor invita al tercero.
 */

const MIN = 60_000;
const DAY = 86_400_000;
const HOLD_MIN = 3;
const MAX_WINDOW_DAYS = 45;
const MAX_ACTIVE_PER_EMAIL = 3;
const MAX_PER_HOUR_PER_EMAIL = 5;
const RESERVED = new Set(['r', 'api', 'app', 'www', 'cita', 'book', 'login', 'signup', 'admin', 'assets', 'ajustes', 'invite', 'llamada', 'confirmar', 'reservas', 'chaggu', 'gg']);
const sha = (s: string) => createHash('sha256').update(s).digest();
const iso = (ms: number) => new Date(ms).toISOString();
type Input = z.infer<typeof BookingPageInputSchema>;
type Patch = z.infer<typeof BookingPagePatchSchema>;

// ---------- Enlaces ----------
/** https://cita.chaggu.com cuando el dominio esté listo (BOOKING_PUBLIC_ORIGIN); mientras tanto, la ruta /cita de la app. */
const origin = () => (process.env.BOOKING_PUBLIC_ORIGIN ?? `${config.publicOrigin.replace(/\/$/, '')}/cita`).replace(/\/$/, '');
export const pageUrl = (slug: string) => `${origin()}/${slug}`;
export const manageUrl = (token: string) => `${origin()}/r/${token}`;

// ---------- Zonas horarias ----------
export function validTz(tz: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
function tzOffsetMs(ts: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ts));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ts / 1000) * 1000;
}
/** «2026-10-01» + «09:00» en `tz` → instante (ms). Dos pasadas para los cambios de horario. */
export function zonedToUtc(date: string, hhmm: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return guess - tzOffsetMs(guess - tzOffsetMs(guess, tz), tz);
}
const localDate = (ms: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

// ---------- Página y anfitriones ----------
interface Host { id: string; name: string; email: string; avatarFileId: string | null; position: number }
interface Page {
  id: string; slug: string; ownerId: string; orgId: string | null; title: string; titleEn: string | null; description: string; descriptionEn: string | null;
  mode: 'collective' | 'round_robin'; durationMin: number; bufferMin: number; stepMin: number; minNoticeMin: number; horizonDays: number;
  timezone: string; hours: BookingHours; active: boolean; hosts: Host[];
}
const avatar = (fileId: string | null) => (fileId ? `/api/v1/avatars/${fileId}` : null);
const hostDTO = (h: Host): BookingHostDTO => ({ id: h.id, name: h.name, avatarUrl: avatar(h.avatarFileId) });

async function loadPage(where: 'slug' | 'id', value: string, db: { query: Tx['query'] } = pool): Promise<Page | null> {
  const { rows } = await db.query(`SELECT * FROM booking_pages WHERE ${where} = $1`, [value]);
  const r = rows[0];
  if (!r) return null;
  const hosts = await db.query(
    `SELECT u.id, u.name, u.email, u.avatar_file_id, h.position FROM booking_page_hosts h JOIN users u ON u.id = h.user_id
      WHERE h.page_id = $1 AND u.disabled_at IS NULL ORDER BY h.position, u.name`, [r.id]);
  return {
    id: r.id, slug: r.slug, ownerId: r.owner_id, orgId: r.org_id, title: r.title, titleEn: r.title_en, description: r.description, descriptionEn: r.description_en,
    mode: r.mode, durationMin: r.duration_min, bufferMin: r.buffer_min, stepMin: r.step_min, minNoticeMin: r.min_notice_min, horizonDays: r.horizon_days,
    timezone: r.timezone, hours: r.hours, active: r.active,
    hosts: hosts.rows.map((h) => ({ id: h.id, name: h.name, email: h.email, avatarFileId: h.avatar_file_id, position: h.position })),
  };
}
async function pageBySlug(slug: string): Promise<Page> {
  const p = await loadPage('slug', slug.toLowerCase());
  if (!p || !p.active || !p.hosts.length) throw notFound('Página de citas');
  return p;
}

async function publicDTO(p: Page, lang: 'es' | 'en'): Promise<BookingPagePublicDTO> {
  const org = p.orgId ? (await pool.query('SELECT name FROM organizations WHERE id = $1', [p.orgId])).rows[0]?.name ?? null : null;
  const states = await Promise.all(p.hosts.map((h) => connectedCalendar(h.id)));
  return {
    slug: p.slug, title: (lang === 'en' && p.titleEn) || p.title, description: (lang === 'en' && p.descriptionEn) || p.description,
    durationMin: p.durationMin, timezone: p.timezone, orgName: org, hosts: p.hosts.map(hostDTO), mode: p.mode, minNoticeMin: p.minNoticeMin, horizonDays: p.horizonDays,
    ready: states.some((s) => !!s.provider),
  };
}
export async function publicPage(slug: string, lang: 'es' | 'en'): Promise<BookingPagePublicDTO> { return publicDTO(await pageBySlug(slug), lang); }

// ---------- Disponibilidad ----------
interface HostBusy { host: Host; calendar: CalendarProvider | 'none' | 'reconnect' | 'error'; intervals: Interval[] }

async function hostBusy(h: Host, from: number, to: number, tz: string, o: { fresh?: boolean; ignoreBookingId?: string; ignoreExternalId?: string }): Promise<HostBusy> {
  const [agenda, booked, external] = await Promise.all([
    pool.query(
      `SELECT e.starts_at, e.ends_at FROM calendar_events e JOIN calendar_event_invitees i ON i.event_id = e.id
        WHERE i.user_id = $1 AND i.rsvp <> 'no' AND e.cancelled_at IS NULL AND e.starts_at < $3 AND e.ends_at > $2`, [h.id, iso(from), iso(to)]),
    pool.query(
      `SELECT starts_at, ends_at FROM bookings
        WHERE host_ids @> ARRAY[$1]::uuid[] AND starts_at < $3 AND ends_at > $2 AND ($4::uuid IS NULL OR id <> $4)
          AND (status = 'confirmed' OR (status = 'pending' AND created_at > now() - make_interval(mins => $5)))`,
      [h.id, iso(from), iso(to), o.ignoreBookingId ?? null, HOLD_MIN]),
    busyIntervals(h.id, from, to, tz, !!o.fresh, o.ignoreExternalId),
  ]);
  const own: Interval[] = [...agenda.rows, ...booked.rows].map((r) => [new Date(r.starts_at).getTime(), new Date(r.ends_at).getTime()]);
  const calendar = external.state === 'ok' ? external.provider : external.state;
  return { host: h, calendar, intervals: [...own, ...external.intervals] };
}

const overlaps = (list: Interval[], s: number, e: number) => list.some(([a, b]) => a < e && b > s);

interface Slot { start: number; hostIds: string[]; organizerId: string }

/** Horarios libres en [from, to) (ms). `ignore*` permite mover una cita sobre su propio horario. */
async function availability(p: Page, from: number, to: number, o: { fresh?: boolean; ignoreBookingId?: string; ignoreExternalId?: string; onlyHostIds?: string[] } = {}): Promise<Slot[]> {
  const now = Date.now();
  const lo = Math.max(from, now + p.minNoticeMin * MIN);
  const hi = Math.min(to, now + p.horizonDays * DAY);
  if (hi <= lo) return [];
  const dur = p.durationMin * MIN, buf = p.bufferMin * MIN;

  // Candidatos: tramos del horario de atención, día por día en la zona de la página.
  const cand: number[] = [];
  for (let d = localDate(lo - DAY, p.timezone), end = localDate(hi + DAY, p.timezone); d <= end; d = nextDate(d)) {
    for (const [a, b] of p.hours[String(weekday(d))] ?? []) {
      const s0 = zonedToUtc(d, a, p.timezone), e0 = zonedToUtc(d, b, p.timezone);
      for (let t = s0; t + dur <= e0; t += p.stepMin * MIN) if (t >= lo && t < hi) cand.push(t);
    }
  }
  if (!cand.length) return [];

  const busy = await Promise.all(p.hosts.map((h) => hostBusy(h, lo - buf, hi + dur + buf, p.timezone, o)));
  const free = (b: HostBusy, t: number) => b.calendar !== 'error' && !overlaps(b.intervals, t - buf, t + dur + buf);
  const connected = busy.filter((b) => (b.calendar === 'google' || b.calendar === 'microsoft') && (!o.onlyHostIds || p.mode === 'collective' || o.onlyHostIds.includes(b.host.id)));
  if (!connected.length) return [];

  if (p.mode === 'collective') {
    // El primero con calendario conectado organiza; los demás van de invitados. Todos tienen que estar libres.
    const organizer = connected[0]!.host;
    return cand.filter((t) => busy.every((b) => free(b, t))).map((t) => ({ start: t, hostIds: [organizer.id, ...p.hosts.filter((h) => h.id !== organizer.id).map((h) => h.id)], organizerId: organizer.id }));
  }
  // round_robin: solo quienes tienen calendario conectado; gana quien tenga menos citas por delante.
  const load = new Map<string, number>((await pool.query(
    `SELECT u AS id, count(*)::int AS n FROM bookings, unnest(host_ids) AS u WHERE status = 'confirmed' AND starts_at > now() AND u = ANY($1::uuid[]) GROUP BY u`,
    [connected.map((b) => b.host.id)])).rows.map((r) => [r.id as string, r.n as number]));
  const out: Slot[] = [];
  for (const t of cand) {
    const ok = connected.filter((b) => free(b, t)).sort((a, b) => (load.get(a.host.id) ?? 0) - (load.get(b.host.id) ?? 0) || a.host.position - b.host.position);
    if (ok.length) out.push({ start: t, hostIds: [ok[0]!.host.id], organizerId: ok[0]!.host.id });
  }
  return out;
}

export async function slots(slug: string, fromIso: string, toIso: string): Promise<BookingSlotsDTO> {
  const p = await pageBySlug(slug);
  const from = Date.parse(fromIso), to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw badRequest('Rango de fechas inválido');
  if (to - from > MAX_WINDOW_DAYS * DAY) throw badRequest(`Pide como máximo ${MAX_WINDOW_DAYS} días`);
  return { slots: (await availability(p, from, to)).map((s) => iso(s.start)), timezone: p.timezone };
}

// ---------- Reservar ----------
interface BookingRow {
  id: string; page_id: string; starts_at: Date; ends_at: Date; guest_name: string; guest_email: string; guest_note: string; guest_tz: string; lang: 'es' | 'en';
  organizer_id: string; host_ids: string[]; status: string; provider: CalendarProvider | null; external_id: string | null; join_url: string | null;
}
const lockHosts = async (c: Tx, ids: string[]) => { for (const id of [...ids].sort()) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`booking:${id}`]); };
const newToken = () => randomBytes(32).toString('base64url');

async function overlapFor(c: Tx, hostIds: string[], s: number, e: number, ignoreId?: string) {
  const r = await c.query(
    `SELECT 1 FROM bookings WHERE host_ids && $1::uuid[] AND starts_at < $3 AND ends_at > $2 AND ($4::uuid IS NULL OR id <> $4)
        AND (status = 'confirmed' OR (status = 'pending' AND created_at > now() - make_interval(mins => $5))) LIMIT 1`,
    [hostIds, iso(s), iso(e), ignoreId ?? null, HOLD_MIN]);
  return !!r.rowCount;
}
const slotTaken = () => new ApiError(409, 'slot_taken', 'Ese horario ya no está disponible. Elige otro.');

function bookingDTO(b: BookingRow, p: Page, pub: BookingPagePublicDTO, token?: string): BookingDTO {
  return {
    status: b.status === 'cancelled' ? 'cancelled' : 'confirmed', startsAt: new Date(b.starts_at).toISOString(), endsAt: new Date(b.ends_at).toISOString(),
    guestName: b.guest_name, guestEmail: b.guest_email, note: b.guest_note, joinUrl: b.join_url,
    hosts: p.hosts.filter((h) => b.host_ids.includes(h.id)).map(hostDTO), page: pub, ...(token ? { manageToken: token } : {}),
  };
}
const eventOf = (p: Page, b: { id: string; guest_name: string; guest_email: string; guest_note: string }, hosts: string[], startsAt: number, organizerId: string) => ({
  key: b.id, title: `${p.title}: ${b.guest_name}`,
  description: [b.guest_note ? `Nota de ${b.guest_name}: ${b.guest_note}` : '', `Reservado en ${pageUrl(p.slug)}`].filter(Boolean).join('\n\n'),
  startsAt: iso(startsAt), endsAt: iso(startsAt + p.durationMin * MIN), timezone: p.timezone,
  attendees: [{ email: b.guest_email, name: b.guest_name }, ...p.hosts.filter((h) => hosts.includes(h.id) && h.id !== organizerId).map((h) => ({ email: h.email, name: h.name }))],
});

export async function book(slug: string, input: { startsAt: string; name: string; email: string; note?: string; timezone: string; lang: 'es' | 'en'; website?: string }): Promise<BookingDTO> {
  if (input.website) throw badRequest('Solicitud inválida'); // campo trampa
  const p = await pageBySlug(slug);
  const start = Date.parse(input.startsAt);
  if (!Number.isFinite(start)) throw badRequest('Horario inválido');
  const tz = validTz(input.timezone) ? input.timezone : 'UTC';
  const end = start + p.durationMin * MIN;

  // Se vuelve a calcular en fresco: el calendario pudo cambiar desde que el tercero vio la lista.
  const slot = (await availability(p, start, start + 1, { fresh: true })).find((s) => s.start === start);
  if (!slot) throw slotTaken();

  const token = newToken();
  const id = await tx(async (c) => {
    await lockHosts(c, slot.hostIds);
    if (await overlapFor(c, slot.hostIds, start - p.bufferMin * MIN, end + p.bufferMin * MIN)) throw slotTaken();
    const n = await c.query(
      `SELECT count(*) FILTER (WHERE status = 'confirmed' AND starts_at > now())::int AS active, count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS recent
         FROM bookings WHERE lower(guest_email) = $1`, [input.email]);
    if (n.rows[0].active >= MAX_ACTIVE_PER_EMAIL || n.rows[0].recent >= MAX_PER_HOUR_PER_EMAIL) throw new ApiError(429, 'too_many_bookings', 'Ya tienes varias citas reservadas. Cancela alguna o espera un poco.');
    const { rows } = await c.query(
      `INSERT INTO bookings (page_id, starts_at, ends_at, guest_name, guest_email, guest_note, guest_tz, lang, organizer_id, host_ids, status, manage_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) RETURNING id`,
      [p.id, iso(start), iso(end), input.name, input.email, input.note ?? '', tz, input.lang, slot.organizerId, slot.hostIds, sha(token)]);
    return rows[0].id as string;
  });

  const row = { id, guest_name: input.name, guest_email: input.email, guest_note: input.note ?? '' };
  try {
    const ev = await createCalendarEvent(slot.organizerId, eventOf(p, row, slot.hostIds, start, slot.organizerId));
    await pool.query("UPDATE bookings SET status = 'confirmed', provider = $2, external_id = $3, join_url = $4, confirmed_at = now() WHERE id = $1", [id, ev.provider, ev.externalId, ev.joinUrl]);
  } catch (e: any) {
    await pool.query("UPDATE bookings SET status = 'failed' WHERE id = $1", [id]);
    console.log(`[booking] no se pudo crear el evento de ${id}: ${e?.message ?? e}`);
    throw new ApiError(502, 'calendar_unavailable', 'No pudimos crear la cita en el calendario. Inténtalo de nuevo en un momento.');
  }
  forgetBusy(slot.organizerId);
  const b = await bookingRow(id);
  const pub = await publicDTO(p, input.lang);
  void notifyGuest('confirmed', b, p, pub, token);
  void notifyHosts('confirmed', b, p);
  await audit(pool as any, null, 'booking.created', { type: 'booking', id }, { page: p.slug });
  return bookingDTO(b, p, pub, token);
}

async function bookingRow(id: string): Promise<BookingRow> {
  const r = (await pool.query('SELECT * FROM bookings WHERE id = $1', [id])).rows[0];
  if (!r) throw notFound('Cita');
  return r;
}
async function bookingByToken(token: string): Promise<{ b: BookingRow; p: Page }> {
  const b: BookingRow | undefined = (await pool.query('SELECT * FROM bookings WHERE manage_hash = $1', [sha(token)])).rows[0];
  if (!b || b.status === 'pending' || b.status === 'failed') throw notFound('Cita');
  const p = await loadPage('id', b.page_id);
  if (!p) throw notFound('Cita');
  return { b, p };
}

function notifyGuest(kind: 'confirmed' | 'rescheduled' | 'cancelled', b: BookingRow, p: Page, pub: BookingPagePublicDTO, token: string) {
  return trySendMail(bookingMail({
    kind, lang: b.lang, to: b.guest_email, guestName: b.guest_name, title: pub.title, hosts: p.hosts.filter((h) => b.host_ids.includes(h.id)).map((h) => h.name),
    startsAt: new Date(b.starts_at), endsAt: new Date(b.ends_at), timezone: validTz(b.guest_tz) ? b.guest_tz : p.timezone, joinUrl: b.join_url,
    manageUrl: manageUrl(token), pageUrl: pageUrl(p.slug),
  }));
}

/** gg le escribe directo a cada anfitrión: así se entera al instante de que alguien reservó, cambió o canceló. */
async function notifyHosts(kind: 'confirmed' | 'rescheduled' | 'cancelled', b: BookingRow, p: Page, by: 'guest' | 'host' = 'guest') {
  const fmt = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: p.timezone, timeZoneName: 'short' });
  const when = fmt.format(new Date(b.starts_at));
  const who = `${b.guest_name} (${b.guest_email})`;
  const others = p.hosts.filter((h) => b.host_ids.includes(h.id));
  const lines = {
    confirmed: [`🗓️ ¡Nueva cita en «${p.title}»!`, `${who} reservó contigo ${when}.`],
    rescheduled: [`🔁 Cambió una cita de «${p.title}»`, `${who} la movió a ${when}.`],
    cancelled: [`❌ Se canceló una cita de «${p.title}»`, `${who} ${by === 'guest' ? 'canceló' : 'fue cancelada'} la del ${when}.`],
  }[kind];
  if (kind !== 'cancelled' && others.length > 1) lines.push(`Con: ${others.map((h) => h.name).join(', ')}.`);
  if (kind !== 'cancelled' && b.guest_note) lines.push(`Dejó una nota: «${b.guest_note.slice(0, 300)}»`);
  if (kind !== 'cancelled' && b.join_url) lines.push(`🎥 ${b.join_url}`);
  if (kind === 'confirmed') lines.push('Ya está en tu calendario. Si no puedes, cancélala en Ajustes › Citas.');
  const body = lines.join('\n');
  for (const hostId of b.host_ids) {
    try {
      const dm = await getOrCreateDirect(hostId, GG_ID);
      await tx((c) => appendMessage(c, { conversationId: dm.id, authorId: GG_ID, kind: 'text', body }));
    } catch (e: any) { console.log(`[booking] gg no pudo avisar a ${hostId}: ${e?.message ?? e}`); }
  }
}

// ---------- Cambiar o cancelar (por el enlace del tercero) ----------
export async function viewBooking(token: string, lang: 'es' | 'en'): Promise<BookingDTO> {
  const { b, p } = await bookingByToken(token);
  return bookingDTO(b, p, await publicDTO(p, lang));
}

async function cancel(b: BookingRow, p: Page, by: 'guest' | 'host', token: string | null) {
  if (b.status === 'cancelled') return;
  if (new Date(b.starts_at).getTime() < Date.now()) throw badRequest('La cita ya pasó');
  if (b.provider && b.external_id) {
    try { await cancelCalendarEvent(b.organizer_id, b.provider, b.external_id); }
    catch (e: any) { console.log(`[booking] no se pudo cancelar el evento de ${b.id}: ${e?.message ?? e}`); throw new ApiError(502, 'calendar_unavailable', 'No pudimos cancelar en el calendario. Inténtalo de nuevo.'); }
  }
  await pool.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2 WHERE id = $1", [b.id, by]);
  for (const h of b.host_ids) forgetBusy(h);
  void notifyHosts('cancelled', { ...b, status: 'cancelled' }, p, by);
  if (token) void notifyGuest('cancelled', { ...b, status: 'cancelled' }, p, await publicDTO(p, b.lang), token);
}

export async function cancelByToken(token: string, lang: 'es' | 'en'): Promise<BookingDTO> {
  const { b, p } = await bookingByToken(token);
  await cancel(b, p, 'guest', token);
  return viewBooking(token, lang);
}

export async function rescheduleByToken(token: string, startsAt: string, lang: 'es' | 'en'): Promise<BookingDTO> {
  const { b, p } = await bookingByToken(token);
  if (b.status !== 'confirmed') throw badRequest('Esta cita está cancelada');
  if (new Date(b.starts_at).getTime() < Date.now()) throw badRequest('La cita ya pasó');
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) throw badRequest('Horario inválido');
  const end = start + p.durationMin * MIN;
  const slot = (await availability(p, start, start + 1, { fresh: true, ignoreBookingId: b.id, ignoreExternalId: b.external_id ?? undefined, onlyHostIds: b.host_ids })).find((s) => s.start === start);
  // Se conserva a quienes ya tenían la cita: moverla no cambia el organizador ni el evento.
  if (!slot) throw slotTaken();
  const old = { s: new Date(b.starts_at), e: new Date(b.ends_at) };
  await tx(async (c) => {
    await lockHosts(c, b.host_ids);
    if (await overlapFor(c, b.host_ids, start - p.bufferMin * MIN, end + p.bufferMin * MIN, b.id)) throw slotTaken();
    await c.query('UPDATE bookings SET starts_at = $2, ends_at = $3 WHERE id = $1', [b.id, iso(start), iso(end)]);
  });
  try {
    if (b.provider && b.external_id) await moveCalendarEvent(b.organizer_id, b.provider, b.external_id, iso(start), iso(end), p.timezone);
  } catch (e: any) {
    await pool.query('UPDATE bookings SET starts_at = $2, ends_at = $3 WHERE id = $1', [b.id, old.s.toISOString(), old.e.toISOString()]);
    console.log(`[booking] no se pudo mover el evento de ${b.id}: ${e?.message ?? e}`);
    throw new ApiError(502, 'calendar_unavailable', 'No pudimos cambiar la cita en el calendario. Inténtalo de nuevo.');
  }
  for (const h of b.host_ids) forgetBusy(h);
  const moved = await bookingRow(b.id);
  const pub = await publicDTO(p, lang);
  void notifyGuest('rescheduled', moved, p, pub, token);
  void notifyHosts('rescheduled', moved, p);
  return bookingDTO(moved, p, pub);
}

// ---------- Administración (autenticado) ----------
const isMemberWith = async (userId: string, otherIds: string[]) => {
  if (!otherIds.length) return true;
  const { rows } = await pool.query(
    `SELECT count(DISTINCT m2.user_id)::int AS n FROM organization_memberships m1 JOIN organization_memberships m2 ON m2.org_id = m1.org_id
      WHERE m1.user_id = $1 AND m2.user_id = ANY($2::uuid[])`, [userId, otherIds]);
  return rows[0].n === new Set(otherIds).size;
};

async function adminDTO(p: Page): Promise<BookingPageDTO> {
  const pub = await publicDTO(p, 'es');
  const hostsStatus: BookingHostStatusDTO[] = await Promise.all(p.hosts.map(async (h) => {
    const s = await connectedCalendar(h.id);
    return { ...hostDTO(h), email: h.email, calendar: s.provider ?? (s.reconnect ? 'reconnect' : 'none') };
  }));
  const up = await pool.query("SELECT count(*)::int AS n FROM bookings WHERE page_id = $1 AND status = 'confirmed' AND starts_at > now()", [p.id]);
  return { ...pub, id: p.id, ownerId: p.ownerId, titleEn: p.titleEn, descriptionEn: p.descriptionEn, bufferMin: p.bufferMin, stepMin: p.stepMin, hours: p.hours, active: p.active, hostsStatus, url: pageUrl(p.slug), upcoming: up.rows[0].n };
}

export async function myPages(userId: string): Promise<BookingPageDTO[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id, p.created_at FROM booking_pages p LEFT JOIN booking_page_hosts h ON h.page_id = p.id
      WHERE p.owner_id = $1 OR h.user_id = $1 ORDER BY p.created_at`, [userId]);
  const out: BookingPageDTO[] = [];
  for (const r of rows) { const p = await loadPage('id', r.id); if (p) out.push(await adminDTO(p)); }
  return out;
}

const checkHours = (hours: BookingHours) => {
  for (const ranges of Object.values(hours)) for (const [a, b] of ranges) if (a >= b) throw badRequest('En el horario, cada tramo debe terminar después de empezar');
};

export async function createPage(userId: string, input: Input): Promise<BookingPageDTO> {
  if (RESERVED.has(input.slug)) throw badRequest('Ese nombre está reservado; elige otro');
  if (!validTz(input.timezone)) throw badRequest('Zona horaria inválida');
  checkHours(input.hours);
  const hostIds = [...new Set(input.hostIds)];
  if (!(await isMemberWith(userId, hostIds.filter((h) => h !== userId)))) throw forbidden('Solo puedes elegir como anfitriones a personas de tu empresa');
  const id = await tx(async (c) => {
    if ((await c.query('SELECT 1 FROM booking_pages WHERE slug = $1', [input.slug])).rowCount) throw new ApiError(409, 'slug_taken', 'Ese enlace ya está en uso');
    const org = (await c.query('SELECT primary_org_id FROM users WHERE id = $1', [userId])).rows[0]?.primary_org_id ?? null;
    const { rows } = await c.query(
      `INSERT INTO booking_pages (slug, owner_id, org_id, title, title_en, description, description_en, mode, duration_min, buffer_min, step_min, min_notice_min, horizon_days, timezone, hours, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [input.slug, userId, org, input.title, input.titleEn ?? null, input.description, input.descriptionEn ?? null, input.mode, input.durationMin, input.bufferMin, input.stepMin, input.minNoticeMin, input.horizonDays, input.timezone, JSON.stringify(input.hours), input.active]);
    for (const [i, h] of hostIds.entries()) await c.query('INSERT INTO booking_page_hosts (page_id, user_id, position) VALUES ($1,$2,$3)', [rows[0].id, h, i]);
    await audit(c, userId, 'booking.page_created', { type: 'booking_page', id: rows[0].id }, { slug: input.slug });
    return rows[0].id as string;
  });
  return adminDTO((await loadPage('id', id))!);
}

export async function updatePage(userId: string, id: string, patch: Patch): Promise<BookingPageDTO> {
  const cur = await loadPage('id', id);
  if (!cur) throw notFound('Página de citas');
  if (cur.ownerId !== userId) throw forbidden('Solo quien la creó puede cambiarla');
  if (patch.slug && RESERVED.has(patch.slug)) throw badRequest('Ese nombre está reservado; elige otro');
  if (patch.timezone && !validTz(patch.timezone)) throw badRequest('Zona horaria inválida');
  if (patch.hours) checkHours(patch.hours);
  const hostIds = patch.hostIds ? [...new Set(patch.hostIds)] : null;
  if (hostIds && !(await isMemberWith(userId, hostIds.filter((h) => h !== userId)))) throw forbidden('Solo puedes elegir como anfitriones a personas de tu empresa');
  await tx(async (c) => {
    if (patch.slug && patch.slug !== cur.slug && (await c.query('SELECT 1 FROM booking_pages WHERE slug = $1', [patch.slug])).rowCount) throw new ApiError(409, 'slug_taken', 'Ese enlace ya está en uso');
    const cols: Record<string, unknown> = {
      slug: patch.slug, title: patch.title, title_en: patch.titleEn, description: patch.description, description_en: patch.descriptionEn, mode: patch.mode,
      duration_min: patch.durationMin, buffer_min: patch.bufferMin, step_min: patch.stepMin, min_notice_min: patch.minNoticeMin, horizon_days: patch.horizonDays,
      timezone: patch.timezone, hours: patch.hours === undefined ? undefined : JSON.stringify(patch.hours), active: patch.active,
    };
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (set.length) await c.query(`UPDATE booking_pages SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...set.map(([, v]) => v)]);
    if (hostIds) {
      await c.query('DELETE FROM booking_page_hosts WHERE page_id = $1', [id]);
      for (const [i, h] of hostIds.entries()) await c.query('INSERT INTO booking_page_hosts (page_id, user_id, position) VALUES ($1,$2,$3)', [id, h, i]);
    }
    await audit(c, userId, 'booking.page_updated', { type: 'booking_page', id });
  });
  return adminDTO((await loadPage('id', id))!);
}

/** Citas de las páginas donde soy anfitrión o dueño (próximas primero). */
export async function hostBookings(userId: string): Promise<BookingHostBookingDTO[]> {
  const { rows } = await pool.query(
    `SELECT b.*, p.title AS page_title FROM bookings b JOIN booking_pages p ON p.id = b.page_id
      WHERE b.status IN ('confirmed','cancelled') AND b.ends_at > now() - interval '1 day' AND (p.owner_id = $1 OR b.host_ids @> ARRAY[$1]::uuid[])
      ORDER BY b.starts_at LIMIT 200`, [userId]);
  return rows.map((b) => ({
    id: b.id, pageId: b.page_id, pageTitle: b.page_title, startsAt: new Date(b.starts_at).toISOString(), endsAt: new Date(b.ends_at).toISOString(),
    guestName: b.guest_name, guestEmail: b.guest_email, note: b.guest_note, joinUrl: b.join_url, status: b.status === 'cancelled' ? 'cancelled' : 'confirmed', hostIds: b.host_ids,
  }));
}

export async function cancelAsHost(userId: string, bookingId: string) {
  const b: BookingRow | undefined = (await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId])).rows[0];
  if (!b) throw notFound('Cita');
  const p = await loadPage('id', b.page_id);
  if (!p || (p.ownerId !== userId && !b.host_ids.includes(userId))) throw forbidden();
  if (b.status === 'cancelled') return { ok: true };
  // Quien cancela no tiene el enlace del tercero: el aviso lleva el de la página, para volver a reservar.
  await cancel(b, p, 'host', null);
  void notifyGuest('cancelled', { ...b, status: 'cancelled' }, p, await publicDTO(p, b.lang), '');
  return { ok: true };
}
