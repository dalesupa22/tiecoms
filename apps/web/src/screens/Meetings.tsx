import { useEffect, useRef, useState } from 'react';
import type { MeetingConnectionDTO, MeetingDTO, MeetingProvider } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { copyText, toast } from '../menu.tsx';
import { Modal, conversationTitle } from '../ui.tsx';
import { queryParam } from '../router.ts';

/**
 * Reuniones reales con Google Meet, Microsoft Teams o Zoom (docs/TANDA-LECTURA-REUNIONES.md › 4).
 * El enlace solo aparece cuando el proveedor lo confirma; nunca se arma uno a mano.
 */

const ICON: Record<MeetingProvider, string> = { google: '🟢', microsoft: '🟣', zoom: '🔵' };
const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Bogota'; } catch { return 'America/Bogota'; } };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
/** Detectar enlaces de reunión (para el 📹 del calendario y del chat). */
export const isMeetingUrl = (s: string | null | undefined) => !!s && /https:\/\/(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|[\w.-]*zoom\.us)\//.test(s);
export const appLabel = (p: MeetingProvider) => ({ google: 'Meet', microsoft: 'Teams', zoom: 'Zoom' })[p];

function useConnections() {
  const [list, setList] = useState<MeetingConnectionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => client.meetingConnections().then(setList).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); }, []);
  return { list, error, reload: load };
}

/** Abre el consentimiento del proveedor en otra pestaña; al volver, Ajustes › Reuniones confirma. */
async function connect(p: MeetingProvider) {
  try {
    const { url } = await client.connectMeetingProvider(p, 'web');
    window.location.assign(url);
  } catch (e) { toast(errorText(e)); }
}

function statusText(c: MeetingConnectionDTO) {
  if (!c.available) return c.unavailableReason ?? t('meet.unavailable');
  if (c.status === 'active') return t('meet.connectedAs', { email: c.accountEmail ?? '' });
  if (c.status === 'reconnect') return t('meet.reconnectHint');
  return t('meet.notConnected');
}

/** Ajustes › Reuniones: conectar, reconectar o desconectar cada proveedor. */
export function MeetingsSettings() {
  const { list, error, reload } = useConnections();
  useEffect(() => {
    // Vuelta del proveedor: /ajustes?provider=google&connected=1 (o &error=…).
    const p = queryParam('provider');
    if (!p) return;
    if (queryParam('connected')) toast(t('meet.connectedToast', { name: appLabel(p as MeetingProvider) }));
    else if (queryParam('error')) toast(queryParam('error') === 'cancelled' ? t('meet.cancelledToast') : t('meet.failedToast', { code: queryParam('error') ?? '' }));
    history.replaceState(null, '', location.pathname + location.hash);
    void reload();
  }, []);
  return (
    <div id="reuniones">
      <div className="muted small" style={{ marginBottom: 8 }}>{t('meet.settingsHint')}</div>
      {error && <div className="error">{error}</div>}
      {!list && !error && <div className="muted">{t('common.loading')}</div>}
      {list?.map((c) => (
        <div key={c.provider} className="card conv-card meet-conn">
          <span style={{ fontSize: 20 }} aria-hidden>{ICON[c.provider]}</span>
          <span className="grow" style={{ minWidth: 0 }}>
            <b style={{ display: 'block' }}>{c.label}</b>
            <span className={`small ${c.status === 'reconnect' || !c.available ? 'error' : 'muted'}`} style={{ display: 'block' }}>{statusText(c)}</span>
          </span>
          {c.available && c.status !== 'active' && <button className="btn small primary" onClick={() => void connect(c.provider)}>{c.status === 'reconnect' ? t('meet.reconnect') : t('meet.connect')}</button>}
          {c.status !== 'none' && <button className="btn small ghost" onClick={() => void client.disconnectMeetingProvider(c.provider).then(reload).catch((e) => toast(errorText(e)))}>{t('meet.disconnect')}</button>}
        </div>
      ))}
    </div>
  );
}

/**
 * «📹 Reunión ahora» / «📅 Agendar reunión con enlace». Una llave por intento: un doble clic o un
 * reintento tras un fallo de red devuelven la misma reunión, no una nueva.
 */
