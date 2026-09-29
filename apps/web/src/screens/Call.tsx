/**
 * Llamadas en la web: botones del encabezado, franja «llamada en curso», aviso de llamada entrante,
 * panel flotante de la llamada (con subtítulos y el interruptor de transcripción) y la transcripción guardada.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CallDTO, CallHistoryItemDTO, CallTranscriptDTO, ConversationDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { bindTile, currentCall, hangUp, joinCall, setTranscription, startCall, subscribeCall, toggleCamera, toggleMute, type CallView } from '../call.ts';
import { errorText, locale, t } from '../i18n.ts';
import { openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { navigate } from '../router.ts';
import { openDialog } from '../actions.tsx';
import { Avatar, ConvAvatar, Modal, conversationTitle, personById } from '../ui.tsx';

const useCallView = () => useSyncExternalStore((l) => subscribeCall(() => l()), currentCall);
const firstName = (d: ReturnType<typeof client.getState>['data'], id: string | null) => (id && personById(d!, id)?.name.split(' ')[0]) || '';
const fail = (e: unknown) => toast(errorText(e));

/** 📞 y 🎥 del encabezado (solo con las llamadas prendidas en el servidor y si puedo escribir). */
export function CallButtons({ conv }: { conv: ConversationDTO }) {
  const on = useClient((s) => s.data?.features?.calls === true);
  const active = useClient((s) => s.calls[conv.id]);
  useEffect(() => { if (on && active === undefined) void client.loadCall(conv.id).catch(() => {}); }, [on, conv.id, active]);
  if (!on || !conv.canPost) return null;
  return <>
    <button className="icon-btn" aria-label={t('call.audio')} title={t('call.audio')} onClick={() => void startCall(conv.id, 'audio').catch(fail)}>📞</button>
    <button className="icon-btn" aria-label={t('call.video')} title={t('call.video')} onClick={() => void startCall(conv.id, 'video').catch(fail)}>🎥</button>
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
  if (ringTimer) clearTimeout(ringTimer);
  // Deja de sonar a los 45 s si nadie contesta.
  ringTimer = setTimeout(dismissRing, 45_000);
}
function dismissRing() { ringing = null; ringListeners.forEach((l) => l()); }

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
      <button className="btn small" onClick={dismissRing}>{t('call.decline')}</button>
      <button className="btn small" onClick={() => answer(false)} title={t('call.answerAudio')}>📞</button>
      {r.call.kind === 'video' && <button className="btn accent small" onClick={() => answer(true)} title={t('call.answerVideo')}>🎥</button>}
      {r.call.kind !== 'video' && <button className="btn accent small" onClick={() => answer(false)}>{t('call.answer')}</button>}
    </div>
  );
}

// ---------- Panel de la llamada ----------
function Tile({ tileId, label, local }: { tileId: number; label: string; local: boolean }) {
  return (
    <div className={`call-tile ${local ? 'is-local' : ''}`}>
      <video ref={(el) => bindTile(tileId, el)} autoPlay playsInline muted={local} />
      <span className="call-tile-name">{label}</span>
    </div>
  );
}

