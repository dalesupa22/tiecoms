/**
 * «Mis enlaces» en la Agenda (docs/CITAS.md, docs/LLAMADAS.md › Salas): mis reuniones abiertas (enlaces de videollamada
 * que dejo abiertos) y mis páginas de citas tipo Calendly, con sus próximas citas. Solo web.
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { BookingHostBookingDTO, BookingHours, BookingPageDTO, RoomDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { openDialog } from '../actions.tsx';
import { startRoom } from '../call.ts';
import { errorText, locale, t } from '../i18n.ts';
import { copyText, toast } from '../menu.tsx';
import { navigate } from '../router.ts';
import { Modal } from '../ui.tsx';

const OPEN_KEY = 'chaggu.agenda.links';
const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } };

// ---------- Salas ----------
/** «Crear enlace de reunión»: una sala nueva y su enlace para compartir. */
export function newRoomDialog(opts: { startNow?: boolean } = {}) {
  openDialog((close) => <NewRoomDialog onClose={close} startNow={!!opts.startNow} />);
}
/** «Iniciar una reunión ahora»: crea la sala, copia el enlace y entra. */
export async function startMeetingNow() {
  try {
    const r = await client.createRoom('');
    await copyText(r.url);
    toast(t('links.copied'));
    await startRoom(r.id);
  } catch (e) { toast(errorText(e)); }
}

