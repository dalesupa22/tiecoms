import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BootstrapDTO, CalendarEventDTO, ConversationDTO, Rsvp } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { openDialog } from '../actions.tsx';
import { errorText, locale, t } from '../i18n.ts';
import { contextHandler, copyText, toast, type MenuItem } from '../menu.tsx';
import { BASE, navigate } from '../router.ts';
import { Avatar, Modal, conversationTitle, orgById, personById } from '../ui.tsx';
import { QuickActions } from './Quick.tsx';
import { isMeetingUrl } from './Meetings.tsx';
import { addDays, startOfDay, storedView, viewRange, VIEW_KEY, type CalView } from '../calendar-grid.ts';
import { groupColor, isAllDayEvent } from '@tiecoms/client-core';

// ---------- Zonas horarias sin librerías ----------
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Bogota';
const COMMON_TZ = ['America/Bogota', 'America/Mexico_City', 'America/Lima', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/Sao_Paulo', 'America/New_York', 'America/Los_Angeles', 'Europe/Madrid', 'UTC'];
const tzList = [...new Set([BROWSER_TZ, ...COMMON_TZ])];

function tzOffsetMs(tz: string, at: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - at.getTime();
}
/** «2026-09-30» + «10:00» en la zona tz → instante UTC. */
function zonedToUtc(date: string, time: string, tz: string) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let utc = guess - tzOffsetMs(tz, new Date(guess));
  utc = guess - tzOffsetMs(tz, new Date(utc));
  return new Date(utc);
}
function partsIn(tz: string, at: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const fmtTime = (iso: string, tz?: string) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
const fmtDay = (d: Date) => d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtWhen = (ev: CalendarEventDTO) => {
  const day = new Date(ev.startsAt).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${fmtTime(ev.startsAt)}–${fmtTime(ev.endsAt)}`;
};

// ---------- Otras apps de calendario ----------
const gstamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function details(ev: CalendarEventDTO) { return [ev.description, `${location.origin}${BASE}/c/${ev.conversationId}`].filter(Boolean).join('\n\n'); }
export const googleLink = (ev: CalendarEventDTO) => `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(ev.title)}&dates=${gstamp(ev.startsAt)}/${gstamp(ev.endsAt)}&details=${encodeURIComponent(details(ev))}&location=${encodeURIComponent(ev.location ?? '')}&ctz=${encodeURIComponent(ev.timezone)}`;
export const outlookLink = (ev: CalendarEventDTO) => `https://outlook.office.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=${encodeURIComponent(ev.title)}&startdt=${encodeURIComponent(ev.startsAt)}&enddt=${encodeURIComponent(ev.endsAt)}&body=${encodeURIComponent(details(ev))}&location=${encodeURIComponent(ev.location ?? '')}`;
export function downloadIcs(ev: CalendarEventDTO) {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//chaggu//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${ev.id}@chaggu.com`, `DTSTAMP:${gstamp(new Date().toISOString())}`, `DTSTART:${gstamp(ev.startsAt)}`, `DTEND:${gstamp(ev.endsAt)}`,
    `SUMMARY:${esc(ev.title)}`, `DESCRIPTION:${esc(details(ev))}`, ...(ev.location ? [`LOCATION:${esc(ev.location)}`] : []),
    `URL:${location.origin}${BASE}/c/${ev.conversationId}`, ev.cancelledAt ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `${ev.title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40)}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const isUrl = (s: string | null) => !!s && /^https?:\/\//i.test(s.trim());

/** Un color por grupo (el mismo en web, iOS y Android: docs/AGENDA-COLORES.md). */
function eventColors(_d: BootstrapDTO, ev: CalendarEventDTO) {
  return groupColor(ev.conversationId);
}
const allDay = (e: CalendarEventDTO) => isAllDayEvent(e.startsAt, e.endsAt);
/** Hora del evento o «Todo el día». */
const evTime = (e: CalendarEventDTO) => (allDay(e) ? t('cal.allDay') : fmtTime(e.startsAt));

// Grupos ocultos en la Agenda (preferencia de este navegador).
const HIDDEN_KEY = 'chaggu.agenda.hidden';
function readHidden(): string[] { try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]'); } catch { return []; } }

/** Leyenda: los grupos con eventos en lo que se ve, con su color; tocar uno lo oculta o lo muestra. */
function GroupLegend({ d, ids, hidden, onToggle, onShowAll }: { d: BootstrapDTO; ids: string[]; hidden: Set<string>; onToggle: (id: string) => void; onShowAll: () => void }) {
  if (!ids.length) return null;
  return (
    <div className="cal-legend" role="group" aria-label={t('cal.groups')}>
      {ids.map((id) => {
        const conv = d.conversations.find((c) => c.id === id);
        if (!conv) return null;
        const c = groupColor(id), off = hidden.has(id);
        return (
          <button key={id} className={`cal-legend-chip ${off ? 'is-off' : ''}`} aria-pressed={!off} onClick={() => onToggle(id)} title={off ? t('cal.showGroup') : t('cal.hideGroup')}>
            <i style={{ background: off ? 'transparent' : c.fg, borderColor: c.fg }} /><span className="ellipsis">{conversationTitle(d, conv)}</span>
          </button>
        );
      })}
      {hidden.size > 0 && <button className="btn ghost small" onClick={onShowAll}>{t('cal.showAll')}</button>}
    </div>
  );
}

// ---------- Crear / editar ----------
export function EventDialog({ conversationId, originMessageId, defaultTitle = '', event, defaultStart, onClose }: {
  conversationId?: string; originMessageId?: string; defaultTitle?: string; event?: CalendarEventDTO; defaultStart?: Date; onClose: () => void;
}) {
  const d = client.getState().data!;
  // También directos y chats grupales (SPEC v4 E).
  const groups = d.conversations.filter((c) => c.canPost);
  const tz0 = event?.timezone ?? BROWSER_TZ;
  const start0 = event ? new Date(event.startsAt) : defaultStart ? new Date(defaultStart) : (() => { const x = new Date(Date.now() + 86400_000); x.setMinutes(0, 0, 0); x.setHours(10); return x; })();
  const end0 = event ? new Date(event.endsAt) : new Date(start0.getTime() + 3600_000);
  const [conv, setConv] = useState(event?.conversationId ?? conversationId ?? groups[0]?.id ?? '');
  const [title, setTitle] = useState(event?.title ?? defaultTitle);
  const [tz, setTz] = useState(tz0);
  const [date, setDate] = useState(partsIn(tz0, start0).date);
  const [start, setStart] = useState(partsIn(tz0, start0).time);
  const [end, setEnd] = useState(partsIn(tz0, end0).time);
  const [loc, setLoc] = useState(event?.location ?? '');
  const [desc, setDesc] = useState(event?.description ?? '');
  const c = d.conversations.find((x) => x.id === conv);
  const humans = (c?.memberIds ?? []).map((id) => personById(d, id)).filter((p): p is NonNullable<typeof p> => !!p && p.kind === 'human');
  const [invitees, setInvitees] = useState<string[] | null>(event ? event.invitees.map((i) => i.userId) : null);
  const chosen = invitees ?? humans.map((p) => p.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setInvitees(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const s = zonedToUtc(date, start, tz), en = zonedToUtc(date, end, tz);
      if (en <= s) en.setDate(en.getDate() + 1);
      const payload = { title, description: desc || null, location: loc || null, startsAt: s.toISOString(), endsAt: en.toISOString(), timezone: tz, inviteeIds: chosen };
      const ev = event ? await client.updateEvent(event.id, payload) : await client.createEvent(conv, { ...payload, originMessageId: originMessageId ?? null });
      toast(`${ev.title} · ${fmtWhen(ev)}`);
      onClose();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={event ? t('cal.editTitle') : t('cal.newTitle')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field"><span>{t('cal.title')}</span><input className="input" required minLength={2} maxLength={200} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        {!event && (
          <label className="field"><span>{t('cal.conversation')}</span>
            <select className="input" value={conv} onChange={(e) => { setConv(e.target.value); setInvitees(null); }}>
              {groups.map((g) => <option key={g.id} value={g.id}>{conversationTitle(d, g)} · {d.workspaces.find((w) => w.id === g.workspaceId)?.name ?? t('issue.chatsSection')}</option>)}
            </select>
          </label>
        )}
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="field grow"><span>{t('cal.date')}</span><input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="field"><span>{t('cal.start')}</span><input className="input" type="time" required value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label className="field"><span>{t('cal.end')}</span><input className="input" type="time" required value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        </div>
        <label className="field"><span>{t('cal.tz')}</span>
          <select className="input" value={tz} onChange={(e) => setTz(e.target.value)}>{tzList.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}</select>
        </label>
        <label className="field"><span>{t('cal.location')}</span><input className="input" placeholder={t('cal.locationPh')} value={loc} onChange={(e) => setLoc(e.target.value)} /></label>
        <div className="eyebrow">{t('cal.invitees')} · {chosen.length}</div>
        <div className="invitee-grid">
          {humans.map((p) => (
            <label key={p.id} className="check"><input type="checkbox" checked={chosen.includes(p.id)} disabled={p.id === d.me.id} onChange={() => toggle(p.id)} />
              <Avatar person={p} org={orgById(d, p.orgId)} size={24} /><span className="grow ellipsis">{p.name}</span></label>
          ))}
        </div>
        <label className="field"><span>{t('cal.description')}</span><textarea className="input" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || !conv}>{event ? t('cal.save') : t('cal.create')}</button></div>
      </form>
    </Modal>
  );
}

// ---------- Detalle ----------
const RSVP_ICON: Record<Rsvp, string> = { yes: '✓', no: '✕', maybe: '?', pending: '·' };

export function EventDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const ev = useClient((s) => s.events[id]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!ev) client.request<CalendarEventDTO>(`/events/${id}`).then((e) => client.loadEvents(new Date(Date.parse(e.startsAt) - 1), new Date(Date.parse(e.endsAt) + 1))).catch((e) => setError(errorText(e))); }, [id]);
  if (!ev) return <Modal title={t('nav.agenda')} onClose={onClose}><div className="muted">{error ?? t('common.loading')}</div></Modal>;
  const conv = d.conversations.find((c) => c.id === ev.conversationId);
  const mine = ev.invitees.find((i) => i.userId === d.me.id);
  const canEdit = ev.organizerId === d.me.id || !!conv?.canManage;
  const organizer = personById(d, ev.organizerId);
  const otherTz = ev.timezone !== BROWSER_TZ;
  const answer = (r: Exclude<Rsvp, 'pending'>) => client.rsvp(ev.id, r).catch((e) => setError(errorText(e)));
  return (
    <Modal title={ev.title} onClose={onClose}>
      {ev.cancelledAt && <div className="jam-alert">{t('cal.cancelled')}</div>}
      <div>
        <b>{fmtWhen(ev)}</b>
        {otherTz && <div className="small muted">{t('cal.eventTz')}: {fmtTime(ev.startsAt, ev.timezone)}–{fmtTime(ev.endsAt, ev.timezone)} ({ev.timezone.replace(/_/g, ' ')})</div>}
        <div className="small muted">{conv ? conversationTitle(d, conv) : ''} · {t('cal.organizer', { name: organizer?.name ?? '' })}</div>
      </div>
      {ev.location && (isUrl(ev.location)
        ? <a className="btn primary" href={ev.location} target="_blank" rel="noopener noreferrer" style={{ alignSelf: 'flex-start' }}>▶ {t('cal.join')}</a>
        : <div>📍 {ev.location}</div>)}
      {ev.description && <div className="issue-comment">{ev.description}</div>}
      {mine && !ev.cancelledAt && (
        <div className="seg" role="radiogroup">
          {(['yes', 'maybe', 'no'] as const).map((r) => <button key={r} className={mine.rsvp === r ? 'on' : ''} onClick={() => answer(r)}>{t(`cal.rsvp.${r}`)}</button>)}
        </div>
      )}
      <div className="eyebrow">{t('cal.invitees')} · {ev.invitees.length}</div>
      <div className="invitee-grid">
        {ev.invitees.map((i) => { const p = personById(d, i.userId); return (
          <div key={i.userId} className="member"><Avatar person={p} org={orgById(d, p?.orgId)} size={26} /><span className="grow ellipsis small">{p?.name ?? t('common.participant')}</span><span className={`rsvp rsvp-${i.rsvp}`} title={t(`cal.rsvp.${i.rsvp}`)}>{RSVP_ICON[i.rsvp]}</span></div>
        ); })}
      </div>
      <div className="eyebrow">{t('cal.addTo')}</div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <a className="btn small" href={googleLink(ev)} target="_blank" rel="noopener noreferrer">{t('cal.addGoogle')}</a>
        <a className="btn small" href={outlookLink(ev)} target="_blank" rel="noopener noreferrer">{t('cal.addOutlook')}</a>
        <button className="btn small" onClick={() => downloadIcs(ev)}>{t('cal.ics')}</button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        {conv && <button className="btn ghost" onClick={() => { onClose(); navigate(`/c/${conv.id}`); }}>{t('cal.openChat')}</button>}
        {canEdit && !ev.cancelledAt && <button className="btn ghost" onClick={() => { onClose(); openDialog((close) => <EventDialog event={ev} onClose={close} />); }}>{t('cal.edit')}</button>}
        {canEdit && !ev.cancelledAt && <button className="btn" onClick={() => { if (confirm(t('cal.cancelConfirm'))) void client.cancelEvent(ev.id).catch((e) => setError(errorText(e))); }}>{t('cal.cancel')}</button>}
      </div>
    </Modal>
  );
}

export const openEvent = (id: string) => openDialog((close) => <EventDrawer id={id} onClose={close} />);
export const newEvent = (opts: { conversationId?: string; originMessageId?: string; defaultTitle?: string } = {}) => openDialog((close) => <EventDialog {...opts} onClose={close} />);

function eventMenu(ev: CalendarEventDTO): MenuItem[] {
  return [
    { label: t('menu.open'), icon: '↗', onSelect: () => openEvent(ev.id) },
    { label: t('cal.openChat'), icon: '◍', onSelect: () => navigate(`/c/${ev.conversationId}`) },
    ...(isUrl(ev.location) ? [{ label: t('cal.join'), icon: '▶', onSelect: () => window.open(ev.location!, '_blank', 'noopener') }] : []),
    { divider: true },
    { label: t('cal.addGoogle'), icon: 'G', onSelect: () => window.open(googleLink(ev), '_blank', 'noopener') },
    { label: t('cal.addOutlook'), icon: 'O', onSelect: () => window.open(outlookLink(ev), '_blank', 'noopener') },
    { label: t('cal.ics'), icon: '⤓', onSelect: () => downloadIcs(ev) },
    { label: t('menu.copyLink'), icon: '⛓', onSelect: async () => { await copyText(`${location.origin}${BASE}/c/${ev.conversationId}`); toast(t('toast.linkCopied')); } },
  ];
}

// ---------- Agenda: Día · Semana · Mes (Semana por defecto) ----------
const H0 = 7, H1 = 21, PX = 48;
const overlaps = (e: CalendarEventDTO, day: Date) => Date.parse(e.startsAt) < addDays(day, 1).getTime() && Date.parse(e.endsAt) > day.getTime();
const meetIcon = (e: CalendarEventDTO) => (isMeetingUrl(e.location) ? '📹 ' : '');

export function AgendaScreen() {
  const d = useClient((s) => s.data)!;
  const all = useClient((s) => s.events);
  const [view, setViewState] = useState<CalView>(storedView);
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [error, setError] = useState<string | null>(null);
  const setView = (v: CalView) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* sin almacenamiento */ } };
  const { from, to, days } = useMemo(() => viewRange(view, anchor), [view, anchor]);
  useEffect(() => { client.loadEvents(from, to).catch((e) => setError(errorText(e))); }, [from.getTime(), to.getTime()]);
  const [hiddenList, setHiddenList] = useState<string[]>(readHidden);
  const hidden = new Set(hiddenList);
  const saveHidden = (next: string[]) => { setHiddenList(next); try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* sin almacenamiento */ } };
  const visible = new Set(d.conversations.map((c) => c.id));
  const inRange = Object.values(all).filter((e) => visible.has(e.conversationId) && Date.parse(e.startsAt) < to.getTime() && Date.parse(e.endsAt) > from.getTime())
    .sort((a, b) => Number(allDay(b)) - Number(allDay(a)) || a.startsAt.localeCompare(b.startsAt));
  const legendIds = [...new Set(inRange.map((e) => e.conversationId))];
  const events = inRange.filter((e) => !hidden.has(e.conversationId));
  const timed = events.filter((e) => !allDay(e));
  const today = new Date().toDateString();
  const shift = (n: number) => setAnchor(view === 'day' ? addDays(anchor, n) : view === 'week' ? addDays(anchor, 7 * n) : new Date(anchor.getFullYear(), anchor.getMonth() + n, 1));
  const newAt = (at: Date) => openDialog((close) => <EventDialog defaultStart={at} onClose={close} />);
  const heading = view === 'day'
    ? anchor.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : view === 'week' ? t('cal.week', { date: from.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' }) })
    : anchor.toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
  const prevNext = view === 'day' ? ['cal.prevDay', 'cal.nextDay'] : view === 'week' ? ['cal.prev', 'cal.next'] : ['cal.prevMonth', 'cal.nextMonth'];

  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 1180 }}>
      <div className="row page-head"><h1 className="grow">{t('nav.agenda')}</h1><QuickActions /></div>
      <div className="row cal-toolbar">
        <div className="seg" role="radiogroup" aria-label={t('cal.view')}>
          {(['day', 'week', 'month'] as const).map((v) => <button key={v} role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{t(`cal.v.${v}`)}</button>)}
        </div>
        <span className="muted grow cal-heading">{heading}</span>
        <button className="btn small" onClick={() => setAnchor(startOfDay(new Date()))}>{t('cal.today')}</button>
        <button className="icon-btn" aria-label={t(prevNext[0] as 'cal.prev')} onClick={() => shift(-1)}>‹</button>
        <button className="icon-btn" aria-label={t(prevNext[1] as 'cal.next')} onClick={() => shift(1)}>›</button>
      </div>
      {error && <div className="error">{error}</div>}
      <GroupLegend d={d} ids={legendIds} hidden={hidden}
        onToggle={(id) => saveHidden(hidden.has(id) ? hiddenList.filter((x) => x !== id) : [...hiddenList, id])} onShowAll={() => saveHidden([])} />

      {view === 'month' ? (
        <div className="month" role="grid" aria-label={heading}>
          <div className="month-head">{days.slice(0, 7).map((x) => <span key={x.toISOString()}>{x.toLocaleDateString(locale(), { weekday: 'short' })}</span>)}</div>
          <div className="month-body">
            {days.map((x) => {
              const list = events.filter((e) => overlaps(e, x));
              const out = x.getMonth() !== anchor.getMonth();
              return (
                <div key={x.toISOString()} role="gridcell" className={`month-day ${out ? 'is-out' : ''} ${x.toDateString() === today ? 'is-today' : ''}`}
                  onDoubleClick={() => { const at = new Date(x); at.setHours(10); newAt(at); }}>
                  <button className="month-num" onClick={() => { setAnchor(x); setView('day'); }} aria-label={x.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })}>{x.getDate()}</button>
                  {list.slice(0, 3).map((e) => {
                    const c = eventColors(d, e);
                    return <button key={e.id} className={`month-ev ${e.cancelledAt ? 'is-cancelled' : ''}`} style={{ background: c.bg, color: c.fg }} onClick={() => openEvent(e.id)} onContextMenu={contextHandler(() => eventMenu(e))}>
                      <span className="ellipsis">{meetIcon(e)}{allDay(e) ? '' : `${fmtTime(e.startsAt)} `}{e.title}</span></button>;
                  })}
                  {list.length > 3 && <button className="month-more" onClick={() => { setAnchor(x); setView('day'); }}>{t('cal.more', { n: list.length - 3 })}</button>}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <>
          <div className={`week only-desktop ${view === 'day' ? 'is-day' : ''}`} style={{ ['--cols' as string]: days.length }}>
            <div className="week-head"><span />{days.map((x) => <span key={x.toISOString()} className={x.toDateString() === today ? 'is-today' : ''}>{fmtDay(x)}</span>)}</div>
            {events.some(allDay) && (
              <div className="week-allday"><span className="small muted">{t('cal.allDay')}</span>{days.map((x) => (
                <div key={x.toISOString()}>{events.filter((e) => allDay(e) && overlaps(e, x)).map((e) => {
                  const c = eventColors(d, e);
                  return <button key={e.id} className="month-ev" style={{ background: c.bg, color: c.fg }} onClick={() => openEvent(e.id)} onContextMenu={contextHandler(() => eventMenu(e))}><span className="ellipsis">{e.title}</span></button>;
                })}</div>
              ))}</div>
            )}
            <div className="week-body" style={{ height: (H1 - H0) * PX }}>
              <div className="week-hours">{Array.from({ length: H1 - H0 }, (_, i) => <span key={i} style={{ top: i * PX }}>{String(H0 + i).padStart(2, '0')}:00</span>)}</div>
              {days.map((x) => {
                const dayEvents = timed.filter((e) => new Date(e.startsAt).toDateString() === x.toDateString());
                const cols: CalendarEventDTO[][] = [];
                for (const e of dayEvents) { const c = cols.find((col) => col[col.length - 1]!.endsAt <= e.startsAt); if (c) c.push(e); else cols.push([e]); }
                return (
                  <div key={x.toISOString()} className={`week-day ${x.toDateString() === today ? 'is-today' : ''}`}
                    onDoubleClick={(ev) => { if (ev.target !== ev.currentTarget) return; const r = ev.currentTarget.getBoundingClientRect(); const h = H0 + Math.floor((ev.clientY - r.top) / PX); const at = new Date(x); at.setHours(h, 0, 0, 0); newAt(at); }}>
                    {Array.from({ length: H1 - H0 }, (_, i) => <i key={i} style={{ top: i * PX }} />)}
                    {cols.flatMap((col, ci) => col.map((e) => {
                      const st = new Date(e.startsAt), en = new Date(e.endsAt);
                      const top = Math.max(0, ((st.getHours() + st.getMinutes() / 60) - H0) * PX);
                      const h = Math.max(22, ((en.getTime() - st.getTime()) / 3600_000) * PX - 2);
                      const c = eventColors(d, e);
                      return (
                        <button key={e.id} className={`week-ev ${e.cancelledAt ? 'is-cancelled' : ''}`} onContextMenu={contextHandler(() => eventMenu(e))}
                          style={{ top, height: h, left: `${(ci / cols.length) * 100}%`, width: `${100 / cols.length}%`, background: c.bg, color: c.fg }}
                          onClick={() => openEvent(e.id)}>
                          <b className="ellipsis">{meetIcon(e)}{e.title}</b><span className="ellipsis">{fmtTime(e.startsAt)} · {conversationTitle(d, d.conversations.find((cv) => cv.id === e.conversationId)!)}</span>
                        </button>
                      );
                    }))}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="only-mobile list">
            {events.length === 0 && <div className="empty">{t(view === 'day' ? 'cal.dayEmpty' : 'cal.empty')}</div>}
            {days.map((x) => {
              const list = events.filter((e) => (allDay(e) ? overlaps(e, x) : new Date(e.startsAt).toDateString() === x.toDateString()));
              if (!list.length) return null;
              return (
                <section key={x.toISOString()}>
                  <div className="eyebrow" style={{ margin: '10px 0 6px' }}>{fmtDay(x)}</div>
                  <div className="list">{list.map((e) => <EventRow key={e.id} ev={e} />)}</div>
                </section>
              );
            })}
          </div>
          {events.length === 0 && <div className="empty only-desktop" style={{ marginTop: 12 }}>{t(view === 'day' ? 'cal.dayEmpty' : 'cal.empty')}</div>}
          <div className="row" style={{ marginTop: 10 }}><button className="btn small" onClick={() => { const at = new Date(view === 'day' ? anchor : from); at.setHours(10, 0, 0, 0); newAt(at); }}>{t('cal.new')}</button></div>
        </>
      )}
    </div></div>
  );
}

export function EventRow({ ev, showConv = true }: { ev: CalendarEventDTO; showConv?: boolean }) {
  const d = useClient((s) => s.data)!;
  const c = eventColors(d, ev);
  const conv = d.conversations.find((x) => x.id === ev.conversationId);
  const mine = ev.invitees.find((i) => i.userId === d.me.id);
  return (
    <button className={`card event-row ${ev.cancelledAt ? 'is-cancelled' : ''}`} onClick={() => openEvent(ev.id)} onContextMenu={contextHandler(() => eventMenu(ev))}>
      <span className="event-time" style={{ background: c.bg, color: c.fg }}>{evTime(ev)}</span>
      <span className="grow" style={{ minWidth: 0 }}>
        <b className="ellipsis" style={{ display: 'block' }}>{ev.title}</b>
        <span className="small muted ellipsis" style={{ display: 'block' }}>
          {[showConv && conv ? conversationTitle(d, conv) : null, new Date(ev.startsAt).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' }), ev.cancelledAt ? t('cal.cancelled') : null].filter(Boolean).join(' · ')}
        </span>
      </span>
      {mine && <span className={`rsvp rsvp-${mine.rsvp}`} title={t(`cal.rsvp.${mine.rsvp}`)}>{RSVP_ICON[mine.rsvp]}</span>}
    </button>
  );
}

/** Reuniones próximas de una conversación (panel de detalles). */
export function ConversationAgenda({ conv }: { conv: ConversationDTO }) {
  const all = useClient((s) => s.events);
  useEffect(() => { client.loadEvents(new Date(Date.now() - 3600_000), new Date(Date.now() + 60 * 86400_000), conv.id).catch(() => {}); }, [conv.id]);
  const list = Object.values(all).filter((e) => e.conversationId === conv.id && !e.cancelledAt && Date.parse(e.endsAt) > Date.now()).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 5);
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="eyebrow grow">{t('cal.upcoming')} · {list.length}</span>
        {conv.canPost && <button className="btn small" onClick={() => newEvent({ conversationId: conv.id })}>{t('cal.new')}</button>}
      </div>
      {list.length === 0 && <div className="hint">{t('cal.noUpcoming')}</div>}
      <div className="list" style={{ gap: 6 }}>{list.map((e) => <EventRow key={e.id} ev={e} showConv={false} />)}</div>
    </div>
  );
}

/** Reuniones de hoy (pantalla Hoy). */
export function TodayAgenda() {
  const all = useClient((s) => s.events);
  const d = useClient((s) => s.data)!;
  useEffect(() => { const s = new Date(); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setDate(e.getDate() + 1); client.loadEvents(s, e).catch(() => {}); }, []);
  const visible = new Set(d.conversations.map((c) => c.id));
  const today = new Date().toDateString();
  const list = Object.values(all).filter((e) => visible.has(e.conversationId) && new Date(e.startsAt).toDateString() === today).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return (
    <section>
      <div className="row" style={{ marginBottom: 10 }}><span className="eyebrow grow">{t('cal.todayList')}</span><button className="btn ghost small" onClick={() => navigate('/agenda')}>{t('nav.agenda')} ›</button></div>
      <div className="list" style={{ marginBottom: 20 }}>{list.length ? list.map((e) => <EventRow key={e.id} ev={e} />) : <div className="empty">{t('cal.todayEmpty')}</div>}</div>
    </section>
  );
}

/**
 * Tarjeta del evento dentro del chat (reemplaza el aviso «Agendó…»): fecha y hora, enlace para unirse,
 * quiénes van y los botones para responder ahí mismo.
 */
export function EventChatCard({ eventId, creatorId }: { eventId: string; creatorId: string }) {
  const d = useClient((s) => s.data)!;
  const ev = useClient((s) => s.events[eventId]);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (ev) return;
    client.request<CalendarEventDTO>(`/events/${eventId}`).then((e) => client.loadEvents(new Date(Date.parse(e.startsAt) - 1), new Date(Date.parse(e.endsAt) + 1), e.conversationId)).catch(() => setMissing(true));
  }, [eventId, !!ev]);
  if (!ev) return missing ? null : <div className="card event-card is-loading" aria-busy>…</div>;
  const c = eventColors(d, ev);
  const creator = personById(d, creatorId);
  const mine = ev.invitees.find((i) => i.userId === d.me.id);
  const past = Date.parse(ev.endsAt) < Date.now();
  const start = new Date(ev.startsAt);
  const day = start.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  const time = allDay(ev) ? t('cal.allDay') : `${fmtTime(ev.startsAt)} – ${fmtTime(ev.endsAt)}`;
  const going = ev.invitees.filter((i) => i.rsvp === 'yes').length;
  const answer = (r: Exclude<Rsvp, 'pending'>) => void client.rsvp(ev.id, r).catch((e) => toast(errorText(e)));
  return (
    <div className={`card event-card ${ev.cancelledAt ? 'is-cancelled' : ''} ${past ? 'is-past' : ''}`} style={{ borderLeftColor: c.fg }} onContextMenu={contextHandler(() => eventMenu(ev))}>
      <div className="event-card-kind">📅 {t('cal.card', { name: creator?.name.split(' ')[0] ?? '' })}{ev.cancelledAt ? ` · ${t('cal.cancelled')}` : ''}</div>
      <div className="event-card-main">
        <div className="event-card-date" style={{ background: c.bg, color: c.fg }}>
          <span>{start.toLocaleDateString(locale(), { month: 'short' }).replace('.', '')}</span><b>{start.getDate()}</b>
        </div>
        <div style={{ minWidth: 0 }}>
          <button className="event-card-title" onClick={() => openEvent(ev.id)}>{ev.title}</button>
          <div className="small muted">{day} · {time}</div>
        </div>
      </div>
      {ev.location && (isMeetingUrl(ev.location)
        ? <a className="btn small primary event-card-join" href={ev.location} target="_blank" rel="noreferrer">📹 {t('cal.join')}</a>
        : <div className="small">📍 {ev.location}</div>)}
      <div className="event-card-people">
        <span className="stack" style={{ width: 20 + Math.max(0, Math.min(ev.invitees.length, 5) - 1) * 12, height: 22 }}>
          {ev.invitees.slice(0, 5).map((i, k) => <span key={i.userId} style={{ left: k * 12, zIndex: 5 - k }} title={`${personById(d, i.userId)?.name ?? ''} · ${t(`cal.rsvp.${i.rsvp}`)}`}><Avatar person={personById(d, i.userId)} org={null} size={22} /></span>)}
        </span>
        <span className="small muted">{t('cal.cardGoing', { n: going, total: ev.invitees.length })}</span>
      </div>
      {mine && !ev.cancelledAt && !past && (
        <div className="event-card-rsvp">
          {(['yes', 'maybe', 'no'] as const).map((r) => (
            <button key={r} className={`btn small ${mine.rsvp === r ? 'is-on' : 'ghost'}`} onClick={() => answer(r)}>{RSVP_ICON[r]} {t(`cal.rsvp.${r}`)}</button>
          ))}
        </div>
      )}
    </div>
  );
}