export function CallDock() {
  const v = useCallView();
  const d = useClient((s) => s.data);
  const [min, setMin] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!v) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(v.call.startedAt)) / 1000)));
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, [v?.call.id]);
  if (!v || !d) return null;
  const conv = d.conversations.find((c) => c.id === v.call.conversationId);
  const others = v.call.activeUserIds.filter((id) => id !== d.me.id);
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const video = v.tiles.filter((x) => x.active || x.local);
  const toggleTranscript = () => {
    if (v.call.transcribing) { void setTranscription(false).catch(fail); return; }
    openDialog((close) => <TranscriptConsent onClose={close} onConfirm={(ai) => { close(); void setTranscription(true, ai).catch(fail); }} />);
  };
  return (
    <aside className={`call-dock ${min ? 'is-min' : ''}`} aria-label={t('call.title')}>
      <div className="row call-dock-head">
        <span className={`call-dot ${v.phase === 'live' ? 'is-live' : ''}`} aria-hidden />
        <button className="grow ellipsis call-dock-title" onClick={() => navigate(`/c/${v.call.conversationId}`)}>
          {conv ? (conv.name ?? others.map((id) => firstName(d, id)).join(', ')) || t('call.title') : t('call.title')}
        </button>
        <span className="small muted">{v.phase === 'connecting' ? t('call.connecting') : clock}</span>
        <button className="icon-btn" aria-label={min ? t('call.expand') : t('call.minimize')} onClick={() => setMin(!min)}>{min ? '▢' : '–'}</button>
      </div>
      {v.call.transcribing && <div className="call-rec" role="status">⏺ {t('call.transcribingAll')}</div>}
      {!min && <>
        {video.length > 0
          ? <div className={`call-grid n${Math.min(video.length, 4)}`}>{video.map((x) => <Tile key={x.tileId} tileId={x.tileId} local={x.local} label={x.local ? t('call.you') : firstName(d, x.userId)} />)}</div>
          : <div className="call-people">{v.call.activeUserIds.map((id) => (
              <div key={id} className={`call-person ${v.speaking.includes(id) ? 'is-speaking' : ''}`}>
                <Avatar person={personById(d, id)} size={44} /><span className="small ellipsis">{id === d.me.id ? t('call.you') : firstName(d, id)}</span>
              </div>))}
              {others.length === 0 && <div className="small muted">{t('call.waiting')}</div>}
            </div>}
        {v.call.transcribing && v.captions.length > 0 && (
          <div className="call-captions" aria-live="polite">
            {v.captions.slice(-3).map((c) => <div key={c.resultId} className={c.partial ? 'is-partial' : ''}><b>{c.userId === d.me.id ? t('call.you') : firstName(d, c.userId) || '·'}:</b> {c.text}</div>)}
          </div>
        )}
      </>}
      <div className="row call-controls">
        <button className={`call-ctl ${v.muted ? 'is-off' : ''}`} onClick={toggleMute} aria-pressed={v.muted} title={v.muted ? t('call.unmute') : t('call.mute')}>{v.muted ? '🔇' : '🎙️'}</button>
        <button className={`call-ctl ${v.camera ? '' : 'is-off'}`} onClick={() => void toggleCamera().catch(fail)} aria-pressed={!v.camera} title={v.camera ? t('call.cameraOff') : t('call.cameraOn')}>{v.camera ? '🎥' : '📷'}</button>
        <button className={`call-ctl ${v.call.transcribing ? 'is-rec' : ''}`} onClick={toggleTranscript} aria-pressed={v.call.transcribing} title={v.call.transcribing ? t('call.transcriptOff') : t('call.transcriptOn')}>📝</button>
        <span className="grow" />
        <button className="btn small call-hang" onClick={() => void hangUp()}>{t('call.hangUp')}</button>
      </div>
      {v.error && <div className="small" style={{ color: 'var(--danger)' }}>{v.error === 'no_camera' ? t('call.noCamera') : v.error}</div>}
    </aside>
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
          const other = c.kind === 'direct' ? personById(d, c.memberIds.find((m) => m !== d.me.id)) : null;
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
  const rev = useClient((s) => s.calls);
  useEffect(() => {
    if (!on) return;
    client.callHistory().then((r) => { setItems(r.calls); setMore(r.hasMore); }, (e) => setErr(errorText(e)));
  }, [on, rev]);
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
  const missed = !!c.endedAt && item.participantIds.length < 2;
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
        </div>
        <div className="small muted ellipsis">
          {c.kind === 'video' ? '🎥' : '📞'} {new Date(c.startedAt).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })}
          {dur && !missed ? ` · ${dur}` : ''}{missed ? ` · ${t('calls.missed')}` : ''}{who ? ` · ${who}` : ''}
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
