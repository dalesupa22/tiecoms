/**
 * /llamada/:token — entrar a una llamada con un enlace, sin cuenta (docs/LLAMADAS.md › Invitados por enlace).
 * Pide nombre y correo (validación en vivo; desde el 30-sep-2026 el correo es obligatorio), entra con voz o video y muestra la llamada a pantalla completa: recuadros, pantallas
 * compartidas, silenciar, cámara, compartir pantalla y colgar. Se carga aparte (no pesa en la app normal).
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { GuestCallPreviewDTO } from '@tiecoms/contracts';
import { validGuestEmail } from '../call-link.ts';
import { apiUrl } from '../app-client.ts';
import { hangUp, joinAsGuest, myGuestId, toggleCamera, toggleMute } from '../call.ts';
import { errorText, t } from '../i18n.ts';
import { BASE, asset } from '../router.ts';
import { toast } from '../menu.tsx';
import { Avatar } from '../ui.tsx';
import { ScreenButton, ScreenTile, SharingBar, Tile, callPeople, useCallView } from './Call.tsx';

const NAME_KEY = 'chaggu:guest-name';
const EMAIL_KEY = 'chaggu:guest-email';
const stored = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
/** Crear cuenta desde la llamada (adopción): el registro normal de chaggu. */
const signupHref = () => `${BASE}/signup`;

export default function GuestCallScreen({ token }: { token: string }) {
  const v = useCallView();
  const [info, setInfo] = useState<GuestCallPreviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(() => stored(NAME_KEY));
  const [email, setEmail] = useState(() => stored(EMAIL_KEY));
  // La validación en vivo se muestra al salir del campo o al intentar entrar (no mientras empieza a escribir).
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [after, setAfter] = useState<'left' | 'ended' | null>(null);
  const [wasIn, setWasIn] = useState(false);

  const load = () => {
    setError(null);
    fetch(apiUrl(`/api/v1/call-links/${encodeURIComponent(token)}`)).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(''), { code: r.status === 404 ? 'link_revoked' : j?.error?.code });
      setEnded(false);
      setInfo(j);
    }).catch((e) => {
      // 410 call_ended: el enlace solo vive durante la llamada.
      if (e?.code === 'call_ended') { setEnded(true); return; }
      setError(e?.code === 'link_revoked' ? t('guest.invalid') : errorText(e));
    });
  };
  useEffect(load, [token]);
  // Se acabó la llamada (la cerraron o salió el último de chaggu) sin que yo colgara.
  useEffect(() => {
    if (v && v.phase !== 'ended') setWasIn(true);
    else if (!v && wasIn && !after) setAfter('ended');
  }, [v, wasIn, after]);
  // Al salir o terminar, se vuelve a mirar el enlace (si la llamada terminó: 410 → «Esta llamada ya terminó»).
  useEffect(() => { if (after) load(); }, [after]);

  const nameOk = !!name.trim();
  const emailOk = validGuestEmail(email);
  async function join(camera: boolean, e?: FormEvent) {
    e?.preventDefault();
    setTouched(true);
    const n = name.trim(), m = email.trim().toLowerCase();
    if (!n || !validGuestEmail(m)) return;
    try { localStorage.setItem(NAME_KEY, n); localStorage.setItem(EMAIL_KEY, m); } catch { /* sin almacenamiento */ }
    setBusy(true);
    setAfter(null);
    try { await joinAsGuest(token, n, m, camera); }
    catch (err: any) { if (err?.code === 'call_ended') setEnded(true); else { toast(errorText(err)); load(); } }
    finally { setBusy(false); }
  }

  if (v && v.phase !== 'ended') return <GuestInCall onLeave={() => { setAfter('left'); void hangUp(); }} />;

  return (
    <div className="auth">
      <div className="auth-card">
        <img src={asset('/chaggu-logo.svg')} alt="chaggu" width={180} height={78} />
        {after && !ended && <p style={{ margin: 0, fontWeight: 600 }}>{after === 'left' ? t('guest.left') : t('guest.ended')}</p>}
        {ended ? <EndedCard /> : error ? <div className="error" role="alert">{error}</div> : !info ? <p className="muted">…</p> : (
          <>
            <div>
              <h2 style={{ margin: '0 0 4px' }}>{info.title ?? t('guest.title')}</h2>
              <div className="small muted">{info.orgName ? t('guest.byOrg', { host: info.hostName, org: info.orgName }) : t('guest.by', { host: info.hostName })}</div>
            </div>
            {!info.active ? (
              <>
                <div className="small muted">{t('guest.notLive')}</div>
                <button className="btn" onClick={load}>{t('guest.rejoin')}</button>
              </>
            ) : (
              <form className="grid" style={{ gap: 12 }} onSubmit={(e) => void join(info.kind === 'video', e)}>
                <label className="field"><span>{t('guest.name')}</span>
                  <input className={`input ${touched && !nameOk ? 'is-bad' : ''}`} autoFocus={!name} maxLength={60} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('guest.namePh')}
                    aria-invalid={touched && !nameOk} />
                </label>
                {touched && !nameOk && <div className="guest-form-bad" role="alert">{t('guest.nameMissing')}</div>}
                <label className="field"><span>{t('guest.email')}</span>
                  <input className={`input ${(touched || email.includes('@')) && email && !emailOk ? 'is-bad' : touched && !email ? 'is-bad' : ''}`} type="email" inputMode="email" autoFocus={!!name && !email}
                    maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => email && setTouched(true)}
                    placeholder={t('guest.emailPh')} aria-invalid={touched && !emailOk} aria-describedby="guest-email-help" />
                </label>
                {touched && !emailOk
                  ? <div className="guest-form-bad" role="alert">{email.trim() ? t('guest.emailBad') : t('err.email_required')}</div>
                  : <div className="guest-form-help" id="guest-email-help">{emailOk ? `✓ ${t('guest.emailHelp')}` : t('guest.emailHelp')}</div>}
                <div className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn grow" disabled={busy} onClick={() => void join(false)}>📞 {t('guest.joinAudio')}</button>
                  <button type="button" className="btn primary grow" disabled={busy} onClick={() => void join(true)}>🎥 {t('guest.joinVideo')}</button>
                </div>
                <div className="small muted">{t('guest.privacyShort')}</div>
              </form>
            )}
          </>
        )}
        <div className="small muted" style={{ marginTop: 8 }}>{t('guest.powered')}</div>
      </div>
    </div>
  );
}

