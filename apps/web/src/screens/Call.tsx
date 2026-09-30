/**
 * Llamadas en la web: botones del encabezado, franja «llamada en curso», aviso de llamada entrante,
 * panel flotante de la llamada (con subtítulos y el interruptor de transcripción) y la transcripción guardada.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { flashTitle } from '../bubbles.tsx';
import type { ActiveCallDTO, CallDTO, CallDeviceDTO, CallHistoryItemDTO, CallTranscriptDTO, ConversationDTO } from '@tiecoms/contracts';
import { client, isDesktop, useClient } from '../app-client.ts';
import { bindTile, canShareScreen, chooseAudioInput, chooseAudioOutput, currentCall, hangUp, joinCall, listAudioInputs, listAudioOutputs, passHere, setTranscription, startCall, startScreenShare, stopScreenShare, subscribeCall, toggleCamera, toggleMute, type CallView } from '../call.ts';
import { errorText, locale, t } from '../i18n.ts';
import { openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { navigate } from '../router.ts';
import { openDialog } from '../actions.tsx';
import { startRingtone, stopRingtone } from '../sound.ts';
import { directOtherId, Avatar, ConvAvatar, Modal, conversationTitle, personById } from '../ui.tsx';

export const useCallView = () => useSyncExternalStore((l) => subscribeCall(() => l()), currentCall);
/** Quienes están dentro: personas de chaggu y, al final, los invitados por enlace ("guest:{id}", como en Chime). */
export const callPeople = (c: CallDTO) => [...c.activeUserIds, ...(c.guests ?? []).map((g) => `guest:${g.id}`)];
const guestName = (c: CallDTO, id: string | null) => (id?.startsWith('guest:') ? c.guests?.find((g) => `guest:${g.id}` === id)?.name ?? '' : '');
/** Nombre corto; si la persona no está en mi lista (me agregaron a la llamada), sale de call.names. */
const firstName = (d: ReturnType<typeof client.getState>['data'], id: string | null, names?: Record<string, string>) =>
  ((id && (personById(d!, id)?.name ?? names?.[id])) || '').split(' ')[0] ?? '';
const fail = (e: unknown) => toast(errorText(e));

/** 📞 y 🎥 del encabezado (solo con las llamadas prendidas en el servidor y si puedo escribir). */
export function CallButtons({ conv }: { conv: ConversationDTO }) {
  const on = useClient((s) => s.data?.features?.calls === true);
  const active = useClient((s) => s.calls[conv.id]);
  useEffect(() => { if (on && active === undefined) void client.loadCall(conv.id).catch(() => {}); }, [on, conv.id, active]);
  if (!on || !conv.canPost) return null;
  return <>
    <button className="icon-btn" aria-label={t('call.audio')} title={t('call.audio')} onClick={() => void startCall(conv.id, 'audio').catch(fail)}>📞</button>
    <button className="icon-btn head-call-video" aria-label={t('call.video')} title={t('call.video')} onClick={() => void startCall(conv.id, 'video').catch(fail)}>🎥</button>
  </>;
}

/** Franja arriba del chat cuando hay una llamada en curso a la que no he entrado. */
export function CallBanner({ conversationId }: { conversationId: string }) {
  const call = useClient((s) => s.calls[conversationId]);
  const d = useClient((s) => s.data);
  const v = useCallView();
  if (!call || !d || v?.call.id === call.id) return null;
  const names = call.activeUserIds.map((id) => firstName(d, id)).filter(Boolean).join(', ');
  return (
    <div className="call-banner" role="status">
      <span className="grow">{call.kind === 'video' ? '🎥' : '📞'} {t('call.inProgress')}{names ? ` · ${names}` : ''}{call.transcribing ? ` · ${t('call.transcribingShort')}` : ''}</span>
      <button className="btn accent small" onClick={() => void joinCall(call.id, false).catch(fail)}>{t('call.join')}</button>
    </div>
  );
}

// ---------- Llamada entrante ----------
let ringing: { call: CallDTO; callerName: string; title: string | null } | null = null;
const ringListeners = new Set<() => void>();
let ringTimer: ReturnType<typeof setTimeout> | null = null;
export function showIncomingCall(call: CallDTO, callerName: string, title: string | null) {
  if (currentCall()?.call.id === call.id) return;
  ringing = { call, callerName, title };
  ringListeners.forEach((l) => l());
  startRingtone(client.getState().data?.me.ringtone);
  flashTitle(`${call.kind === 'video' ? '🎥' : '📞'} ${t('call.incomingFrom', { name: callerName })}`);
  if (ringTimer) clearTimeout(ringTimer);
  // Deja de sonar a los 45 s si nadie contesta.
  ringTimer = setTimeout(dismissRing, 45_000);
}
function dismissRing() { stopRingtone(); flashTitle(null); ringing = null; ringListeners.forEach((l) => l()); }
/** Contesté o rechacé en otro de mis dispositivos (call.answered / call.declined): aquí deja de sonar. */
export function dismissIncomingCall(callId: string) { if (ringing?.call.id === callId) dismissRing(); }

export function IncomingCallHost() {
  const r = useSyncExternalStore((l) => { ringListeners.add(l); return () => ringListeners.delete(l); }, () => ringing);
  const live = useClient((s) => (r ? s.calls[r.call.conversationId] : undefined));
  // Si la llamada terminó o ya entré desde otro lado, el aviso se va.
  useEffect(() => { if (r && live === null) dismissRing(); }, [r, live]);
  if (!r) return null;
  const answer = (camera: boolean) => { dismissRing(); void joinCall(r.call.id, camera).catch(fail); };
  return (
    <div className="call-ring" role="alertdialog" aria-label={t('call.incoming')}>
      <div className="call-ring-pulse" aria-hidden>{r.call.kind === 'video' ? '🎥' : '📞'}</div>
      <div className="grow" style={{ minWidth: 0 }}>
        <strong className="ellipsis">{r.callerName}</strong>
        <div className="small muted ellipsis">{r.title ? t('call.incomingIn', { title: r.title }) : t('call.incoming')}</div>
      </div>
      <button className="btn small" onClick={() => { const id = r.call.id; dismissRing(); void client.declineCall(id).catch(() => {}); }}>{t('call.decline')}</button>
      <button className="btn small" onClick={() => answer(false)} title={t('call.answerAudio')}>📞</button>
      {r.call.kind === 'video' && <button className="btn accent small" onClick={() => answer(true)} title={t('call.answerVideo')}>🎥</button>}
      {r.call.kind !== 'video' && <button className="btn accent small" onClick={() => answer(false)}>{t('call.answer')}</button>}
    </div>
  );
}

