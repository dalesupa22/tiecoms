import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { AttachmentDTO } from '@tiecoms/contracts';
import { MAX_VOICE_MS } from '@tiecoms/contracts';
import { client } from '../app-client.ts';
import { errorText, t, voiceDuration } from '../i18n.ts';
import { copyText, toast } from '../menu.tsx';
import { blobUrl } from './Attachments.tsx';

// ---------- Grabar ----------
const MIME = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
const pickMime = () => (typeof MediaRecorder !== 'undefined' ? MIME.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '' : '');
const BARS = 48;

/** Reduce una serie de niveles a `n` barras normalizadas (0–1). */
export function downsample(levels: number[], n = BARS): number[] {
  if (!levels.length) return [];
  const out: number[] = [];
  const per = levels.length / n;
  for (let i = 0; i < n; i++) {
    const slice = levels.slice(Math.floor(i * per), Math.max(Math.floor(i * per) + 1, Math.floor((i + 1) * per)));
    out.push(slice.length ? Math.max(...slice) : 0);
  }
  const max = Math.max(...out, 1e-6);
  return out.map((v) => Math.round((v / max) * 100) / 100);
}

interface Rec { recorder: MediaRecorder; stream: MediaStream; ctx: AudioContext; chunks: Blob[]; levels: number[]; start: number; timer: number }

/**
 * Micrófono del compositor: mantener pulsado graba, soltar envía, deslizar a la izquierda cancela y
 * deslizar arriba bloquea (manos libres con Enviar / Descartar). Onda en vivo y contador; máximo 15 min.
 */
export function VoiceRecorder({ conversationId, onSent }: { conversationId: string; onSent?: () => void }) {
  const rec = useRef<Rec | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const [state, setState] = useState<'idle' | 'holding' | 'locked' | 'sending'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState<number[]>([]);
  const [cancelHint, setCancelHint] = useState(false);

  useEffect(() => () => { void stop(true); }, []);

  async function start() {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) { toast(t('voice.micUnavailable')); return false; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch { toast(t('voice.micDenied')); return false; }
    const mime = pickMime();
    const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32_000 });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const r: Rec = { recorder, stream, ctx, chunks: [], levels: [], start: Date.now(), timer: 0 };
    recorder.ondataavailable = (e) => { if (e.data.size) r.chunks.push(e.data); };
    r.timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
      r.levels.push(Math.sqrt(sum / data.length));
      setLive(r.levels.slice(-32));
      const ms = Date.now() - r.start;
      setElapsed(ms);
      if (ms >= MAX_VOICE_MS) { toast(t('voice.tooLong')); void finish(); }
    }, 100);
    recorder.start(250);
    rec.current = r;
    navigator.vibrate?.(15);
    return true;
  }

  function stop(discard: boolean): Promise<{ blob: Blob; durationMs: number; waveform: number[] } | null> {
    const r = rec.current;
    rec.current = null;
    if (!r) return Promise.resolve(null);
    clearInterval(r.timer);
    return new Promise((resolve) => {
      r.recorder.onstop = () => {
        r.stream.getTracks().forEach((tr) => tr.stop());
        void r.ctx.close().catch(() => {});
        const durationMs = Date.now() - r.start;
        if (discard) return resolve(null);
        resolve({ blob: new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' }), durationMs, waveform: downsample(r.levels) });
      };
      if (r.recorder.state !== 'inactive') r.recorder.stop(); else r.recorder.onstop?.(new Event('stop'));
    });
  }

  async function finish() {
    const out = await stop(false);
    setLive([]); setElapsed(0); setCancelHint(false);
    if (!out) { setState('idle'); return; }
    if (out.durationMs < 700) { setState('idle'); toast(t('voice.tooShort')); return; }
    navigator.vibrate?.(10);
    setState('sending');
    try {
      const ext = out.blob.type.includes('mp4') ? 'm4a' : out.blob.type.includes('ogg') ? 'ogg' : 'webm';
      const att = await client.uploadAttachment(conversationId, out.blob, `nota-de-voz.${ext}`, { durationMs: out.durationMs, waveform: out.waveform });
      await client.send(conversationId, '', null, null, { attachments: [att] });
      onSent?.();
    } catch (e) { toast(errorText(e)); } finally { setState('idle'); }
  }
  async function cancel() { await stop(true); setState('idle'); setLive([]); setElapsed(0); setCancelHint(false); toast(t('voice.cancelled')); }

  const onDown = async (e: RPointerEvent) => {
    if (state !== 'idle') return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    origin.current = { x: e.clientX, y: e.clientY };
    setState('holding');
    if (!(await start())) setState('idle');
  };
  const onMove = (e: RPointerEvent) => {
    if (state !== 'holding') return;
    const dx = e.clientX - origin.current.x, dy = e.clientY - origin.current.y;
    setCancelHint(dx < -40);
    if (dx < -90) void cancel();
    else if (dy < -60) { setState('locked'); navigator.vibrate?.(10); }
  };
  const onUp = () => { if (state === 'holding') void finish(); };

  if (state === 'locked' || state === 'holding') {
    return (
      <div className={`voice-rec ${cancelHint ? 'is-cancel' : ''}`} role="status" aria-live="polite">
        <span className="voice-dot" aria-hidden />
        <span className="voice-time">{voiceDuration(elapsed)}</span>
        <span className="voice-live" aria-hidden>{live.map((v, i) => <i key={i} style={{ height: `${Math.max(8, Math.min(100, v * 300))}%` }} />)}</span>
        {state === 'holding'
          ? <span className="small muted voice-hint">{t('voice.slideCancel')} · {t('voice.slideLock')}</span>
          : <>
            <button className="btn ghost small" onClick={() => void cancel()}>{t('voice.discard')}</button>
            <button className="send" aria-label={t('voice.send')} onClick={() => void finish()}>➤</button>
          </>}
        {state === 'holding' && <button className="send is-rec" aria-label={t('voice.recording')} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => void cancel()}>🎤</button>}
      </div>
    );
  }
  return (
    <button className="send mic" disabled={state === 'sending'} title={t('voice.hold')} aria-label={t('voice.hold')}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onContextMenu={(e) => e.preventDefault()}>
      {state === 'sending' ? '…' : '🎤'}
    </button>
  );
}

