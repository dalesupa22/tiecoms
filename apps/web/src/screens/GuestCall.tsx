/**
 * /llamada/:token — entrar a una llamada con un enlace, sin cuenta (docs/LLAMADAS.md › Invitados por enlace).
 * Pide el nombre, entra con voz o video y muestra la llamada a pantalla completa: recuadros, pantallas
 * compartidas, silenciar, cámara, compartir pantalla y colgar. Se carga aparte (no pesa en la app normal).
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { GuestCallPreviewDTO } from '@tiecoms/contracts';
import { apiUrl } from '../app-client.ts';
import { hangUp, joinAsGuest, joinRoomAsGuest, myGuestId, toggleCamera, toggleMute } from '../call.ts';
import { errorText, t } from '../i18n.ts';
import { asset } from '../router.ts';
import { toast } from '../menu.tsx';
import { Avatar } from '../ui.tsx';
import { ScreenButton, ScreenTile, SharingBar, Tile, callPeople, useCallView } from './Call.tsx';

const NAME_KEY = 'chaggu:guest-name';

/** Con `room` es una sala abierta (/sala/:código): siempre se puede entrar. Con `token`, el enlace de una llamada en curso. */
export default function GuestCallScreen({ token = '', room }: { token?: string; room?: string }) {
  const v = useCallView();
  const [info, setInfo] = useState<GuestCallPreviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(() => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } });
  const [busy, setBusy] = useState(false);
  const [after, setAfter] = useState<'left' | 'ended' | null>(null);
  const [wasIn, setWasIn] = useState(false);

  const load = () => {
    setError(null);
    fetch(apiUrl(room ? `/api/v1/rooms/${encodeURIComponent(room)}` : `/api/v1/call-links/${encodeURIComponent(token)}`)).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(''), { code: r.status === 404 || r.status === 410 ? 'link_revoked' : j?.error?.code });
      setInfo(j);
    }).catch((e) => setError(e?.code === 'link_revoked' ? t('guest.invalid') : errorText(e)));
  };
  useEffect(load, [token, room]);
  // Se acabó la llamada (la cerraron o salió el último de chaggu) sin que yo colgara.
  useEffect(() => {
    if (v && v.phase !== 'ended') setWasIn(true);
    else if (!v && wasIn && !after) setAfter('ended');
  }, [v, wasIn, after]);

  async function join(camera: boolean, e?: FormEvent) {
    e?.preventDefault();
    const n = name.trim();
    if (!n) return;
    try { localStorage.setItem(NAME_KEY, n); } catch { /* sin almacenamiento */ }
    setBusy(true);
    setAfter(null);
    try { await (room ? joinRoomAsGuest(room, n, camera) : joinAsGuest(token, n, camera)); }
    catch (err) { toast(errorText(err)); load(); }
    finally { setBusy(false); }
  }

  if (v && v.phase !== 'ended') return <GuestInCall onLeave={() => { setAfter('left'); void hangUp(); }} />;

  return (
    <div className="auth">
      <div className="auth-card">
        <img src={asset('/chaggu-logo.svg')} alt="chaggu" width={180} height={78} />
        {after && <p style={{ margin: 0, fontWeight: 600 }}>{after === 'left' ? t('guest.left') : t('guest.ended')}</p>}
        {error ? <div className="error" role="alert">{error}</div> : !info ? <p className="muted">…</p> : (
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
                  <input className="input" autoFocus maxLength={60} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('guest.namePh')} />
                </label>
                <div className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn grow" disabled={busy || !name.trim()} onClick={() => void join(false)}>📞 {t('guest.joinAudio')}</button>
                  <button type="button" className="btn primary grow" disabled={busy || !name.trim()} onClick={() => void join(true)}>🎥 {t('guest.joinVideo')}</button>
                </div>
                <div className="small muted">{t('guest.privacy')}</div>
              </form>
            )}
          </>
        )}
        <div className="small muted" style={{ marginTop: 8 }}>{t('guest.powered')}</div>
      </div>
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
