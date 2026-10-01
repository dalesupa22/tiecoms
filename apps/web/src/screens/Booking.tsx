/**
 * Citas por enlace (docs/CITAS.md): cita.chaggu.com/<nombre> (o app.chaggu.com/cita/<nombre>).
 * Pública, sin cuenta: la persona elige día y hora, deja su nombre y correo, y la cita queda en el calendario de
 * quien atiende con una videollamada de chaggu. Con /r/<clave> cambia o cancela. Se carga aparte de la app.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { BookingDTO, BookingHostDTO, BookingPagePublicDTO, BookingSlotsDTO } from '@tiecoms/contracts';
import { apiUrl } from '../app-client.ts';
import { errorText, getLang, locale, t } from '../i18n.ts';
import { asset, type Route } from '../router.ts';

const NAME_KEY = 'chaggu:guest-name', EMAIL_KEY = 'chaggu:guest-email';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};
const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const tzList = (): string[] => {
  try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['America/Bogota', 'America/Mexico_City', 'America/Lima', 'America/New_York', 'Europe/Madrid', 'UTC']; }
};

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const lang = getLang();
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(apiUrl(`/api/v1${path}${init.method === 'POST' || path.includes('lang=') ? '' : `${sep}lang=${lang}`}`), {
    method: init.method ?? 'GET', headers: init.body ? { 'content-type': 'application/json', 'x-tiecoms-client': 'web' } : { 'x-tiecoms-client': 'web' }, body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? ''), { code: json?.error?.code ?? 'internal', status: res.status, message: json?.error?.message ?? '' });
  return json as T;
}
const errMsg = (e: any) => (e?.code === 'slot_taken' || e?.code === 'too_many_bookings' || e?.code === 'calendar_unavailable') && e.message ? e.message : errorText(e);

// ---------- Utilidades de fecha (todo en la zona horaria elegida por quien reserva) ----------
const dayKey = (iso: string | number | Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const timeText = (iso: string, tz: string) => new Intl.DateTimeFormat(locale(), { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const longDate = (iso: string, tz: string) => new Intl.DateTimeFormat(locale(), { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
const rangeText = (b: { startsAt: string; endsAt: string }, tz: string) => `${timeText(b.startsAt, tz)} – ${new Intl.DateTimeFormat(locale(), { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(b.endsAt))}`;
const monthLabel = (y: number, m: number) => new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m, 15)));
const pad = (n: number) => String(n).padStart(2, '0');

// ---------- Marco común ----------
function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="bk-page">
      <div className={`bk-card ${wide ? 'is-wide' : ''}`}>{children}</div>
      <a className="bk-powered" href="https://www.chaggu.com" target="_blank" rel="noreferrer"><img src={asset('/chaggu-logo.svg')} alt="chaggu" height={22} /><span>{t('bk.poweredBy')}</span></a>
    </div>
  );
}

function Hosts({ hosts }: { hosts: BookingHostDTO[] }) {
  return (
    <div className="bk-hosts">
      <div className="bk-faces">
        {hosts.slice(0, 5).map((h) => h.avatarUrl
          ? <img key={h.id} src={apiUrl(h.avatarUrl)} alt={h.name} title={h.name} />
          : <span key={h.id} title={h.name} className="bk-face">{h.name.trim()[0]?.toUpperCase()}</span>)}
      </div>
      <span className="bk-host-names">{t('bk.with', { hosts: hosts.map((h) => h.name).join(', ') })}</span>
    </div>
  );
}

function Info({ page, children }: { page: BookingPagePublicDTO; children?: ReactNode }) {
  return (
    <aside className="bk-info">
      <Hosts hosts={page.hosts} />
      {page.orgName && <div className="bk-org">{page.orgName}</div>}
      <h1 className="bk-title">{page.title}</h1>
      <div className="bk-meta"><span>⏱ {t('bk.minutes', { n: page.durationMin })}</span><span>🎥 chaggu</span></div>
      {page.description && <p className="bk-desc">{page.description}</p>}
      <p className="bk-video">{t('bk.videoNote')}</p>
      {children}
    </aside>
  );
}

// ---------- Elegir día y hora ----------
function SlotPicker({ slug, tz, onTz, onPick }: { slug: string; tz: string; onTz: (tz: string) => void; onPick: (startsAt: string) => void }) {
  const now = new Date();
  const [ym, setYm] = useState<[number, number]>([now.getFullYear(), now.getMonth()]);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSlots(null); setError(null);
    // Ventana del mes en cualquier zona horaria (±14 h): luego se agrupa por día local de quien reserva.
    const from = new Date(Date.UTC(ym[0], ym[1], 1) - 14 * 3_600_000).toISOString();
    const to = new Date(Date.UTC(ym[0], ym[1] + 1, 1) + 14 * 3_600_000).toISOString();
    api<BookingSlotsDTO>(`/book/${encodeURIComponent(slug)}/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((r) => { if (live) setSlots(r.slots); }).catch((e) => { if (live) setError(errMsg(e)); });
    return () => { live = false; };
  }, [slug, ym[0], ym[1]]);

  const byDay = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of slots ?? []) { const k = dayKey(s, tz); (m.get(k) ?? m.set(k, []).get(k)!).push(s); }
    return m;
  }, [slots, tz]);
  const prefix = `${ym[0]}-${pad(ym[1] + 1)}`;
  const monthDays = [...byDay.keys()].filter((k) => k.startsWith(prefix)).sort();
  // Al cargar, se elige de una vez el primer día con horarios (menos clics).
  useEffect(() => { if (slots && (!day || !byDay.has(day) || !day.startsWith(prefix))) setDay(monthDays[0] ?? null); }, [slots, tz, prefix]);

  const first = new Date(Date.UTC(ym[0], ym[1], 1));
  const lead = (first.getUTCDay() + 6) % 7; // la semana empieza el lunes
  const total = new Date(Date.UTC(ym[0], ym[1] + 1, 0)).getUTCDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: total }, (_, i) => i + 1)];
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + i))));
  const isCurrent = ym[0] === now.getFullYear() && ym[1] === now.getMonth();
  const shift = (n: number) => setYm(([y, m]) => { const d = new Date(Date.UTC(y, m + n, 1)); return [d.getUTCFullYear(), d.getUTCMonth()]; });
  const zones = useMemo(() => { const l = tzList(); return l.includes(tz) ? l : [tz, ...l]; }, [tz]);

  return (
    <section className="bk-picker">
      <h2 className="bk-h2">{t('bk.pick')}</h2>
      <div className="bk-picker-body">
        <div className="bk-cal">
          <div className="bk-cal-head">
            <button className="bk-nav" aria-label={t('bk.prevMonth')} disabled={isCurrent} onClick={() => shift(-1)}>‹</button>
            <b className="bk-month">{monthLabel(ym[0], ym[1])}</b>
            <button className="bk-nav" aria-label={t('bk.nextMonth')} onClick={() => shift(1)}>›</button>
          </div>
          <div className="bk-grid" role="grid">
            {weekdays.map((w) => <span key={w} className="bk-wd">{w}</span>)}
            {cells.map((n, i) => {
              if (n === null) return <span key={`e${i}`} />;
              const key = `${prefix}-${pad(n)}`;
              const has = byDay.has(key);
              return <button key={key} disabled={!has} className={`bk-day ${has ? 'has' : ''} ${day === key ? 'on' : ''}`} onClick={() => setDay(key)} aria-pressed={day === key}>{n}</button>;
            })}
          </div>
          <label className="bk-tz"><span>🌎 {t('bk.tz')}</span>
            <select value={tz} onChange={(e) => onTz(e.target.value)}>{zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}</select>
          </label>
        </div>
        <div className="bk-times">
          {error ? <div className="error" role="alert">{error}</div>
            : !slots ? <p className="muted">{t('bk.loading')}</p>
            : !day ? <p className="muted">{t('bk.noSlots')}</p>
            : (
              <>
                <div className="bk-times-day">{longDate(`${day}T12:00:00Z`, 'UTC')}</div>
                <div className="bk-slots">
                  {(byDay.get(day) ?? []).map((s) => <button key={s} className="bk-slot" onClick={() => onPick(s)}>{timeText(s, tz)}</button>)}
                </div>
              </>
            )}
        </div>
      </div>
    </section>
  );
}

// ---------- Agregar al calendario ----------
const fmtZ = (iso: string) => new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, '');
function calendarLinks(b: BookingDTO) {
  const who = b.hosts.map((h) => h.name).join(', ');
  const google = `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: 'TEMPLATE', text: `${b.page.title} · ${who}`, dates: `${fmtZ(b.startsAt)}/${fmtZ(b.endsAt)}`, details: b.joinUrl ?? '', location: b.joinUrl ?? '' })}`;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//chaggu//citas//ES', 'BEGIN:VEVENT', `UID:${fmtZ(b.startsAt)}-${b.guestEmail}@chaggu.com`, `DTSTAMP:${fmtZ(new Date().toISOString())}`,
    `DTSTART:${fmtZ(b.startsAt)}`, `DTEND:${fmtZ(b.endsAt)}`, `SUMMARY:${b.page.title} · ${who}`, ...(b.joinUrl ? [`LOCATION:${b.joinUrl}`, `DESCRIPTION:${b.joinUrl}`] : []), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return { google, ics: `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}` };
}

function Summary({ b, tz }: { b: BookingDTO; tz: string }) {
  return (
    <div className="bk-summary">
      <div className="bk-summary-date"><b>{longDate(b.startsAt, tz)}</b><span>{rangeText(b, tz)}</span></div>
      <div className="muted small">{t('bk.with', { hosts: b.hosts.map((h) => h.name).join(', ') })} · {t('bk.minutes', { n: Math.round((Date.parse(b.endsAt) - Date.parse(b.startsAt)) / 60000) })}</div>
    </div>
  );
}

function Done({ b, tz, title, onAnother }: { b: BookingDTO; tz: string; title: string; onAnother?: () => void }) {
  const cal = calendarLinks(b);
  const manage = b.manageToken ? `${location.origin}${/^(calendar|cita|book)\./.test(location.hostname) ? '' : '/cita'}/r/${b.manageToken}` : null;
  return (
    <div className="bk-done">
      <div className="bk-check" aria-hidden>✓</div>
      <h2 className="bk-h2 big">{title}</h2>
      <p className="muted">{t('bk.doneSub', { email: b.guestEmail })}</p>
      <Summary b={b} tz={tz} />
      <div className="bk-actions">
        {b.joinUrl && <a className="bk-btn primary" href={b.joinUrl} target="_blank" rel="noreferrer">{t('bk.join')}</a>}
        <a className="bk-btn" href={cal.google} target="_blank" rel="noreferrer">{t('bk.addCal')}</a>
        <a className="bk-btn" href={cal.ics} download="cita-chaggu.ics">{t('bk.ics')}</a>
      </div>
      <div className="bk-links">
        {manage && <a href={manage}>{t('bk.manage')}</a>}
        {onAnother && <button className="bk-link" onClick={onAnother}>{t('bk.another')}</button>}
      </div>
    </div>
  );
}

// ---------- La página pública ----------
function BookPage({ slug }: { slug: string }) {
  const [page, setPage] = useState<BookingPagePublicDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tz, setTz] = useState(deviceTz);
  const [slot, setSlot] = useState<string | null>(null);
  const [done, setDone] = useState<BookingDTO | null>(null);
  const [name, setName] = useState(() => store.get(NAME_KEY));
  const [email, setEmail] = useState(() => store.get(EMAIL_KEY));
  const [note, setNote] = useState('');
  const [trap, setTrap] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    api<BookingPagePublicDTO>(`/book/${encodeURIComponent(slug)}`).then((p) => { setPage(p); document.title = `${p.title} · chaggu`; })
      .catch((e) => setError(e?.status === 404 ? t('bk.notFound') : errMsg(e)));
  }, [slug]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!slot || busy) return;
    setBusy(true); setFormError(null);
    store.set(NAME_KEY, name.trim()); store.set(EMAIL_KEY, email.trim());
    try {
      setDone(await api<BookingDTO>(`/book/${encodeURIComponent(slug)}`, { method: 'POST', body: { startsAt: slot, name, email, note: note || undefined, timezone: tz, lang: getLang(), website: trap || undefined } }));
    } catch (err: any) {
      setFormError(errMsg(err));
      if (err?.code === 'slot_taken') setSlot(null);
    } finally { setBusy(false); }
  }

  if (error) return <Shell><p role="alert" className="bk-error">{error}</p></Shell>;
  if (!page) return <Shell><p className="muted">…</p></Shell>;
  if (done) return <Shell><Done b={done} tz={tz} title={t('bk.doneTitle')} onAnother={() => { setDone(null); setSlot(null); setNote(''); }} /></Shell>;
  return (
    <Shell wide>
      <Info page={page} />
      <main className="bk-main">
        {!page.ready ? <p className="bk-error">{t('bk.notReady')}</p>
          : !slot ? <SlotPicker slug={slug} tz={tz} onTz={setTz} onPick={setSlot} />
          : (
            <form className="bk-form" onSubmit={submit}>
              <h2 className="bk-h2">{t('bk.details')}</h2>
              <div className="bk-summary"><div className="bk-summary-date"><b>{longDate(slot, tz)}</b><span>{timeText(slot, tz)} · {tz.replace(/_/g, ' ')}</span></div>
                <button type="button" className="bk-link" onClick={() => setSlot(null)}>{t('bk.back')}</button></div>
              <label className="bk-field"><span>{t('bk.name')}</span><input required autoFocus maxLength={120} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></label>
              <label className="bk-field"><span>{t('bk.email')}</span><input required type="email" maxLength={254} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
              <label className="bk-field"><span>{t('bk.note')}</span><textarea rows={3} maxLength={2000} placeholder={t('bk.notePh')} value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <input className="bk-trap" tabIndex={-1} autoComplete="off" aria-hidden value={trap} onChange={(e) => setTrap(e.target.value)} name="website" />
              {formError && <div className="error" role="alert">{formError}</div>}
              <button className="bk-btn primary big" disabled={busy || !name.trim() || !email.trim()}>{busy ? t('bk.confirming') : t('bk.confirm')}</button>
            </form>
          )}
      </main>
    </Shell>
  );
}

// ---------- Cambiar o cancelar ----------
function ManagePage({ token }: { token: string }) {
  const [b, setB] = useState<BookingDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'cancel' | 'move'>('view');
  const [moved, setMoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const tzState = useState(deviceTz);
  const tz = tzState[0];
  const load = () => api<BookingDTO>(`/booking/${encodeURIComponent(token)}`).then(setB).catch((e) => setError(e?.status === 404 ? t('bk.notFound') : errMsg(e)));
  useEffect(() => { void load(); }, [token]);

  async function act(path: string, body: unknown) {
    setBusy(true); setError(null);
    try { setB(await api<BookingDTO>(`/booking/${encodeURIComponent(token)}/${path}?lang=${getLang()}`, { method: 'POST', body })); return true; }
    catch (e) { setError(errMsg(e)); return false; }
    finally { setBusy(false); }
  }

  if (!b) return <Shell>{error ? <p role="alert" className="bk-error">{error}</p> : <p className="muted">…</p>}</Shell>;
  const past = Date.parse(b.startsAt) < Date.now();
  if (b.status === 'cancelled') {
    return <Shell><div className="bk-done"><div className="bk-check off" aria-hidden>×</div><h2 className="bk-h2 big">{t('bk.cancelledTitle')}</h2><p className="muted">{t('bk.cancelledSub')}</p>
      <div className="bk-actions"><a className="bk-btn primary" href={b.page.slug ? `${/^(calendar|cita|book)\./.test(location.hostname) ? '' : '/cita'}/${b.page.slug}` : '/'}>{t('bk.bookAgain')}</a></div></div></Shell>;
  }
  if (moved) return <Shell><Done b={b} tz={tz} title={t('bk.movedTitle')} /></Shell>;
  if (mode === 'move') {
    return (
      <Shell wide>
        <Info page={b.page} />
        <main className="bk-main">
          {error && <div className="error" role="alert">{error}</div>}
          <SlotPicker slug={b.page.slug} tz={tz} onTz={tzState[1]} onPick={(s) => void act('reschedule', { startsAt: s }).then((ok) => { if (ok) setMoved(true); })} />
          <button className="bk-link" style={{ marginTop: 12 }} onClick={() => setMode('view')}>{t('bk.keep')}</button>
        </main>
      </Shell>
    );
  }
  return (
    <Shell>
      <div className="bk-done left">
        <h2 className="bk-h2 big">{t('bk.manageTitle')}</h2>
        <p className="bk-org">{b.page.title}</p>
        <Summary b={b} tz={tz} />
        {past ? <p className="muted">{t('bk.past')}</p> : (
          <>
            {b.joinUrl && <div className="bk-actions"><a className="bk-btn primary" href={b.joinUrl} target="_blank" rel="noreferrer">{t('bk.join')}</a></div>}
            {error && <div className="error" role="alert">{error}</div>}
            {mode === 'cancel' ? (
              <div className="bk-confirm">
                <b>{t('bk.cancelAsk')}</b>
                <div className="bk-actions"><button className="bk-btn danger" disabled={busy} onClick={() => void act('cancel', {})}>{t('bk.yesCancel')}</button><button className="bk-btn" onClick={() => setMode('view')}>{t('bk.keep')}</button></div>
              </div>
            ) : (
              <div className="bk-actions"><button className="bk-btn" onClick={() => setMode('move')}>{t('bk.reschedule')}</button><button className="bk-btn ghost" onClick={() => setMode('cancel')}>{t('bk.cancelBtn')}</button></div>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}

function Home() {
  return (
    <Shell>
      <div className="bk-done"><h2 className="bk-h2 big">{t('bk.homeTitle')}</h2><p className="muted">{t('bk.homeSub')}</p>
        <div className="bk-actions"><a className="bk-btn primary" href="https://www.chaggu.com">{t('bk.homeCta')}</a></div></div>
    </Shell>
  );
}

export default function BookingScreen({ route }: { route: Route }) {
  if (route.name === 'booking') return <BookPage slug={route.slug} />;
  if (route.name === 'bookingManage') return <ManagePage token={route.token} />;
  return <Home />;
}