/** La llamada ya terminó: el enlace murió con ella. Invitación a crear cuenta (adopción). */
function EndedCard() {
  return (
    <div className="guest-ended" role="status">
      <h2 style={{ margin: 0 }}>{t('guest.endedTitle')}</h2>
      <div className="small muted">{t('guest.endedBody')}</div>
      <div className="guest-signup">
        <div className="small">{t('guest.signupPitch')}</div>
        <a className="btn accent" href={signupHref()} style={{ justifyContent: 'center', textDecoration: 'none' }}>{t('guest.signupCta')}</a>
      </div>
    </div>
  );
}

/** «¿Te gustó? Crea tu cuenta»: discreto, abajo a la derecha, se puede ocultar. */
function LikeItCta() {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div className="guest-like">
      <a href={signupHref()} target="_blank" rel="noopener">{t('guest.likeIt')} ›</a>
      <button onClick={() => setHidden(true)} aria-label={t('guest.hideCta')} title={t('guest.hideCta')}>×</button>
    </div>
  );
}

function GuestInCall({ onLeave }: { onLeave: () => void }) {
  const v = useCallView()!;
  const people = callPeople(v.call);
  const me = myGuestId();
  const others = people.filter((id) => id !== me);
  const nameOf = (id: string) => v.call.names?.[id] ?? '';
  const video = v.tiles.filter((x) => (x.local ? v.camera : true));
  const mine = video.find((x) => x.local);
  const videoBy = new Map(video.filter((x) => !x.local).map((x) => [x.userId, x] as const));
  return (
    <div className="guest-call">
      <header className="row guest-call-head">
        <img src={asset('/chaggu-logo.svg')} alt="chaggu" height={26} />
        <span className="grow" />
        <span className="small">{v.phase === 'connecting' ? t('call.connecting') : `👥 ${people.length}${v.call.transcribing ? ` · ⏺ ${t('call.transcribingAll')}` : ''}`}</span>
      </header>
      {v.sharing && <SharingBar />}
      <main className={`guest-call-stage ${v.screens.length ? 'has-screen' : ''}`}>
        {v.screens.map((x) => <ScreenTile key={x.tileId} tileId={x.tileId} label={x.userId ? nameOf(x.userId) : ''} />)}
        <div className={`call-grid n${Math.min(people.length, 4)}`}>
          {mine
            ? <div className="call-cell"><Tile tileId={mine.tileId} local label={t('call.you')} /></div>
            : <div className="call-tile is-avatar"><Avatar person={{ id: me ?? 'yo', name: me ? nameOf(me) : '' } as any} size={56} /><span className="call-tile-name">{t('call.you')}</span></div>}
          {others.map((id) => {
            const x = videoBy.get(id);
            if (x) return <div key={id} className="call-cell"><Tile tileId={x.tileId} local={false} label={nameOf(id)} /></div>;
            return (
              <div key={id} className={`call-tile is-avatar ${v.speaking.includes(id) ? 'is-speaking' : ''}`}>
                <Avatar person={{ id, name: nameOf(id) } as any} size={56} /><span className="call-tile-name">{nameOf(id)}</span>
                {v.mutedUsers.includes(id) && <span className="call-badges"><span className="call-badge">🔇</span></span>}
              </div>
            );
          })}
        </div>
      </main>
      <LikeItCta />
      <footer className="row call-controls guest-call-controls">
        <button className={`call-ctl ${v.muted ? 'is-off' : ''}`} onClick={toggleMute} aria-pressed={v.muted} title={v.muted ? t('call.unmute') : t('call.mute')}>{v.muted ? '🔇' : '🎙️'}</button>
        <button className={`call-ctl ${v.camera ? '' : 'is-off'}`} onClick={() => void toggleCamera().catch((e) => toast(errorText(e)))} aria-pressed={!v.camera} title={v.camera ? t('call.cameraOff') : t('call.cameraOn')}>{v.camera ? '🎥' : '📷'}</button>
        <ScreenButton v={v} />
        <span className="grow" />
        <button className="btn small call-hang" onClick={onLeave}>{t('call.hangUp')}</button>
      </footer>
    </div>
  );
}