// ---------- Panel de la llamada ----------
export function Tile({ tileId, label, local }: { tileId: number; label: string; local: boolean }) {
  return (
    <div className={`call-tile ${local ? 'is-local' : ''}`}>
      <video ref={(el) => bindTile(tileId, el)} autoPlay playsInline muted={local} />
      <span className="call-tile-name">{label}</span>
    </div>
  );
}

/** Pantalla compartida por otra persona: entera (sin recortar) y con pantalla completa al tocarla. */
export function ScreenTile({ tileId, label }: { tileId: number; label: string }) {
  let el: HTMLVideoElement | null = null;
  const full = () => { const v = el as any; if (!v) return; (v.requestFullscreen ?? v.webkitRequestFullscreen ?? v.webkitEnterFullscreen)?.call(v); };
  return (
    <div className="call-screen">
      <video ref={(v) => { el = v; bindTile(tileId, v); }} autoPlay playsInline muted onDoubleClick={full} />
      <span className="call-tile-name">🖥️ {t('call.screenOf', { name: label })}</span>
      <button className="call-screen-full" onClick={full} title={t('call.fullscreen')} aria-label={t('call.fullscreen')}>⛶</button>
    </div>
  );
}

/** Franja «Estás compartiendo tu pantalla · Dejar de compartir». */
export function SharingBar() {
  return <div className="call-sharing" role="status">🖥️ {t('call.sharingNow')} <button className="btn small" onClick={stopScreenShare}>{t('call.shareStop')}</button></div>;
}

/** Botón 🖥️: compartir o dejar de compartir (solo donde el navegador lo permite). */
export function ScreenButton({ v }: { v: CallView }) {
  if (!canShareScreen()) return null;
  return <button className={`call-ctl ${v.sharing ? 'is-rec' : ''}`} onClick={() => (v.sharing ? stopScreenShare() : void startScreenShare().catch(fail))}
    aria-pressed={v.sharing} title={v.sharing ? t('call.shareStop') : t('call.shareScreen')} aria-label={v.sharing ? t('call.shareStop') : t('call.shareScreen')}>🖥️</button>;
}

