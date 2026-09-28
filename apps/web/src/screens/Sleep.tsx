import { useEffect, useState } from 'react';
import type { ConversationDTO, SleepDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { Modal, personById } from '../ui.tsx';
import { whenLabel } from './Scheduled.tsx';

/**
 * Modo sueño: cada persona tiene un horario de descanso (22:00–07:00 por defecto) en su zona horaria.
 * Dentro de él el servidor no manda pushes. Aquí: ajustes, y el aviso a quien escribe a alguien dormido.
 */

type Window = { start: string; end: string; tz: string };
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h! * 60 + m!; };
const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Bogota'; } catch { return 'America/Bogota'; } };

function minutesIn(tz: string, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === 'hour')?.value), m = Number(parts.find((p) => p.type === 'minute')?.value);
    return h * 60 + m;
  } catch { return at.getHours() * 60 + at.getMinutes(); }
}

export function sleepingNow(w: Window | null | undefined, at = new Date()) {
  if (!w) return false;
  const s = toMin(w.start), e = toMin(w.end), n = minutesIn(w.tz, at);
  if (s === e) return false;
  return s < e ? n >= s && n < e : n >= s || n < e;
}

/** Cuándo se despierta (próximo fin de la ventana), como fecha absoluta. */
export function wakeAt(w: Window, at = new Date()) {
  const diff = (toMin(w.end) - minutesIn(w.tz, at) + 1440) % 1440 || 1440;
  const d = new Date(at.getTime() + diff * 60_000);
  d.setSeconds(0, 0);
  return d;
}

const hourLabel = (hhmm: string) => { const d = new Date(); d.setHours(toMin(hhmm) / 60 | 0, toMin(hhmm) % 60, 0, 0); return d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' }); };

/** Refresca cada minuto para que los avisos entren y salgan solos. */
function useMinute() {
  const [, set] = useState(0);
  useEffect(() => { const i = setInterval(() => set((x) => x + 1), 60_000); return () => clearInterval(i); }, []);
}

/** Mientras la persona no fije una zona a mano, se sigue la del dispositivo (viajes). */
export function useSleepTzSync() {
  const sleep = useClient((s) => s.data?.me.sleep);
  useEffect(() => {
    if (!sleep?.tzAuto) return;
    const tz = deviceTz();
    if (tz && tz !== sleep.tz) void client.setSleep({ tz, tzAuto: true }).catch(() => {});
  }, [sleep?.tzAuto, sleep?.tz]);
}

export function sleepSummary(s: SleepDTO | undefined) {
  if (!s) return null;
  return s.on ? t('sleep.summary', { from: hourLabel(s.start), to: hourLabel(s.end) }) : t('sleep.off');
}

export function SleepDialog({ onClose }: { onClose: () => void }) {
  const cur = useClient((s) => s.data?.me.sleep);
  const [on, setOn] = useState(cur?.on ?? true);
  const [start, setStart] = useState(cur?.start ?? '22:00');
  const [end, setEnd] = useState(cur?.end ?? '07:00');
  const [busy, setBusy] = useState(false);
  const tz = deviceTz();
  const save = async () => {
    setBusy(true);
    try {
      await client.setSleep({ on, start, end, ...(cur?.tz !== tz ? { tz, tzAuto: true } : {}) });
      toast(on ? t('sleep.saved', { from: hourLabel(start), to: hourLabel(end) }) : t('sleep.savedOff'));
      onClose();
    } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={`🌙 ${t('sleep.title')}`} onClose={onClose}>
      <div className="muted">{t('sleep.explain')}</div>
      <label className="card conv-card check" style={{ margin: '12px 0' }}>
        <span className="grow"><b>{t('sleep.switch')}</b><span className="small muted" style={{ display: 'block' }}>{on ? t('sleep.summary', { from: hourLabel(start), to: hourLabel(end) }) : t('sleep.off')}</span></span>
        <button type="button" className="switch" role="switch" aria-checked={on} aria-label={t('sleep.switch')} onClick={() => setOn(!on)} />
      </label>
      {on && (
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="field grow"><span>{t('sleep.from')}</span><input className="input" type="time" step={900} value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label className="field grow"><span>{t('sleep.to')}</span><input className="input" type="time" step={900} value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        </div>
      )}
      <div className="hint">{t('sleep.tz', { tz })}</div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || (on && start === end)} onClick={() => void save()}>{t('sched.save')}</button>
      </div>
    </Modal>
  );
}

/**
 * Aviso sobre el compositor si a quien escribo le toca dormir: el mensaje le llega sin sonar.
 * En un directo siempre; en grupos solo mientras escribo. Ofrece programarlo para cuando despierte.
 */
export function SleepNotice({ conv, typing, onSchedule }: { conv: ConversationDTO; typing: boolean; onSchedule?: (at: Date) => void }) {
  const d = useClient((s) => s.data)!;
  useMinute();
  const asleep = conv.memberIds.filter((id) => id !== d.me.id).map((id) => personById(d, id))
    .filter((p): p is NonNullable<typeof p> => !!p && p.kind === 'human' && sleepingNow(p.sleep));
  if (!asleep.length) return null;
  const others = conv.memberIds.filter((id) => id !== d.me.id && personById(d, id)?.kind === 'human').length;
  const one = asleep.length === 1 ? asleep[0]! : null;
  if (!one && !typing) return null;
  if (others > 1 && !typing) return null;
  const wake = one?.sleep ? wakeAt(one.sleep) : null;
  return (
    <div className="sleep-notice" role="status">
      <span aria-hidden>🌙</span>
      <span className="grow">
        {one && others === 1
          ? t('sleep.noticeOne', { name: one.name.split(' ')[0]!, when: whenLabel(wake!.toISOString()) })
          : t('sleep.noticeMany', { n: asleep.length })}
      </span>
      {one && others === 1 && typing && onSchedule && wake && (
        <button className="btn small" onClick={() => onSchedule(wake)}>🕒 {t('sleep.scheduleWake', { time: wake.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' }) })}</button>
      )}
    </div>
  );
}