function NewRoomDialog({ onClose, startNow }: { onClose: () => void; startNow: boolean }) {
  const [title, setTitle] = useState('');
  const [room, setRoom] = useState<RoomDTO | null>(null);
  const [busy, setBusy] = useState(false);
  async function create(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    try { setRoom(await client.createRoom(title)); window.dispatchEvent(new Event('chaggu:links')); }
    catch (err) { toast(errorText(err)); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (startNow) void create(); }, []);
  return (
    <Modal title={room ? t('links.roomCreated') : t('links.newRoom').replace('＋ ', '')} onClose={onClose}>
      {!room ? (
        <form className="grid" style={{ gap: 12 }} onSubmit={create}>
          <p className="muted small" style={{ margin: 0 }}>{t('links.roomsHint')}</p>
          <label className="field"><span>{t('links.roomTitlePh')}</span><input className="input" autoFocus maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <button className="btn primary" disabled={busy}>{t('links.create')}</button>
        </form>
      ) : (
        <div className="grid" style={{ gap: 12 }}>
          <p className="muted small" style={{ margin: 0 }}>{t('links.roomCreatedHint')}</p>
          <input className="input" readOnly value={room.url} onFocus={(e) => e.currentTarget.select()} />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn grow" onClick={() => void copyText(room.url).then(() => toast(t('links.copied')))}>{t('links.copy')}</button>
            <button className="btn primary grow" onClick={() => { onClose(); void startRoom(room.id).catch((e) => toast(errorText(e))); }}>🎥 {t('links.startNow')}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------- Páginas de citas ----------
const DAYS = [1, 2, 3, 4, 5, 6, 0];
const dayName = (d: number) => new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + d)));
const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function PageForm({ page, onClose, onSaved }: { page?: BookingPageDTO; onClose: () => void; onSaved: () => void }) {
  const d = useClient((s) => s.data)!;
  const me = d.me.id;
  const team = d.people.filter((p) => p.kind === 'human' && !p.guest && (p.id === me || (d.me.primaryOrgId && p.orgId === d.me.primaryOrgId)));
  const first = page ? (Object.values(page.hours).find((r) => r.length)?.[0] ?? ['09:00', '17:00']) : ['09:00', '17:00'];
  const last = page ? (Object.values(page.hours).find((r) => r.length)?.at(-1) ?? first) : first;
  const [title, setTitle] = useState(page?.title ?? '');
  const [slug, setSlug] = useState(page?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(!!page);
  const [desc, setDesc] = useState(page?.description ?? '');
  const [duration, setDuration] = useState(page?.durationMin ?? 30);
  const [mode, setMode] = useState<'collective' | 'round_robin'>(page?.mode ?? 'round_robin');
  const [hosts, setHosts] = useState<string[]>(page?.hostsStatus.map((h) => h.id) ?? [me]);
  const [days, setDays] = useState<number[]>(page ? DAYS.filter((x) => (page.hours[String(x)] ?? []).length) : [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(first[0]!);
  const [end, setEnd] = useState(last[1]!);
  const [tz, setTz] = useState(page?.timezone ?? 'America/Bogota');
  const [notice, setNotice] = useState(page ? page.minNoticeMin : 240);
  const [ahead, setAhead] = useState(page?.horizonDays ?? 30);
  const [active, setActive] = useState(page?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const hours: BookingHours = Object.fromEntries(days.map((x) => [String(x), [[start, end] as [string, string]]]));
    const body = { slug, title, description: desc, mode, durationMin: duration, timezone: tz, hours, hostIds: hosts, minNoticeMin: notice, horizonDays: ahead, active };
    try {
      if (page) await client.updateBookingPage(page.id, body); else await client.createBookingPage(body);
      onSaved(); onClose();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={page ? t('links.f.edit') : t('links.newPage').replace('＋ ', '')} onClose={onClose}>
      <form className="grid" style={{ gap: 12 }} onSubmit={save}>
        <label className="field"><span>{t('links.f.title')}</span>
          <input className="input" autoFocus required minLength={2} maxLength={120} value={title} onChange={(e) => { setTitle(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} /></label>
        <label className="field"><span>{t('links.f.slug')}</span>
          <input className="input" required pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" value={slug} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }} />
          <span className="small muted">…/{slug || '…'}</span></label>
        <label className="field"><span>{t('links.f.desc')}</span><textarea className="input" rows={2} maxLength={1000} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="field grow"><span>{t('links.f.duration')}</span>
            <select className="input" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>{[15, 20, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{t('links.f.min', { n: m })}</option>)}</select></label>
          <label className="field grow"><span>{t('links.f.mode')}</span>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as 'collective' | 'round_robin')}><option value="round_robin">{t('links.roundRobin')}</option><option value="collective">{t('links.collective')}</option></select></label>
        </div>
        <div className="field"><span>{t('links.f.hosts')}</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {team.map((p) => <label key={p.id} className="links-badge" style={{ cursor: 'pointer', background: hosts.includes(p.id) ? '#e3f1e7' : undefined }}>
              <input type="checkbox" checked={hosts.includes(p.id)} onChange={() => setHosts(toggle(hosts, p.id))} /> {p.name}</label>)}
          </div></div>
        <div className="field"><span>{t('links.f.days')}</span>
          <div className="links-hours">{DAYS.map((x) => <label key={x}><input type="checkbox" checked={days.includes(x)} onChange={() => setDays(toggle(days, x))} />{dayName(x)}</label>)}</div>
          <div className="row" style={{ gap: 8 }}><input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} /><span>–</span><input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></div></div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="field grow"><span>{t('links.f.tz')}</span><input className="input" value={tz} onChange={(e) => setTz(e.target.value)} /></label>
          <label className="field grow"><span>{t('links.f.notice')}</span>
            <select className="input" value={notice} onChange={(e) => setNotice(Number(e.target.value))}>{[0, 60, 240, 720, 1440, 2880].map((m) => <option key={m} value={m}>{t('links.f.hoursH', { n: m / 60 })}</option>)}</select></label>
          <label className="field grow"><span>{t('links.f.daysAhead')}</span>
            <select className="input" value={ahead} onChange={(e) => setAhead(Number(e.target.value))}>{[7, 14, 30, 60, 90].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        </div>
        {page && <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{t('links.f.active')}</label>}
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy || !hosts.length || !days.length}>{t('links.f.save')}</button>
      </form>
    </Modal>
  );
}

// ---------- El panel ----------
const when = (b: BookingHostBookingDTO) => new Date(b.startsAt).toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function MyLinks() {
  const me = useClient((s) => s.data?.me.id);
  const enabled = useClient((s) => !!s.data?.features?.calls);
  const [open, setOpenState] = useState(readOpen);
  const [rooms, setRooms] = useState<RoomDTO[] | null>(null);
  const [pages, setPages] = useState<BookingPageDTO[] | null>(null);
  const [bookings, setBookings] = useState<BookingHostBookingDTO[]>([]);
  const setOpen = (v: boolean) => { setOpenState(v); try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* sin almacenamiento */ } };

  const load = () => {
    void client.myRooms().then(setRooms).catch(() => setRooms([]));
    void client.bookingPages().then(setPages).catch(() => setPages([]));
    void client.bookings().then(setBookings).catch(() => setBookings([]));
  };
  useEffect(() => { load(); window.addEventListener('chaggu:links', load); return () => window.removeEventListener('chaggu:links', load); }, []);
  // Mientras está abierto, se refresca cada 30 s (quién entró a la sala, citas nuevas).
  useEffect(() => { if (!open) return; const id = setInterval(load, 30_000); return () => clearInterval(id); }, [open]);

  const total = (rooms?.length ?? 0) + (pages?.length ?? 0);
  const upcoming = bookings.filter((b) => b.status === 'confirmed' && Date.parse(b.endsAt) > Date.now());
  const copy = (url: string) => void copyText(url).then(() => toast(t('links.copied')));

  return (
    <section className="links-panel" aria-label={t('links.title')}>
      <button className="links-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden>🔗</span><span className="grow">{t('links.title')}</span>
        {upcoming.length > 0 && <span className="links-badge ok">{t('links.upcoming', { n: upcoming.length })}</span>}
        <span className="count">{total}</span><span aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="links-body">
          <div className="links-col">
            <div className="row"><b className="grow">{t('links.rooms')}</b>{enabled && <button className="btn small" onClick={() => newRoomDialog()}>{t('links.newRoom')}</button>}</div>
            <p className="small muted" style={{ margin: 0 }}>{t('links.roomsHint')}</p>
            {(rooms ?? []).length === 0 && <p className="small muted" style={{ margin: 0 }}>{t('links.empty')}</p>}
            {(rooms ?? []).map((r) => (
              <div key={r.id} className="links-item">
                <div className="row"><b className="grow ellipsis">{r.title || `🎥 ${r.code}`}</b>{r.live && <span className="links-badge ok">{t('links.live', { n: r.guests })}</span>}</div>
                <span className="url">{r.url}</span>
                <div className="links-actions">
                  <button className="btn small" onClick={() => copy(r.url)}>{t('links.copy')}</button>
                  <button className="btn small primary" onClick={() => void startRoom(r.id).catch((e) => toast(errorText(e)))}>🎥 {t('links.enter')}</button>
                  <button className="btn small ghost" onClick={() => { if (confirm(t('links.deleteAsk'))) void client.deleteRoom(r.id).then(load).catch((e) => toast(errorText(e))); }}>{t('links.delete')}</button>
                </div>
              </div>
            ))}
          </div>
          <div className="links-col">
            <div className="row"><b className="grow">{t('links.pages')}</b><button className="btn small" onClick={() => openDialog((close) => <PageForm onClose={close} onSaved={load} />)}>{t('links.newPage')}</button></div>
            <p className="small muted" style={{ margin: 0 }}>{t('links.pagesHint')}</p>
            {(pages ?? []).length === 0 && <p className="small muted" style={{ margin: 0 }}>{t('links.noPages')}</p>}
            {(pages ?? []).map((p) => {
              const mine = p.hostsStatus.find((h) => h.id === me);
              return (
                <div key={p.id} className="links-item">
                  <div className="row"><b className="grow ellipsis">{p.title}</b>{!p.active && <span className="links-badge warn">off</span>}{p.upcoming > 0 && <span className="links-badge ok">{t('links.upcoming', { n: p.upcoming })}</span>}</div>
                  <span className="url">{p.url}</span>
                  <div className="small muted">{p.mode === 'collective' ? t('links.collective') : t('links.roundRobin')} · {t('bk.minutes', { n: p.durationMin })}</div>
                  <div className="badges">
                    {p.hostsStatus.map((h) => <span key={h.id} className={`links-badge ${h.calendar === 'google' || h.calendar === 'microsoft' ? 'ok' : 'warn'}`} title={h.calendar === 'none' ? t('links.calNone') : h.calendar === 'reconnect' ? t('links.calReconnect') : t('links.calOk')}>
                      {h.name.split(' ')[0]} {h.calendar === 'google' || h.calendar === 'microsoft' ? '✓' : '!'}</span>)}
                  </div>
                  <div className="links-actions">
                    <button className="btn small" onClick={() => copy(p.url)}>{t('links.copy')}</button>
                    <a className="btn small" href={p.url} target="_blank" rel="noreferrer">↗</a>
                    {p.ownerId === me && <button className="btn small ghost" onClick={() => openDialog((close) => <PageForm page={p} onClose={close} onSaved={load} />)}>{t('links.f.edit')}</button>}
                    {mine && mine.calendar !== 'google' && mine.calendar !== 'microsoft' && <button className="btn small accent" onClick={() => navigate('/ajustes#reuniones')}>{t('links.connectCal')}</button>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="links-col" style={{ gridColumn: '1 / -1' }}>
            <b>{t('links.bookings')}</b>
            {bookings.length === 0 && <p className="small muted" style={{ margin: 0 }}>{t('links.noBookings')}</p>}
            {bookings.map((b) => (
              <div key={b.id} className="links-item" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, opacity: b.status === 'cancelled' ? 0.55 : 1 }}>
                <span className="grow" style={{ minWidth: 0 }}><b>{when(b)}</b> · {b.guestName} <span className="muted small">({b.guestEmail})</span><span className="small muted" style={{ display: 'block' }}>{b.pageTitle}{b.note ? ` — ${b.note}` : ''}</span></span>
                {b.status === 'cancelled' ? <span className="links-badge">{t('links.cancelled')}</span> : (
                  <>
                    {b.joinUrl && <a className="btn small primary" href={b.joinUrl} target="_blank" rel="noreferrer">🎥</a>}
                    <button className="btn small ghost" onClick={() => { if (confirm(t('links.cancelBookingAsk', { name: b.guestName }))) void client.cancelBooking(b.id).then(load).catch((e) => toast(errorText(e))); }}>{t('links.cancelBooking')}</button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