export function MeetingDialog({ conversationId, scheduled = false, onClose }: { conversationId: string; scheduled?: boolean; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const conv = d.conversations.find((c) => c.id === conversationId);
  const { list, error: listError, reload } = useConnections();
  const [provider, setProvider] = useState<MeetingProvider | null>(null);
  const [when, setWhen] = useState<'now' | 'later'>(scheduled ? 'later' : 'now');
  const start0 = new Date(Date.now() + 3600_000); start0.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  const [date, setDate] = useState(`${start0.getFullYear()}-${pad(start0.getMonth() + 1)}-${pad(start0.getDate())}`);
  const [time, setTime] = useState(`${pad(start0.getHours())}:00`);
  const [duration, setDuration] = useState(30);
  const [title, setTitle] = useState(`${t('meet.defaultTitle')} · ${conv ? conversationTitle(d, conv) : ''}`.trim());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<MeetingDTO | null>(null);
  const key = useRef(uuid());
  useEffect(() => {
    if (!list || provider) return;
    const ready = list.find((c) => c.available && c.status === 'active');
    setProvider((ready ?? list.find((c) => c.available))?.provider ?? null);
  }, [list]);
  const sel = list?.find((c) => c.provider === provider) ?? null;
  const startsAt = when === 'now' ? null : new Date(`${date}T${time}`);
  const invalidWhen = !!startsAt && (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now() - 60_000);
  // Cambiar algo del formulario es otra reunión: llave nueva. Un reintento sin cambios reusa la misma.
  useEffect(() => { key.current = uuid(); }, [provider, when, date, time, duration, title]);

  async function create() {
    if (!provider || busy) return;
    setBusy(true); setError(null);
    try {
      const m = await client.createMeeting({
        provider, conversationId, idempotencyKey: key.current, title: title.trim() || t('meet.defaultTitle'),
        startsAt: startsAt ? startsAt.toISOString() : null, durationMin: duration, timezone: deviceTz(), share: true,
      });
      setDone(m);
    } catch (e: any) {
      setError(errorText(e));
      if (e?.code === 'reconnect_required' || e?.code === 'not_connected') void reload();
    } finally { setBusy(false); }
  }

  if (done?.joinUrl) {
    return (
      <Modal title={`📹 ${t('meet.createdTitle')}`} onClose={onClose}>
        <div className="meet-done">
          <div className="small muted">{sel?.label} · {when === 'now' ? t('meet.now') : new Date(done.startsAt).toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</div>
          <a className="meet-link" href={done.joinUrl} target="_blank" rel="noopener noreferrer">{done.joinUrl}</a>
          <div className="hint">{done.messageId ? t('meet.sharedHint') : t('meet.notSharedHint')}</div>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => void copyText(done.joinUrl!).then(() => toast(t('toast.linkCopied')))}>⛓ {t('meet.copy')}</button>
          <a className="btn primary" href={done.joinUrl} target="_blank" rel="noopener noreferrer">↗ {t('meet.openIn', { app: appLabel(done.provider) })}</a>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={when === 'now' ? `📹 ${t('meet.nowTitle')}` : `📅 ${t('meet.laterTitle')}`} onClose={onClose}>
      <div className="issue-q">
        <div className="issue-q-label">{t('meet.withWhat')}</div>
        {!list && (listError ? <div className="error">{listError}</div> : <div className="muted">{t('common.loading')}</div>)}
        <div className="chips">
          {list?.map((c) => (
            <button key={c.provider} className={`chip ${provider === c.provider ? 'on' : ''}`} aria-pressed={provider === c.provider} disabled={!c.available}
              title={statusText(c)} onClick={() => setProvider(c.provider)}>{ICON[c.provider]} {c.label}{c.available && c.status !== 'active' ? ` · ${t('meet.notConnectedShort')}` : ''}</button>
          ))}
        </div>
        {sel && <div className={`small ${sel.status === 'active' ? 'muted' : 'error'}`}>{statusText(sel)}</div>}
        {sel && sel.available && sel.status !== 'active' && (
          <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => void connect(sel.provider)}>{sel.status === 'reconnect' ? t('meet.reconnect') : t('meet.connectTo', { name: sel.label })}</button>
        )}
        {list && list.every((c) => !c.available) && <div className="hint">{t('meet.noneAvailable')}</div>}
      </div>
      <div className="issue-q">
        <div className="issue-q-label">{t('meet.when')}</div>
        <div className="chips">
          <button className={`chip ${when === 'now' ? 'on' : ''}`} onClick={() => setWhen('now')}>{t('meet.now')}</button>
          <button className={`chip ${when === 'later' ? 'on' : ''}`} onClick={() => setWhen('later')}>📅 {t('meet.later')}</button>
        </div>
        {when === 'later' && (
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 180 }} aria-label={t('sched.date')} />
            <input className="input" type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} style={{ maxWidth: 130 }} aria-label={t('sched.time')} />
          </div>
        )}
        <div className="chips">
          {[15, 30, 45, 60].map((m) => <button key={m} className={`chip ${duration === m ? 'on' : ''}`} onClick={() => setDuration(m)}>{m} min</button>)}
        </div>
        {invalidWhen && <div className="error">{t('sched.future')}</div>}
      </div>
      <label className="field"><span>{t('meet.titleLabel')}</span><input className="input" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !sel || sel.status !== 'active' || invalidWhen || title.trim().length < 2} onClick={() => void create()}>
          {busy ? t('meet.creating') : `📹 ${t('meet.createShare')}`}
        </button>
      </div>
    </Modal>
  );
}
