import { pool } from '../db.ts';
import { ApiError } from '../errors.ts';
import { ProviderError, accessToken, apiBase, meetUrl, request } from './meetings.ts';

/**
 * Calendarios reales de quienes atienden las citas (docs/CITAS.md).
 * - Se lee la agenda con la MISMA conexión de Reuniones (Google `calendar.events.owned`, Microsoft `Calendars.ReadWrite`):
 *   no se pide ningún permiso nuevo. Solo se miran horas ocupadas; no se guarda ni se muestra el contenido de los eventos.
 * - El evento de la cita se crea en el calendario de quien organiza, con Meet o Teams, y el proveedor invita al tercero.
 */

export type CalendarProvider = 'google' | 'microsoft';
export type Interval = [number, number];
export type BusyResult =
  | { state: 'ok'; provider: CalendarProvider; intervals: Interval[] }
  | { state: 'none'; intervals: [] }
  | { state: 'reconnect'; provider: CalendarProvider; intervals: [] }
  | { state: 'error'; intervals: [] };

/** Proveedor de calendario conectado y activo de una persona (Google primero). */
export async function connectedCalendar(userId: string): Promise<{ provider: CalendarProvider | null; reconnect: boolean }> {
  const { rows } = await pool.query("SELECT provider, status FROM meeting_connections WHERE user_id = $1 AND provider IN ('google','microsoft')", [userId]);
  const active = (['google', 'microsoft'] as const).find((p) => rows.some((r) => r.provider === p && r.status === 'active'));
  return { provider: active ?? null, reconnect: !active && rows.some((r) => r.status === 'reconnect') };
}

// ---------- Horas ocupadas ----------
const cache = new Map<string, { at: number; value: BusyResult }>();
const CACHE_MS = Number(process.env.BOOKING_CACHE_MS ?? 45_000);

/** Ocupado entre `from` y `to` (ms). `tz` interpreta los eventos de todo el día. Se guarda 45 s en memoria por persona. */
export async function busyIntervals(userId: string, from: number, to: number, tz: string, fresh = false, ignoreExternalId?: string): Promise<BusyResult> {
  const key = `${userId}|${Math.floor(from / 3_600_000)}|${Math.ceil(to / 3_600_000)}`;
  const hit = cache.get(key);
  if (!fresh && !ignoreExternalId && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load(userId, from, to, tz, ignoreExternalId);
  // Lo que se calculó ignorando un evento no sirve para los demás: no se guarda.
  if (!ignoreExternalId) {
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), value });
  }
  return value;
}
export const forgetBusy = (userId: string) => { for (const k of cache.keys()) if (k.startsWith(`${userId}|`)) cache.delete(k); };

async function load(userId: string, from: number, to: number, tz: string, ignore?: string): Promise<BusyResult> {
  const { provider, reconnect } = await connectedCalendar(userId);
  if (!provider) return reconnect ? { state: 'reconnect', provider: 'google', intervals: [] } : { state: 'none', intervals: [] };
  try {
    const { access } = await accessToken(userId, provider);
    const intervals = provider === 'google' ? await googleBusy(access, from, to, tz, ignore) : await microsoftBusy(access, from, to, ignore);
    return { state: 'ok', provider, intervals };
  } catch (e: any) {
    if (e instanceof ApiError && e.code === 'reconnect_required') return { state: 'reconnect', provider, intervals: [] };
    if (e instanceof ApiError && e.code === 'not_connected') return { state: 'none', intervals: [] };
    if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) return { state: 'reconnect', provider, intervals: [] };
    console.log(`[booking] no se pudo leer el calendario de ${userId} (${provider}): ${e?.message ?? e}`);
    return { state: 'error', intervals: [] };
  }
}

const gBase = () => apiBase('MEETINGS_GOOGLE_API', 'https://www.googleapis.com/calendar/v3');
const msBase = () => apiBase('MEETINGS_MS_API', 'https://graph.microsoft.com/v1.0');

async function getJson(url: string, access: string, headers: Record<string, string> = {}) {
  const res = await request(url, { headers: { authorization: `Bearer ${access}`, ...headers } });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(res.status, j?.error?.code ?? j?.error?.status ?? 'calendar_failed', `El calendario respondió HTTP ${res.status}`);
  return j;
}