/** «Enlace para invitados»: crea el enlace, lo copia y deja compartirlo o quitarlo. */
function GuestLinkDialog({ call, onClose }: { call: CallDTO; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client.createCallLink(call.id).then((l) => { setUrl(l.url); void navigator.clipboard?.writeText(l.url).then(() => toast(t('call.linkCopied'))).catch(() => {}); })
      .catch((e) => setError(errorText(e)));
  }, [call.id]);
  const share = () => { if (url) void (navigator as any).share?.({ title: t('call.linkShareTitle'), url }).catch(() => {}); };
  return (
    <Modal title={t('call.guestLink')} onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>{t('call.guestLinkHelp')}</p>
      {error ? <div className="error">{error}</div> : (
        <div className="row" style={{ gap: 8 }}>
          <input className="input grow" readOnly value={url ?? t('call.connecting')} onFocus={(e) => e.currentTarget.select()} />
          <button className="btn primary small" disabled={!url} onClick={() => url && void navigator.clipboard?.writeText(url).then(() => toast(t('call.linkCopied')))}>{t('call.copy')}</button>
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        {'share' in navigator && <button className="btn small" disabled={!url} onClick={share}>{t('call.linkShare')}</button>}
        <span className="grow" />
        <button className="btn small" onClick={() => void client.revokeCallLinks(call.id).then(() => { toast(t('call.linkRevoked')); onClose(); }).catch(fail)}>{t('call.linkRevoke')}</button>
      </div>
    </Modal>
  );
}

type ClientData = NonNullable<ReturnType<typeof client.getState>['data']>;

/** Posición del panel arrastrado (esquina superior izquierda), guardada en este navegador. */
const DOCK_POS_KEY = 'chaggu:call-dock-pos';
function readDockPos(): { x: number; y: number } | null {
  try { const v = JSON.parse(localStorage.getItem(DOCK_POS_KEY) ?? 'null'); return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? v : null; } catch { return null; }
}
const clampPos = (p: { x: number; y: number }, el: HTMLElement | null) => {
  const w = el?.offsetWidth ?? 380, h = el?.offsetHeight ?? 200;
  return { x: Math.min(Math.max(8, p.x), Math.max(8, innerWidth - w - 8)), y: Math.min(Math.max(8, p.y), Math.max(8, innerHeight - h - 8)) };
};

/**
 * Panel de la llamada, como Google Meet (pedido de Danny, 30-sep-2026):
 * - se arrastra por el encabezado a cualquier parte y recuerda dónde quedó (doble clic lo devuelve a la esquina);
 * - ⛶ pantalla completa (Esc sale), – minimiza;
 * - ⧉ ventana flotante encima de todo (Picture-in-Picture): con Chrome/Edge es la llamada completa con sus
 *   botones y se abre sola al cambiar de pestaña; en Safari y la app de Mac, el video de quien habla.
 */
export function CallDock() {
  const v = useCallView();
  const d = useClient((s) => s.data);
  const [min, setMin] = useState(false);
  const [full, setFull] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(readDockPos);
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  const dragged = useRef(false);
  const pip = usePip(v, d);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!v) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(v.call.startedAt)) / 1000)));
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, [v?.call.id]);
  // Esc sale de pantalla completa; si el navegador sale de su pantalla completa, también el panel.
  useEffect(() => {
    if (!full) return;
    const k = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    const fs = () => { if (!document.fullscreenElement) setFull(false); };
    addEventListener('keydown', k);
    document.addEventListener('fullscreenchange', fs);
    return () => { removeEventListener('keydown', k); document.removeEventListener('fullscreenchange', fs); };
  }, [full]);
  // Al achicar la ventana, el panel no se queda por fuera.
  useEffect(() => {
    const on = () => setPos((p) => (p ? clampPos(p, dockEl) : p));
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, [dockEl]);
  useEffect(() => { if (!v) { setFull(false); setMin(false); } }, [!!v]);
  if (!v || !d) return null;

  const toggleFull = () => {
    const next = !full;
    setFull(next);
    if (next) { setMin(false); if (document.fullscreenEnabled) void dockEl?.requestFullscreen?.().catch(() => {}); }
    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  };
  const startDrag = (e: React.PointerEvent) => {
    // Se arrastra desde cualquier parte del encabezado, también el título (un clic sin mover abre el chat).
    const target = e.target as HTMLElement;
    if (full || e.button !== 0 || (target.closest('button, a, input, select') && !target.closest('.call-dock-title'))) return;
    const el = dockEl;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    el.setPointerCapture(e.pointerId);
    el.classList.add('is-dragging');
    e.preventDefault();
    let last = { x: r.left, y: r.top };
    const x0 = e.clientX, y0 = e.clientY;
    dragged.current = false;
    const move = (ev: PointerEvent) => {
      if (!dragged.current && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      dragged.current = true;
      last = clampPos({ x: ev.clientX - dx, y: ev.clientY - dy }, el); setPos(last);
    };
    const up = () => {
      el.classList.remove('is-dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (dragged.current) { try { localStorage.setItem(DOCK_POS_KEY, JSON.stringify(last)); } catch { /* sin almacenamiento */ } }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const resetPos = () => { setPos(null); try { localStorage.removeItem(DOCK_POS_KEY); } catch { /* */ } };
  const style = !full && pos && innerWidth > 860 ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined;
  const conv = d.conversations.find((c) => c.id === v.call.conversationId);
  const others = callPeople(v.call).filter((id) => id !== d.me.id);
  const nameOf = (id: string) => (id === d.me.id ? t('call.you') : guestName(v.call, id) || firstName(d, id, v.call.names));
  const title = (conv ? conv.name ?? others.map(nameOf).join(', ') : others.map(nameOf).join(', ')) || t('call.title');
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  return (
    <aside ref={setDockEl} style={style}
      className={`call-dock ${min && !full && !pip.mini ? 'is-min' : ''} ${full || pip.mini ? 'is-full' : ''} ${pip.mini ? 'is-mini' : ''} ${v.screens.length && !min ? 'has-screen' : ''} ${pip.docOpen ? 'is-in-pip' : ''}`} aria-label={t('call.title')}>
      <div className="row call-dock-head" onPointerDown={startDrag} onDoubleClick={full ? undefined : resetPos} title={full ? undefined : t('call.dragHint')}>
        <span className={`call-dot ${v.phase === 'live' ? 'is-live' : ''}`} aria-hidden />
        <button className="grow ellipsis call-dock-title" onClick={() => { if (dragged.current) { dragged.current = false; return; } setFull(false); navigate(`/c/${v.call.conversationId}`); }}>{title}</button>
        <span className="small muted">{v.phase === 'connecting' ? t('call.connecting') : clock}</span>
        {pip.supported && <button className="icon-btn" aria-label={t('call.pip')} title={t('call.pip')} aria-pressed={pip.open} onClick={() => void pip.toggle()}>⧉</button>}
        {!pip.mini && <button className="icon-btn" aria-label={full ? t('call.exitFull') : t('call.fullscreen')} title={full ? t('call.exitFull') : t('call.fullscreen')} onClick={toggleFull}>{full ? '⤡' : '⛶'}</button>}
        {!full && !pip.mini && <button className="icon-btn" aria-label={min ? t('call.expand') : t('call.minimize')} title={min ? t('call.expand') : t('call.minimize')} onClick={() => setMin(!min)}>{min ? '▢' : '–'}</button>}
      </div>
      {pip.docOpen
        ? <div className="call-in-pip small">⧉ {t('call.inPip')} <button className="btn small" onClick={() => void pip.toggle()}>{t('call.pipBack')}</button></div>
        : <CallPanel v={v} d={d} compact={min && !full && !pip.mini} nameOf={nameOf} pip={pip.mini} />}
      {pip.portal}
    </aside>
  );
}

/** Contenido de la llamada: pantallas, recuadros, subtítulos y botones (en el panel o en la ventana flotante). */
function CallPanel({ v, d, compact, nameOf, pip }: { v: CallView; d: ClientData; compact: boolean; nameOf: (id: string) => string; pip?: boolean }) {
  const people = callPeople(v.call);
  const others = people.filter((id) => id !== d.me.id);
  // Cuadrícula en cuanto alguien tiene video: quien no tiene cámara sigue ahí como avatar.
  // Los recuadros remotos se muestran aunque Chime diga active=false: se activan recién al enlazarlos a un
  // <video> (antes se filtraban y el video de los demás nunca aparecía). Si alguien apaga la cámara, Chime
  // quita el recuadro (videoTileWasRemoved).
  const video = v.tiles.filter((x) => (x.local ? v.camera : true));
  const videoBy = new Map(video.map((x) => [x.local ? d.me.id : x.userId, x] as const));
  const pending = (v.call.invited ?? []).filter((x) => !x.joined && !v.call.activeUserIds.includes(x.userId));
  const toggleTranscript = () => {
    if (v.call.transcribing) { void setTranscription(false).catch(fail); return; }
    openDialog((close) => <TranscriptConsent onClose={close} onConfirm={(ai) => { close(); void setTranscription(true, ai).catch(fail); }} />);
  };
  return <>
    {v.call.transcribing && <div className="call-rec" role="status">⏺ {t('call.transcribingAll')}</div>}
    {v.sharing && <SharingBar />}
    {!compact && <>
      {v.screens.map((x) => <ScreenTile key={x.tileId} tileId={x.tileId} label={x.userId ? nameOf(x.userId) : ''} />)}
      {video.length > 0
        ? <div className={`call-grid n${Math.min(people.length, 4)}`}>{people.map((id) => {
            const x = videoBy.get(id);
            const label = nameOf(id);
            const muted = id === d.me.id ? v.muted : v.mutedUsers.includes(id);
            return x
              ? <div key={id} className="call-cell"><Tile tileId={x.tileId} local={x.local} label={label} /><PersonBadges muted={muted} camera /></div>
              : <div key={id} className={`call-tile is-avatar ${v.speaking.includes(id) ? 'is-speaking' : ''}`}>
                  <Avatar person={personById(d, id) ?? ({ id, name: label } as any)} size={56} /><span className="call-tile-name">{label}</span><PersonBadges muted={muted} camera={false} />
                </div>;
          })}</div>
        : <div className="call-people">{people.map((id) => (
            <div key={id} className={`call-person ${v.speaking.includes(id) ? 'is-speaking' : ''}`}>
              <Avatar person={personById(d, id) ?? ({ id, name: nameOf(id) } as any)} size={44} /><span className="small ellipsis">{nameOf(id)}</span>
              {(id === d.me.id ? v.muted : v.mutedUsers.includes(id)) && <span className="call-badge" title={t('call.personMuted')} aria-label={t('call.personMuted')}>🔇</span>}
            </div>))}
            {others.length === 0 && <div className="small muted">{t('call.waiting')}</div>}
          </div>}
      {!pip && pending.length > 0 && <InvitedList call={v.call} pending={pending} />}
      {v.call.transcribing && v.captions.length > 0 && (
        <div className="call-captions" aria-live="polite">
          {v.captions.slice(-4).map((c) => <div key={c.resultId} className={c.partial ? 'is-partial' : ''}><b>{c.userId === d.me.id ? t('call.you') : firstName(d, c.userId, v.call.names) || '·'}:</b> {c.processing ? <span className="call-processing">⏳ {t('call.processing')}</span> : c.text}</div>)}
        </div>
      )}
    </>}
    <div className="row call-controls">
      <button className={`call-ctl ${v.muted ? 'is-off' : ''}`} onClick={toggleMute} aria-pressed={v.muted} title={v.muted ? t('call.unmute') : t('call.mute')}>{v.muted ? '🔇' : '🎙️'}</button>
      <button className={`call-ctl ${v.camera ? '' : 'is-off'}`} onClick={() => void toggleCamera().catch(fail)} aria-pressed={!v.camera} title={v.camera ? t('call.cameraOff') : t('call.cameraOn')}>{v.camera ? '🎥' : '📷'}</button>
      {!pip && <button className={`call-ctl ${v.call.transcribing ? 'is-rec' : ''}`} onClick={toggleTranscript} aria-pressed={v.call.transcribing} title={v.call.transcribing ? t('call.transcriptOff') : t('call.transcriptOn')}>📝</button>}
      <ScreenButton v={v} />
      {!pip && <button className="call-ctl" onClick={(e) => void openAudioMenu(e.currentTarget, v)} title={t('call.audioMenu')} aria-label={t('call.audioMenu')}>🔊</button>}
      {!pip && <button className="call-ctl" onClick={() => openDialog((close) => <GuestLinkDialog call={v.call} onClose={close} />)} title={t('call.guestLink')} aria-label={t('call.guestLink')}>🔗</button>}
      {!pip && <button className="btn small call-add" onClick={() => openAddToCall(v.call)} title={t('call.add')}>{t('call.addShort')}</button>}
      <span className="grow" />
      <button className="btn small call-hang" onClick={() => void hangUp()}>{t('call.hangUp')}</button>
    </div>
    {v.error && <div className="small" style={{ color: 'var(--danger)' }}>{v.error === 'no_camera' ? t('call.noCamera') : v.error}</div>}
  </>;
}

// ---------- Ventana flotante (Picture-in-Picture), como Google Meet ----------
/**
 * - Document Picture-in-Picture (Chrome/Edge 116+): una ventana siempre encima con la llamada completa (la
 *   interfaz se monta ahí con un portal, los videos siguen vivos). Chrome la abre sola al cambiar de pestaña
 *   si la página registra la acción «enterpictureinpicture» de Media Session (videollamadas).
 * - Si no existe (Safari, la app de Mac): Picture-in-Picture de un video: la pantalla compartida, el video de
 *   quien habla o, sin cámaras, un lienzo con los participantes y quién habla.
 */
function usePip(v: CallView | null, d: ClientData | null) {
  const docPip = typeof window !== 'undefined' && 'documentPictureInPicture' in window;
  // App de escritorio sin Document PiP (el WebView de Mac): modo mini nativo, siempre encima (desktop.ts).
  const miniPip = isDesktop && !docPip;
  const videoPip = !miniPip && typeof document !== 'undefined' && !!document.pictureInPictureEnabled;
  const [win, setWin] = useState<Window | null>(null);
  const [videoOpen, setVideoOpen] = useState(false);
  const [mini, setMini] = useState(false);
  const live = !!v && v.phase !== 'ended';
  const close = () => {
    if (mini) { setMini(false); void import('../desktop.ts').then((m) => m.setCallMini(false)); }
    if (win) { win.close(); setWin(null); }
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
  };
  const open = async () => {
    if (!live) return;
    if (miniPip) { setMini(true); await (await import('../desktop.ts')).setCallMini(true); return; }
    if (docPip) {
      const w: Window = await (window as any).documentPictureInPicture.requestWindow({ width: 420, height: 360 });
      // Mismos estilos que la app (hojas del documento principal).
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const css = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n');
          const st = w.document.createElement('style'); st.textContent = css; w.document.head.appendChild(st);
        } catch {
          if (sheet.href) { const l = w.document.createElement('link'); l.rel = 'stylesheet'; l.href = sheet.href; w.document.head.appendChild(l); }
        }
      }
      w.document.documentElement.className = document.documentElement.className;
      w.document.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') ?? '');
      w.document.title = 'chaggu';
      w.document.body.className = 'call-pip-body';
      w.addEventListener('pagehide', () => setWin(null));
      setWin(w);
      return;
    }
    if (videoPip) { await openVideoPip(v!, d); setVideoOpen(true); }
  };
  const toggle = async () => { try { if (win || mini || document.pictureInPictureElement) close(); else await open(); } catch (e) { console.warn('[pip]', e); } };
  // Chrome abre la ventana sola al cambiar de pestaña durante la llamada (como Meet).
  useEffect(() => {
    const ms = (navigator as any).mediaSession;
    if (!live || !docPip || !ms?.setActionHandler) return;
    try { ms.setActionHandler('enterpictureinpicture', () => void open()); } catch { /* acción no soportada */ }
    return () => { try { ms.setActionHandler('enterpictureinpicture', null); } catch { /* */ } };
  }, [live, docPip]);
  // Escritorio: al cerrar la ventana en plena llamada, desktop.ts pide el modo mini.
  useEffect(() => {
    if (!miniPip || !live) return;
    const on = () => { if (!mini) void open(); };
    addEventListener('chaggu:call-mini', on);
    return () => removeEventListener('chaggu:call-mini', on);
  }, [miniPip, live, mini]);
  // Al colgar se cierra la ventana flotante.
  useEffect(() => { if (!live) { close(); stopCanvasPip(); } }, [live]);
  useEffect(() => {
    const on = () => { setVideoOpen(false); stopCanvasPip(); };
    document.addEventListener('leavepictureinpicture', on, true);
    return () => document.removeEventListener('leavepictureinpicture', on, true);
  }, []);
  const nameOf = (id: string) => (!d ? '' : id === d.me.id ? t('call.you') : guestName(v!.call, id) || firstName(d, id, v!.call.names));
  const portal = win && v && d ? createPortal(<div className="call-pip"><CallPanel v={v} d={d} compact={false} nameOf={nameOf} pip /></div>, win.document.body) : null;
  return { supported: live && (docPip || miniPip || videoPip), open: !!win || videoOpen || mini, docOpen: !!win, mini, toggle, portal };
}

/** Picture-in-Picture de un solo video (Safari, WKWebView): la mejor imagen disponible. */
async function openVideoPip(v: CallView, d: ClientData | null) {
  const pick = (sel: string) => Array.from(document.querySelectorAll<HTMLVideoElement>(sel)).find((x) => x.readyState >= 2 && x.videoWidth > 0);
  const el = pick('.call-dock .call-screen video') ?? pick('.call-dock .call-tile:not(.is-local) video') ?? pick('.call-dock .call-tile video');
  if (el) { await el.requestPictureInPicture(); return; }
  // Nadie con cámara: un lienzo con los participantes (se actualiza solo).
  await (await canvasPip(v, d)).requestPictureInPicture();
}

let canvasTimer: ReturnType<typeof setInterval> | null = null;
let canvasVideo: HTMLVideoElement | null = null;
function stopCanvasPip() {
  if (canvasTimer) clearInterval(canvasTimer);
  canvasTimer = null;
  if (canvasVideo) { (canvasVideo.srcObject as MediaStream | null)?.getTracks().forEach((x) => x.stop()); canvasVideo.remove(); canvasVideo = null; }
}
async function canvasPip(_v: CallView, d: ClientData | null) {
  stopCanvasPip();
  const c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  const g = c.getContext('2d')!;
  const draw = () => {
    const v = currentCall();
    if (!v) return;
    const people = callPeople(v.call);
    const name = (id: string) => (d && id === d.me.id ? t('call.you') : v.call.guests?.find((x) => `guest:${x.id}` === id)?.name ?? (d ? firstName(d, id, v.call.names) : ''));
    g.fillStyle = '#151412'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#f4f1ea'; g.font = '600 22px system-ui, sans-serif'; g.fillText('chaggu', 24, 40);
    const secs = Math.max(0, Math.floor((Date.now() - Date.parse(v.call.startedAt)) / 1000));
    g.font = '18px system-ui, sans-serif'; g.fillStyle = '#b9b2a6';
    g.fillText(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}${v.muted ? '  ·  🔇' : ''}`, c.width - 130, 40);
    const n = Math.min(people.length, 6), r = 44, gap = (c.width - n * r * 2) / (n + 1);
    people.slice(0, 6).forEach((id, i) => {
      const cx = gap + r + i * (r * 2 + gap), cy = 180;
      if (v.speaking.includes(id)) { g.beginPath(); g.arc(cx, cy, r + 6, 0, Math.PI * 2); g.fillStyle = '#3fbf6a'; g.fill(); }
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#3a3632'; g.fill();
      const nm = name(id) || '·';
      g.fillStyle = '#fff'; g.font = '600 26px system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText(nm.slice(0, 1).toUpperCase(), cx, cy + 9);
      g.font = '16px system-ui, sans-serif'; g.fillStyle = '#e8e3d9'; g.fillText(nm.slice(0, 12), cx, cy + r + 28);
      g.textAlign = 'left';
    });
  };
  draw();
  canvasTimer = setInterval(draw, 500);
  const vid = document.createElement('video');
  vid.muted = true; vid.playsInline = true;
  vid.srcObject = c.captureStream(4);
  vid.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;bottom:0;left:0';
  document.body.appendChild(vid);
  await vid.play();
  canvasVideo = vid;
  return vid;
}

/** Cámara apagada y micrófono silenciado de cada persona. */
function PersonBadges({ muted, camera }: { muted: boolean; camera: boolean }) {
  if (!muted && camera) return null;
  return <span className="call-badges">
    {!camera && <span className="call-badge" title={t('call.personNoCamera')} aria-label={t('call.personNoCamera')}>📷̸</span>}
    {muted && <span className="call-badge" title={t('call.personMuted')} aria-label={t('call.personMuted')}>🔇</span>}
  </span>;
}

/** Invitados con «＋ Agregar» que aún no entran: «Llamando…» y, a los 45 s, «No contestó» con «Volver a llamar». */
function InvitedList({ call, pending }: { call: CallDTO; pending: NonNullable<CallDTO['invited']> }) {
  const d = useClient((s) => s.data)!;
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 5000); return () => clearInterval(i); }, []);
  return (
    <div className="call-invited">
      {pending.map((x) => {
        const late = Date.now() - Date.parse(x.at) > 45_000;
        return (
          <div key={x.userId} className="call-invited-row">
            <Avatar person={personById(d, x.userId)} size={24} />
            <span className="grow ellipsis small">{firstName(d, x.userId, call.names)}</span>
            <span className={`small ${late ? 'muted' : 'call-ringing-text'}`}>{late ? t('call.inviteNoAnswer') : t('call.inviteRinging')}</span>
            {late && <button className="btn ghost small" onClick={() => void client.inviteToCall(call.id, [x.userId]).catch(fail)}>{t('call.ringAgain')}</button>}
          </div>
        );
      })}
    </div>
  );
}

export const openAddToCall = (call: CallDTO) => openDialog((close) => <AddToCallDialog call={call} onClose={close} />);

/** Menú «Audio»: salida (altavoz, audífonos, Bluetooth) donde el navegador deja elegir, y micrófono. */
async function openAudioMenu(el: HTMLElement, v: CallView) {
  const r = el.getBoundingClientRect();
  const [outs, ins] = await Promise.all([listAudioOutputs().catch(() => []), listAudioInputs().catch(() => [])]);
  openMenuAt(r.left, r.top - 8, [
    { label: t('call.audioOut'), disabled: true },
    ...(outs.length ? outs.map((o) => ({ label: `${(v.audioOutput || 'default') === o.deviceId ? '✓ ' : ''}${o.label}`, onSelect: () => void chooseAudioOutput(o.deviceId).catch(fail) }))
      : [{ label: t('call.noOutputChoice'), disabled: true }]),
    { divider: true },
    { label: t('call.micIn'), disabled: true },
    ...ins.map((o) => ({ label: `${v.audioInput === o.deviceId ? '✓ ' : ''}${o.label}`, onSelect: () => void chooseAudioInput(o.deviceId).catch(fail) })),
  ]);
}

/** Nombre del dispositivo para «En llamada en tu …». */
export const deviceName = (dev: CallDeviceDTO) => {
  const k = `call.dev.${dev.platform}` as Parameters<typeof t>[0];
  const known = ['ios', 'android', 'macos', 'windows', 'web'].includes(dev.platform);
  return known ? t(k) : (dev.label.replace(/^chaggu\s+/i, '') || t('call.dev.other'));
};

/**
 * Franja fija arriba: estoy en una llamada desde otro de mis dispositivos. «Pasar aquí» entra desde este y saca
 * al otro cuando conecta; «Unirme también» entra sin sacarlo.
 */
export function OtherDeviceCallBar() {
  const d = useClient((s) => s.data);
  const calls = useClient((s) => s.calls);
  const v = useCallView();
  const mine = client.deviceKey;
  if (!d) return null;
  const call = Object.values(calls).find((c): c is CallDTO => !!c && !c.endedAt && !!c.myDevices?.some((x) => x.deviceKey !== mine));
  if (!call || v?.call.id === call.id) return null;
  const other = call.myDevices!.find((x) => x.deviceKey !== mine)!;
  const conv = d.conversations.find((c) => c.id === call.conversationId);
  const chat = conv ? conversationTitle(d, conv) : t('call.title');
  return (
    <div className="call-other-device" role="status">
      <span className="grow ellipsis">📞 {t('call.otherDevice', { device: deviceName(other), chat })}</span>
      <button className="btn accent small" onClick={() => void passHere(call.id, other.deviceKey).catch(fail)}>{t('call.passHere')}</button>
      <button className="btn small" onClick={() => void joinCall(call.id, false).catch(fail)}>{t('call.joinToo')}</button>
      <button className="btn ghost small" onClick={() => openAddToCall(call)}>{t('call.addShort')}</button>
    </div>
  );
}

/** Punto verde 📞 junto a una conversación con llamada en curso (lista lateral). */
export function CallDot({ conversationId }: { conversationId: string }) {
  const live = useClient((s) => !!s.calls[conversationId] && !s.calls[conversationId]!.endedAt && s.calls[conversationId]!.activeUserIds.length > 0);
  return live ? <span className="call-live-dot" title={t('call.inCallDot')} aria-label={t('call.inCallDot')}>📞</span> : null;
}

/** «En curso ahora» (pestaña Llamadas): quién está, Unirse y ＋ Agregar. */
function LiveNow() {
  const d = useClient((s) => s.data)!;
  const calls = useClient((s) => s.calls);
  const v = useCallView();
  const [list, setList] = useState<ActiveCallDTO[]>([]);
  // Solo cuando empieza o termina alguna llamada (no en cada cambio de quién está).
  const key = Object.values(calls).map((c) => c?.id ?? '').sort().join(',');
  useEffect(() => { client.loadActiveCalls().then(setList).catch(() => {}); }, [key]);
  // Lo que llega en vivo (call.updated) manda sobre la lista pedida.
  const live = list.map((x) => ({ ...x, call: calls[x.call.conversationId]?.id === x.call.id ? calls[x.call.conversationId]! : x.call })).filter((x) => !x.call.endedAt && calls[x.call.conversationId] !== null);
  if (!live.length) return null;
  return (
    <section className="calls-live">
      <div className="eyebrow">{t('calls.liveNow')}</div>
      {live.map(({ call, title }) => {
        const conv = d.conversations.find((c) => c.id === call.conversationId);
        const inside = v?.call.id === call.id;
        return (
          <div key={call.id} className="call-row is-live">
            <span className="stack" style={{ width: 22 + Math.max(0, Math.min(call.activeUserIds.length, 4) - 1) * 14, height: 30 }}>
              {call.activeUserIds.slice(0, 4).map((id, k) => <span key={id} style={{ left: k * 14, zIndex: 4 - k }}><Avatar person={personById(d, id)} size={30} /></span>)}
            </span>
            <button className="grow call-row-main" onClick={() => navigate(`/c/${call.conversationId}`)}>
              <strong className="ellipsis">{conv ? conversationTitle(d, conv) : title ?? t('call.title')}</strong>
              <div className="small muted ellipsis">{call.kind === 'video' ? '🎥' : '📞'} {call.activeUserIds.map((id) => firstName(d, id, call.names)).join(', ')}</div>
            </button>
            <button className="btn ghost small" onClick={() => openAddToCall(call)}>{t('call.addShort')}</button>
            {!inside && <button className="btn accent small" onClick={() => void joinCall(call.id, false).catch(fail)}>{t('call.join')}</button>}
          </div>
        );
      })}
    </section>
  );
}

/** Sumar personas a la llamada en curso: solo gente con la que comparto empresa o espacio (mi lista). */
function AddToCallDialog({ call, onClose }: { call: CallDTO; onClose: () => void }) {
  const d = useClient((s) => s.data);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  if (!d) return null;
  const inside = new Set([...call.activeUserIds, ...(call.invitedUserIds ?? []), d.me.id]);
  const needle = q.trim().toLocaleLowerCase();
  const list = d.people.filter((p) => !inside.has(p.id) && p.kind !== 'agent' && (!needle || p.name.toLocaleLowerCase().includes(needle))).slice(0, 80);
  const toggle = (id: string) => setPicked((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const send = () => {
    setBusy(true);
    client.inviteToCall(call.id, [...picked]).then(() => { toast(t('call.added', { n: picked.size })); onClose(); }, (e) => { setBusy(false); fail(e); });
  };
  return (
    <Modal title={t('call.add')} onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>{t('call.addHint')}</p>
      <input className="input" autoFocus placeholder={t('calls.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="call-pick">
        {list.map((p) => (
          <label key={p.id} className="call-pick-row">
            <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
            <Avatar person={p} size={30} />
            <span className="grow ellipsis">{p.name}</span>
          </label>
        ))}
        {list.length === 0 && <div className="hint">{t('call.addNone')}</div>}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn accent" disabled={!picked.size || busy} onClick={send}>📞 {t('call.addSend', { n: picked.size })}</button>
      </div>
    </Modal>
  );
}

/** Antes de prender la transcripción: todos en la llamada lo verán, y opcionalmente el resumen con IA. */
function TranscriptConsent({ onClose, onConfirm }: { onClose: () => void; onConfirm: (aiSummary: boolean) => void }) {
  const [ai, setAi] = useState(false);
  return (
    <Modal title={t('call.transcriptOn')} onClose={onClose}>
      <p>{t('call.consentBody')}</p>
      <label className="check"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /> {t('call.consentAi')}</label>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn accent" onClick={() => onConfirm(ai)}>{t('call.transcriptStart')}</button>
      </div>
    </Modal>
  );
}

// ---------- Detalle: resumen, transcripción y compartir ----------
export function openTranscript(callId: string) {
  openDialog((close) => <CallDetailDialog callId={callId} onClose={close} />);
}

const stamp = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function asText(data: CallTranscriptDTO, what: ShareWhat) {
  const parts: string[] = [];
  if (what !== 'transcript' && data.summary) parts.push(`${t('call.summary')}:\n${data.summary}`);
  if (what !== 'summary' && data.segments.length) parts.push(`${t('call.transcriptTitle')}:\n${data.segments.map((s) => `[${stamp(s.startMs)}] ${s.speakerName ?? '?'}: ${s.text}`).join('\n')}`);
  return parts.join('\n\n');
}
type ShareWhat = 'summary' | 'transcript' | 'both';

function CallDetailDialog({ callId, onClose }: { callId: string; onClose: () => void }) {
  const [data, setData] = useState<CallTranscriptDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'summary' | 'transcript'>('transcript');
  const d = useClient((s) => s.data);
  useEffect(() => {
    client.callTranscript(callId).then((x) => { setData(x); if (x.summary) setTab('summary'); }, (e) => setErr(errorText(e)));
  }, [callId]);
  const conv = data && d ? d.conversations.find((c) => c.id === data.call.conversationId) : null;
  const options = (x: CallTranscriptDTO): ShareWhat[] => [
    ...(x.summary ? ['summary' as const] : []), ...(x.segments.length ? ['transcript' as const] : []), ...(x.summary && x.segments.length ? ['both' as const] : []),
  ];
  const whatLabel = (w: ShareWhat) => t(w === 'summary' ? 'calls.shareSummary' : w === 'transcript' ? 'calls.shareTranscript' : 'calls.shareBoth');
  const openShare = (anchor: HTMLElement) => {
    if (!data) return;
    const opts = options(data);
    if (!opts.length) { toast(t('calls.noContent')); return; }
    const r = anchor.getBoundingClientRect();
    const byWhat = (w: ShareWhat): MenuItem[] => [
      { label: t('calls.shareChat'), icon: '💬', onSelect: () => openDialog((close) => <PickConversationDialog title={t('calls.pickChat')} onClose={close} onPick={(c) => {
          close();
          client.shareCall(callId, c.id, w).then(() => toast(t('calls.shared', { name: d ? conversationTitle(d, c) : '' }), { label: t('rem.open'), run: () => navigate(`/c/${c.id}`) }), fail);
        }} />) },
      ...(typeof navigator.share === 'function' ? [{ label: t('calls.shareSystem'), icon: '↗', onSelect: () => void navigator.share({ title: t('call.transcriptTitle'), text: asText(data, w) }).catch(() => {}) }] : []),
      { label: t('call.copy'), icon: '⧉', onSelect: () => void navigator.clipboard.writeText(asText(data, w)).then(() => toast(t('call.copied'))) },
      { label: t('call.download'), icon: '⭳', onSelect: () => download(asText(data, w), `llamada-${data.call.startedAt.slice(0, 10)}.txt`) },
    ];
    openMenuAt(Math.max(8, r.right - 260), r.bottom + 4, opts.length === 1 ? byWhat(opts[0]!) : [
      { label: t('calls.shareWhat'), disabled: true },
      ...opts.map((w) => ({ label: whatLabel(w), icon: w === 'summary' ? '✦' : w === 'transcript' ? '📝' : '📋', items: byWhat(w) })),
    ]);
  };
  return (
    <Modal title={t('call.transcriptTitle')} onClose={onClose}>
      {err && <div className="hint">{err}</div>}
      {!data && !err && <div className="hint">{t('common.loading')}</div>}
      {data && <>
        <div className="row" style={{ gap: 8 }}>
          <div className="grow small muted ellipsis">
            {data.call.kind === 'video' ? '🎥' : '📞'} {conv && d ? conversationTitle(d, conv) : ''} · {new Date(data.call.startedAt).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })}
            {data.call.transcribing ? ` · ${t('call.transcribingShort')}` : ''}
          </div>
          <button className="btn small" onClick={(e) => openShare(e.currentTarget)}>↗ {t('calls.share')}</button>
        </div>
        <div className="home-tabs" role="tablist" style={{ padding: '10px 0 0' }}>
          <button role="tab" aria-selected={tab === 'summary'} className={`home-tab ${tab === 'summary' ? 'on' : ''}`} onClick={() => setTab('summary')}>✦ {t('call.summary')}</button>
          <button role="tab" aria-selected={tab === 'transcript'} className={`home-tab ${tab === 'transcript' ? 'on' : ''}`} onClick={() => setTab('transcript')}>📝 {t('calls.shareTranscript')}</button>
        </div>
        {tab === 'summary' && (data.summary
          ? <div className="call-summary" style={{ whiteSpace: 'pre-wrap' }}>{data.summary}</div>
          : <div className="hint" style={{ margin: '12px 0' }}>{t('calls.noSummary')}</div>)}
        {tab === 'transcript' && <div className="call-transcript">
          {data.segments.length === 0 && <div className="hint">{t('call.transcriptEmpty')}</div>}
          {data.segments.map((s) => (
            <p key={s.resultId}><span className="small muted">{stamp(s.startMs)}</span> <b>{s.speakerUserId && d ? personById(d, s.speakerUserId)?.name ?? s.speakerName : s.speakerName ?? '?'}:</b> {s.text}</p>
          ))}
        </div>}
      </>}
    </Modal>
  );
}

function download(text: string, name: string) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Elegir una conversación donde puedo escribir (para llamar o para compartir). */
function PickConversationDialog({ title, onClose, onPick }: { title: string; onClose: () => void; onPick: (c: ConversationDTO) => void }) {
  const d = useClient((s) => s.data);
  const [q, setQ] = useState('');
  if (!d) return null;
  const needle = q.trim().toLocaleLowerCase();
  const list = d.conversations
    .filter((c) => c.canPost)
    .map((c) => ({ c, name: conversationTitle(d, c) }))
    .filter((x) => !needle || x.name.toLocaleLowerCase().includes(needle))
    .slice(0, 60);
  return (
    <Modal title={title} onClose={onClose}>
      <input className="input" autoFocus placeholder={t('calls.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="call-pick">
        {list.map(({ c, name }) => {
          const other = c.kind === 'direct' ? personById(d, directOtherId(d, c)) : null;
          return (
            <button key={c.id} className="call-pick-row" onClick={() => onPick(c)}>
              {other ? <Avatar person={other} size={30} /> : <ConvAvatar c={c} size={30} fallback={<span className="call-pick-hash">#</span>} />}
              <span className="grow ellipsis">{name}</span>
              <span className="small muted">{c.kind === 'direct' ? t('calls.direct') : `${t('calls.group')} · ${c.memberIds.length}`}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

// ---------- Pestaña «Llamadas» ----------
export function CallsScreen() {
  const d = useClient((s) => s.data);
  const on = d?.features?.calls === true;
  const [items, setItems] = useState<CallHistoryItemDTO[] | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Recarga al cambiar alguna llamada en vivo (empezó, terminó, hay transcripción).
  const rev = useClient((s) => Object.values(s.calls).map((c) => `${c?.id ?? ''}:${c?.hasTranscript ? 1 : 0}`).sort().join(','));
  // Abrir Llamadas quita el número rojo de perdidas (también si llega una perdida con la pestaña abierta).
  const missedNow = useClient((s) => s.data?.missedCalls ?? 0);
  useEffect(() => { if (on && missedNow > 0) void client.markCallsSeen(); }, [on, missedNow]);
  useEffect(() => {
    if (!on) return;
    client.callHistory().then((r) => { setItems(r.calls); setMore(r.hasMore); }, (e) => setErr(errorText(e)));
  }, [on, rev, missedNow]);
  const loadMore = () => {
    const last = items?.at(-1);
    if (last) client.callHistory(last.call.startedAt).then((r) => { setItems([...(items ?? []), ...r.calls]); setMore(r.hasMore); }, fail);
  };
  const newCall = (kind: 'audio' | 'video') => openDialog((close) => <PickConversationDialog title={t('calls.pick')} onClose={close} onPick={(c) => { close(); void startCall(c.id, kind).catch(fail); }} />);
  if (!d) return null;
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <div className="row page-head">
        <h1 className="grow">{t('calls.title')}</h1>
        {on && <>
          <button className="btn small" onClick={() => newCall('video')}>🎥</button>
          <button className="btn accent small" onClick={() => newCall('audio')}>📞 {t('calls.new')}</button>
        </>}
      </div>
      {!on && <div className="hint">{t('err.calls_disabled')}</div>}
      {err && <div className="hint">{err}</div>}
      {on && <LiveNow />}
      {on && items && items.length === 0 && <div className="hint">{t('calls.empty')}</div>}
      <div className="call-list">
        {(items ?? []).map((x) => <CallRow key={x.call.id} item={x} />)}
      </div>
      {more && <button className="btn ghost" onClick={loadMore}>{t('calls.more')}</button>}
    </div></div>
  );
}

function CallRow({ item }: { item: CallHistoryItemDTO }) {
  const d = useClient((s) => s.data)!;
  const c = item.call;
  const conv = d.conversations.find((x) => x.id === c.conversationId);
  const others = item.participantIds.filter((id) => id !== d.me.id);
  const group = conv ? conv.kind !== 'direct' : others.length > 1;
  const name = conv ? conversationTitle(d, conv) : others.map((id) => personById(d, id)?.name ?? '').join(', ');
  // Perdida para mí (me sonó y no entré) en rojo; «Sin respuesta» si nadie más entró.
  const mine = !!item.missed;
  const missed = mine || (!!c.endedAt && item.participantIds.length < 2);
  const live = !c.endedAt;
  const dur = item.durationSec != null ? `${Math.floor(item.durationSec / 60)}:${String(item.durationSec % 60).padStart(2, '0')}` : null;
  const who = group ? others.slice(0, 3).map((id) => personById(d, id)?.name.split(' ')[0]).filter(Boolean).join(', ') : '';
  const lead = !group && others[0] ? <Avatar person={personById(d, others[0])} size={38} /> : conv ? <ConvAvatar c={conv} size={38} fallback={<span className="call-pick-hash">#</span>} /> : <span className="call-pick-hash">☏</span>;
  return (
    <div className="call-row">
      {lead}
      <button className="grow call-row-main" onClick={() => (c.hasTranscript || item.hasSummary ? openTranscript(c.id) : navigate(`/c/${c.conversationId}`))}>
        <div className="row" style={{ gap: 6 }}>
          <strong className="ellipsis">{name || t('call.title')}</strong>
          <span className="call-tag">{group ? t('calls.group') : t('calls.direct')}</span>
          {live && <span className="call-tag is-live">{t('calls.live')}</span>}
          {mine && <span className="call-tag is-missed">{t('calls.missedMine')}</span>}
        </div>
        <div className="small muted ellipsis">
          {c.kind === 'video' ? '🎥' : '📞'} {new Date(c.startedAt).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })}
          {dur && !missed ? ` · ${dur}` : ''}{missed && !mine ? ` · ${t('calls.missed')}` : ''}{who ? ` · ${who}` : ''}
        </div>
        {(item.hasSummary || c.hasTranscript) && <div className="row" style={{ gap: 6, marginTop: 4 }}>
          {item.hasSummary && <span className="call-chip">✦ {t('call.summary')}</span>}
          {c.hasTranscript && <span className="call-chip">📝 {t('calls.shareTranscript')}</span>}
        </div>}
      </button>
      {live
        ? <button className="btn accent small" onClick={() => void joinCall(c.id, false).catch(fail)}>{t('call.join')}</button>
        : <button className="icon-btn" title={t('calls.callBack')} aria-label={t('calls.callBack')} onClick={() => void startCall(c.conversationId, c.kind).catch(fail)}>{c.kind === 'video' ? '🎥' : '📞'}</button>}
    </div>
  );
}

export type { CallView };
