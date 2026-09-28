import { useState, type FormEvent } from 'react';
import type { ScheduledMessageDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { navigate } from '../router.ts';
import { Modal, conversationTitle } from '../ui.tsx';
import { openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { openDialog } from '../actions.tsx';

/**
 * Mensajes programados: se escriben ahora y salen solos a la hora elegida.
 * Opciones de un toque (en 1 hora, esta tarde, mañana 8:00, el lunes 8:00) y «Elegir fecha y hora».
 */

const at = (days: number, h: number, m = 0) => { const x = new Date(); x.setDate(x.getDate() + days); x.setHours(h, m, 0, 0); return x; };

/** «mañana a las 8:00 a. m.», «hoy a las 6:00 p. m.», «el lun 5 oct a las 8:00 a. m.». */
export function whenLabel(iso: string) {
  const x = new Date(iso);
  const time = x.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  const x0 = new Date(x); x0.setHours(0, 0, 0, 0);
  const diff = Math.round((x0.getTime() - at(0, 0).getTime()) / 86_400_000);
  if (diff === 0) return t('sched.todayAt', { time });
  if (diff === 1) return t('sched.tomorrowAt', { time });
  return t('sched.dayAt', { day: x.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' }), time });
}

export function scheduleOptions(): { label: string; at: Date }[] {
  const now = new Date();
  const inHour = new Date(Math.ceil((now.getTime() + 60 * 60_000) / (5 * 60_000)) * 5 * 60_000);
  const out = [{ label: t('sched.inHour'), at: inHour }];
  if (now.getHours() < 16) out.push({ label: t('sched.thisAfternoon'), at: at(0, 18) });
  out.push({ label: t('sched.tomorrowMorning'), at: at(1, 8) });
  // El lunes que viene (si mañana no es lunes).
  const toMonday = ((1 - now.getDay() + 7) % 7) || 7;
  if (toMonday > 1) out.push({ label: t('sched.monday'), at: at(toMonday, 8) });
  return out;
}

/** Menú de «Programar envío». onPick recibe la hora elegida; «Elegir fecha y hora…» abre un diálogo. */
export function scheduleMenu(onPick: (at: Date) => void, title?: string): MenuItem[] {
  return [
    ...(title ? [{ label: title, icon: '🕒', disabled: true, onSelect: () => {} } as MenuItem, { divider: true } as MenuItem] : []),
    ...scheduleOptions().map((o) => ({ label: `${o.label} · ${whenLabel(o.at.toISOString())}`, icon: '🕒', onSelect: () => onPick(o.at) })),
    { divider: true },
    { label: t('sched.pick'), icon: '📅', onSelect: () => openDialog((close) => <PickWhenDialog onClose={close} onPick={onPick} />) },
  ];
}

export function openScheduleMenu(anchor: HTMLElement, onPick: (at: Date) => void) {
  const r = anchor.getBoundingClientRect();
  openMenuAt(Math.max(8, r.right - 280), r.top - 8, scheduleMenu(onPick, t('sched.menuTitle')));
}

function PickWhenDialog({ onClose, onPick, initial }: { onClose: () => void; onPick: (at: Date) => void; initial?: string }) {
  const start = initial ? new Date(initial) : at(1, 8);
  const pad = (n: number) => String(n).padStart(2, '0');
  const [date, setDate] = useState(`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`);
  const [time, setTime] = useState(`${pad(start.getHours())}:${pad(start.getMinutes())}`);
  const when = new Date(`${date}T${time || '08:00'}`);
  const valid = !Number.isNaN(when.getTime()) && when.getTime() > Date.now() + 60_000;
  const submit = (e: FormEvent) => { e.preventDefault(); if (!valid) return; onPick(when); onClose(); };
  return (
    <Modal title={t('sched.pickTitle')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="field grow"><span>{t('sched.date')}</span><input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="field"><span>{t('sched.time')}</span><input className="input" type="time" required step={300} value={time} onChange={(e) => setTime(e.target.value)} /></label>
        </div>
        <div className={valid ? 'hint' : 'error'}>{valid ? t('sched.willSend', { when: whenLabel(when.toISOString()) }) : t('sched.future')}</div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn primary" disabled={!valid}>🕒 {t('sched.confirm')}</button>
        </div>
      </form>
    </Modal>
  );
}

const excerpt = (s: string, n = 120) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };

function ScheduledRow({ s, showWhere }: { s: ScheduledMessageDTO; showWhere: boolean }) {
  const d = useClient((st) => st.data)!;
  const conv = d.conversations.find((c) => c.id === s.conversationId);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(s.body);
  const failed = s.status === 'failed';
  const run = (p: Promise<unknown>, ok?: string) => p.then(() => ok && toast(ok)).catch((e) => toast(errorText(e)));
  const cancel = () => run(client.cancelScheduled(s.id).then(() => toast(t('sched.cancelled'), {
    label: t('issue.undo'),
    run: () => void client.scheduleMessage(s.conversationId, { body: s.body, sendAt: new Date(Math.max(Date.parse(s.sendAt), Date.now() + 120_000)).toISOString(), mentions: s.mentions, replyTo: s.replyTo }).catch((e) => toast(errorText(e))),
  })));
  return (
    <div className={`card sched-row ${failed ? 'is-failed' : ''}`}>
      <div className="row" style={{ gap: 8 }}>
        <span className="grow small" style={{ fontWeight: 700 }}>
          {failed ? `⚠ ${t('sched.failed')}` : `🕒 ${whenLabel(s.sendAt)}`}
          {showWhere && conv && <> · <button className="link-btn" onClick={() => navigate(`/c/${conv.id}`)}>{conversationTitle(d, conv)}</button></>}
        </span>
      </div>
      {editing ? (
        <form className="sched-edit" onSubmit={(e) => { e.preventDefault(); if (body.trim()) void run(client.updateScheduled(s.id, { body: body.trim() }).then(() => setEditing(false))); }}>
          <textarea className="input" rows={3} autoFocus value={body} onChange={(e) => setBody(e.target.value)} maxLength={8000} />
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn small ghost" onClick={() => { setEditing(false); setBody(s.body); }}>{t('common.cancel')}</button>
            <button className="btn small primary" disabled={!body.trim()}>{t('sched.save')}</button>
          </div>
        </form>
      ) : <div className="sched-body">{excerpt(s.body, 400)}</div>}
      {failed && s.error && <div className="small error">{s.error}</div>}
      {!editing && (
        <div className="row sched-actions">
          <button className="btn small primary" onClick={() => void run(client.sendScheduledNow(s.id), t('sched.sentNow'))}>➤ {t('sched.sendNow')}</button>
          <button className="btn small" onClick={(e) => openScheduleMenu(e.currentTarget, (when) => void run(client.updateScheduled(s.id, { sendAt: when.toISOString() }), t('sched.moved', { when: whenLabel(when.toISOString()) })))}>🕒 {failed ? t('sched.retryLater') : t('sched.change')}</button>
          <button className="btn small" onClick={() => setEditing(true)}>✎ {t('sched.edit')}</button>
          <span className="grow" />
          <button className="btn small ghost" onClick={() => void cancel()}>{t('sched.cancel')}</button>
        </div>
      )}
    </div>
  );
}

export function ScheduledList({ conversationId }: { conversationId?: string }) {
  const all = useClient((s) => s.scheduled);
  const list = all.filter((s) => !conversationId || s.conversationId === conversationId);
  if (!list.length) return <div className="empty">{t('sched.empty')}</div>;
  return <div className="list" style={{ gap: 8 }}>{list.map((s) => <ScheduledRow key={s.id} s={s} showWhere={!conversationId} />)}</div>;
}

/** Franja sobre el compositor: «🕒 2 programados · el próximo mañana a las 8:00». */
export function ScheduledStrip({ conversationId }: { conversationId: string }) {
  const list = useClient((s) => s.scheduled).filter((s) => s.conversationId === conversationId);
  if (!list.length) return null;
  const failed = list.filter((s) => s.status === 'failed').length;
  const next = list.find((s) => s.status !== 'failed');
  const open = () => openDialog((close) => <Modal title={t('sched.titleHere')} onClose={close}><ScheduledList conversationId={conversationId} /></Modal>);
  return (
    <button className={`sched-strip ${failed ? 'is-failed' : ''}`} onClick={open}>
      <span className="grow ellipsis">
        {failed ? `⚠ ${t('sched.failedCount', { n: failed })}` : `🕒 ${list.length === 1 ? t('sched.oneHere') : t('sched.manyHere', { n: list.length })}`}
        {next && !failed ? ` · ${t('sched.next', { when: whenLabel(next.sendAt) })}` : ''}
      </span>
      <span className="link-btn">{t('sched.see')}</span>
    </button>
  );
}

export function ScheduledScreen() {
  const n = useClient((s) => s.scheduled.length);
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <div className="row page-head"><h1 className="grow">{t('nav.scheduled')}{n ? ` · ${n}` : ''}</h1></div>
      <div className="muted" style={{ marginBottom: 16 }}>{t('sched.pageSub')}</div>
      <ScheduledList />
    </div></div>
  );
}