// ---------- Reproducir ----------
const HEARD_KEY = 'tiecoms:heard';
function heard(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(HEARD_KEY) ?? '[]')); } catch { return new Set(); } }
function markHeard(id: string) { try { const s = heard(); s.add(id); localStorage.setItem(HEARD_KEY, JSON.stringify([...s].slice(-2000))); } catch { /* sin almacenamiento */ } }
const SPEEDS = [1, 1.5, 2];

/** Burbuja de voz: play/pausa, onda con progreso, duración, velocidad, transcripción, resumen y asunto sugerido. */
export function VoiceNote({ a, onCreateIssue }: { a: AttachmentDTO; onCreateIssue?: (title: string) => void }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [open, setOpen] = useState(false);
  const [wasHeard, setWasHeard] = useState(() => heard().has(a.id));
  const [busy, setBusy] = useState(false);
  const dur = a.durationMs ?? 0;
  const wave = a.waveform?.length ? a.waveform : Array.from({ length: 32 }, (_, i) => 0.3 + 0.25 * Math.abs(Math.sin(i * 1.7)));
  const tr = a.transcript;

  useEffect(() => {
    const el = root.current;
    const h = () => void toggle(true);
    el?.addEventListener('voice:play', h);
    return () => { el?.removeEventListener('voice:play', h); audio.current?.pause(); };
  }, []);

  async function toggle(forcePlay = false) {
    if (playing && !forcePlay) { audio.current?.pause(); return; }
    try {
      if (!audio.current) {
        const el = new Audio(await blobUrl(a.url));
        el.ontimeupdate = () => setPos(el.currentTime * 1000);
        el.onplay = () => setPlaying(true);
        el.onpause = () => setPlaying(false);
        el.onended = () => {
          setPlaying(false); setPos(0);
          // Reproducción continua: sigue con la siguiente nota de voz de la conversación.
          const all = [...document.querySelectorAll<HTMLElement>('.voice-note')];
          const next = all[all.indexOf(root.current!) + 1];
          next?.dispatchEvent(new Event('voice:play'));
        };
        audio.current = el;
      }
      document.querySelectorAll<HTMLElement>('.voice-note.is-playing').forEach((n) => { if (n !== root.current) n.dispatchEvent(new Event('voice:pause')); });
      audio.current.playbackRate = speed;
      await audio.current.play();
      if (!wasHeard) { markHeard(a.id); setWasHeard(true); }
    } catch (e) { toast(errorText(e) || t('att.unavailable')); }
  }
  useEffect(() => {
    const el = root.current;
    const h = () => audio.current?.pause();
    el?.addEventListener('voice:pause', h);
    return () => el?.removeEventListener('voice:pause', h);
  }, []);
  const seek = (fraction: number) => {
    if (!audio.current || !dur) return;
    audio.current.currentTime = (fraction * dur) / 1000;
    setPos(fraction * dur);
  };
  const nextSpeed = () => { const s = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!; setSpeed(s); if (audio.current) audio.current.playbackRate = s; };
  const progress = dur ? Math.min(1, pos / dur) : 0;
  async function retry() {
    setBusy(true);
    try { await client.retryTranscription(a.id); } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  }

  return (
    <div ref={root} className={`voice-note ${playing ? 'is-playing' : ''} ${wasHeard ? '' : 'is-unheard'}`}>
      <div className="voice-row">
        <button className="voice-play" onClick={() => void toggle()} aria-label={playing ? t('voice.pause') : t('voice.play')}>{playing ? '❚❚' : '▶'}</button>
        <div className="voice-wave" role="slider" aria-label={t('voice.note')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} tabIndex={0}
          onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); seek((e.clientX - r.left) / r.width); }}
          onKeyDown={(e) => { if (e.key === 'ArrowRight') seek(Math.min(1, progress + 0.05)); if (e.key === 'ArrowLeft') seek(Math.max(0, progress - 0.05)); }}>
          {wave.map((v, i) => <i key={i} className={i / wave.length <= progress ? 'on' : ''} style={{ height: `${Math.max(12, v * 100)}%` }} />)}
        </div>
        <span className="voice-time">{voiceDuration(playing || pos ? pos : dur)}</span>
        <button className="voice-speed" onClick={nextSpeed} aria-label={t('voice.speed')}>{speed}×</button>
        {!wasHeard && <span className="voice-unheard" title={t('voice.unheard')} aria-label={t('voice.unheard')} />}
      </div>
      {tr?.status === 'pending' && <div className="small muted">{t('voice.transcribing')}</div>}
      {tr?.status === 'failed' && <div className="small"><span className="error">{t('voice.failed')}</span> · <button className="link-btn" disabled={busy} onClick={() => void retry()}>{t('voice.retry')}</button></div>}
      {tr?.status === 'done' && (
        <>
          {tr.summary && <div className="voice-summary small"><b>{t('voice.summary')}:</b> {tr.summary}</div>}
          {tr.text && <button className="link-btn small" onClick={() => setOpen(!open)}>{open ? t('voice.hideTranscript') : t('voice.showTranscript')}</button>}
          {open && tr.text && (
            <div className="voice-transcript">
              <p>{tr.text}</p>
              <button className="btn ghost small" onClick={async () => { await copyText(tr.text!); toast(t('voice.copied')); }}>{t('voice.copy')}</button>
            </div>
          )}
          {tr.suggestedIssue && onCreateIssue && <button className="msg-issue" onClick={() => onCreateIssue(tr.suggestedIssue!)}>◆ {t('voice.createIssue', { title: tr.suggestedIssue })}</button>}
        </>
      )}
    </div>
  );
}