/** «2026-10-01» a las 00:00 en `tz`, en ms. Para los eventos de todo el día de Google. */
function startOfDay(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return guess - (asUtc - guess);
}

async function googleBusy(access: string, from: number, to: number, tz: string, ignore?: string): Promise<Interval[]> {
  const out: Interval[] = [];
  let pageToken = '';
  for (let i = 0; i < 6; i++) {
    const q = new URLSearchParams({
      timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
      fields: 'nextPageToken,items(id,status,transparency,start,end,attendees(self,responseStatus))',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const j = await getJson(`${gBase()}/calendars/primary/events?${q}`, access);
    for (const ev of j.items ?? []) {
      if (ev.status === 'cancelled' || ev.transparency === 'transparent' || (ignore && ev.id === ignore)) continue;
      if ((ev.attendees ?? []).some((a: any) => a.self && a.responseStatus === 'declined')) continue;
      const s = ev.start?.dateTime ? Date.parse(ev.start.dateTime) : ev.start?.date ? startOfDay(ev.start.date, tz) : NaN;
      const e = ev.end?.dateTime ? Date.parse(ev.end.dateTime) : ev.end?.date ? startOfDay(ev.end.date, tz) : NaN;
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push([s, e]);
    }
    pageToken = j.nextPageToken ?? '';
    if (!pageToken) return out;
  }
  // Más de 1 500 eventos en la ventana: no se puede afirmar qué está libre.
  throw new ProviderError(502, 'too_many_events', 'Demasiados eventos en la ventana');
}

async function microsoftBusy(access: string, from: number, to: number, ignore?: string): Promise<Interval[]> {
  const out: Interval[] = [];
  const q = new URLSearchParams({ startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(), $select: 'id,start,end,showAs,isCancelled', $top: '250' });
  let url: string | null = `${msBase()}/me/calendarView?${q}`;
  for (let i = 0; url && i < 6; i++) {
    const j: any = await getJson(url, access, { prefer: 'outlook.timezone="UTC"' });
    for (const ev of j.value ?? []) {
      if (ev.isCancelled || ev.showAs === 'free' || (ignore && ev.id === ignore)) continue;
      const s = Date.parse(`${String(ev.start?.dateTime).replace(/Z$/, '').slice(0, 19)}Z`);
      const e = Date.parse(`${String(ev.end?.dateTime).replace(/Z$/, '').slice(0, 19)}Z`);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push([s, e]);
    }
    url = j['@odata.nextLink'] ?? null;
  }
  if (url) throw new ProviderError(502, 'too_many_events', 'Demasiados eventos en la ventana');
  return out;
}

// ---------- Crear, mover y cancelar el evento ----------
export interface EventInput {
  /** Llave estable de la cita (su id): reintentar no duplica el evento. */
  key: string; title: string; description: string; startsAt: string; endsAt: string; timezone: string;
  attendees: { email: string; name: string }[];
}
export interface CreatedEvent { provider: CalendarProvider; externalId: string; joinUrl: string | null }

export async function createCalendarEvent(organizerId: string, e: EventInput): Promise<CreatedEvent> {
  const { provider } = await connectedCalendar(organizerId);
  if (!provider) throw new ApiError(409, 'organizer_not_connected', 'Quien atiende no tiene un calendario conectado');
  const { access } = await accessToken(organizerId, provider);
  return provider === 'google' ? googleCreate(access, e) : microsoftCreate(access, e);
}

async function googleCreate(access: string, e: EventInput): Promise<CreatedEvent> {
  // Los ids de evento de Google aceptan base32hex: un uuid sin guiones es válido y hace el POST idempotente.
  const id = e.key.replace(/-/g, '');
  const read = async () => {
    const r = await request(`${gBase()}/calendars/primary/events/${id}`, { headers: { authorization: `Bearer ${access}` } });
    return r.ok ? await r.json().catch(() => null) as any : null;
  };
  let ev: any = await read();
  if (ev?.status === 'cancelled') throw new ApiError(409, 'slot_failed', 'El evento de esta cita fue cancelado');
  if (!ev) {
    const res = await request(`${gBase()}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, {
      method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id, summary: e.title, description: e.description,
        start: { dateTime: e.startsAt, timeZone: e.timezone }, end: { dateTime: e.endsAt, timeZone: e.timezone },
        attendees: e.attendees.map((a) => ({ email: a.email, displayName: a.name })),
        conferenceData: { createRequest: { requestId: e.key, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
        guestsCanModify: false, guestsCanInviteOthers: false,
      }),
    });
    if (res.status === 409) ev = await read();
    else {
      ev = await res.json().catch(() => ({}));
      if (!res.ok) throw new ProviderError(res.status, 'google_failed', `Google respondió HTTP ${res.status}`);
    }
  }
  let url = meetUrl(ev);
  // Meet a veces tarda un instante en salir: una relectura corta antes de rendirse.
  for (let i = 0; !url && i < 3; i++) { await new Promise((r) => setTimeout(r, 700)); url = meetUrl(await read()); }
  return { provider: 'google', externalId: id, joinUrl: url };
}

/** Graph quiere la hora local de la zona indicada, sin desfase. */
const localIso = (iso: string, tz: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(' ', 'T');

async function microsoftCreate(access: string, e: EventInput): Promise<CreatedEvent> {
  const res = await request(`${msBase()}/me/events`, {
    method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', prefer: `outlook.timezone="${e.timezone}"` },
    body: JSON.stringify({
      subject: e.title, body: { contentType: 'text', content: e.description },
      start: { dateTime: localIso(e.startsAt, e.timezone), timeZone: e.timezone }, end: { dateTime: localIso(e.endsAt, e.timezone), timeZone: e.timezone },
      attendees: e.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name }, type: 'required' })),
      isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', transactionId: e.key.slice(0, 64),
    }),
  });
  const ev: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(res.status, ev?.error?.code ?? 'microsoft_failed', `Microsoft respondió HTTP ${res.status}`);
  return { provider: 'microsoft', externalId: ev.id, joinUrl: ev?.onlineMeeting?.joinUrl ?? null };
}

/** Mueve el evento (mismo enlace de Meet/Teams) y avisa a los invitados. */
export async function moveCalendarEvent(organizerId: string, provider: CalendarProvider, externalId: string, startsAt: string, endsAt: string, timezone: string) {
  const { access } = await accessToken(organizerId, provider);
  if (provider === 'google') {
    const res = await request(`${gBase()}/calendars/primary/events/${encodeURIComponent(externalId)}?sendUpdates=all`, {
      method: 'PATCH', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ start: { dateTime: startsAt, timeZone: timezone }, end: { dateTime: endsAt, timeZone: timezone } }),
    });
    if (!res.ok) throw new ProviderError(res.status, 'google_failed', `Google respondió HTTP ${res.status}`);
  } else {
    const res = await request(`${msBase()}/me/events/${encodeURIComponent(externalId)}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', prefer: `outlook.timezone="${timezone}"` },
      body: JSON.stringify({ start: { dateTime: localIso(startsAt, timezone), timeZone: timezone }, end: { dateTime: localIso(endsAt, timezone), timeZone: timezone } }),
    });
    if (!res.ok) throw new ProviderError(res.status, 'microsoft_failed', `Microsoft respondió HTTP ${res.status}`);
  }
  forgetBusy(organizerId);
}

/** Cancela el evento y avisa a los invitados. Si ya no existe, da lo mismo. */
export async function cancelCalendarEvent(organizerId: string, provider: CalendarProvider, externalId: string) {
  const { access } = await accessToken(organizerId, provider);
  if (provider === 'google') {
    const res = await request(`${gBase()}/calendars/primary/events/${encodeURIComponent(externalId)}?sendUpdates=all`, { method: 'DELETE', headers: { authorization: `Bearer ${access}` } });
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new ProviderError(res.status, 'google_failed', `Google respondió HTTP ${res.status}`);
  } else {
    const res = await request(`${msBase()}/me/events/${encodeURIComponent(externalId)}/cancel`, {
      method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ comment: 'Cita cancelada' }),
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new ProviderError(res.status, 'microsoft_failed', `Microsoft respondió HTTP ${res.status}`);
  }
  forgetBusy(organizerId);
}
