import { useEffect, useRef, useState } from 'react';
import type { AssistantActionDTO, AssistantTurnDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { asset, navigate } from '../router.ts';
import { errorText, getLang as lang, t } from '../i18n.ts';

/**
 * Asistente: burbuja pequeña abajo a la derecha en las listas (no dentro de un chat, como WhatsApp).
 * Tocar abre el panel; mantener presionado abre y escucha (se envía al soltar).
 * El historial vive solo en este dispositivo y por persona (chaggu:assistant:<userId>); el de otras cuentas se borra.
 */
interface Turn { role: 'user' | 'assistant'; content: string; actions?: AssistantActionDTO[]; suggestions?: string[]; at: number }
const KEY = 'chaggu:assistant:';
const SPEAK_KEY = 'chaggu:assistantSpeak';
const MAX_KEEP = 40;
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Bogota'; } catch { return 'America/Bogota'; } };

function load(userId: string): Turn[] {
  try {
    // Nada de otra cuenta queda en este navegador.
    for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith(KEY) && k !== KEY + userId) localStorage.removeItem(k); }
    const v = JSON.parse(localStorage.getItem(KEY + userId) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function save(userId: string, turns: Turn[]) { try { localStorage.setItem(KEY + userId, JSON.stringify(turns.slice(-MAX_KEEP))); } catch {} }

// ---------- Voz: se graba aquí (MediaRecorder) y la transcribe el servidor; funciona en Chrome, Safari, Firefox, escritorio y apps ----------
const Recognition: boolean = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
const MAX_RECORD_MS = 60_000;
function recorderType() {
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch {} }
  return '';
}
function speak(text: string) {
  try {
    const s = window.speechSynthesis; if (!s || !text) return;
    s.cancel();
    // gg se pronuncia «yiyi».
    const u = new SpeechSynthesisUtterance(text.replace(/\bgg\b/gi, 'yiyi'));
    u.lang = lang() === 'en' ? 'en-US' : 'es-CO';
    const v = s.getVoices().find((x) => x.lang.startsWith(lang() === 'en' ? 'en' : 'es'));
    if (v) u.voice = v;
    s.speak(u);
  } catch {}
}
const SEND_ALL = /^\s*(s[ií],?\s*)?(env[ií]a(los|las|lo|la)?|m[aá]nda(los|las|lo|la)?|dale|send( them| it)?)\s*[.!]?\s*$/i;

let openExternal: ((listen?: boolean) => void) | null = null;
/** Abre el asistente desde otra parte de la app. */
export const openAssistant = (listen = false) => openExternal?.(listen);

export function AssistantBubble({ hidden }: { hidden: boolean }) {
  const me = useClient((s) => s.data?.me.id);
  const [open, setOpen] = useState(false);
  const [listenOnOpen, setListenOnOpen] = useState(false);
  const press = useRef<{ timer: number; long: boolean } | null>(null);
  useEffect(() => { openExternal = (l = false) => { setListenOnOpen(l); setOpen(true); }; return () => { openExternal = null; }; }, []);
  if (!me) return null;

  const down = () => {
    press.current = { long: false, timer: window.setTimeout(() => { if (press.current) press.current.long = true; setListenOnOpen(true); setOpen(true); }, 450) };
  };
  const up = () => {
    const p = press.current; press.current = null;
    if (!p) return;
    clearTimeout(p.timer);
    if (p.long) window.dispatchEvent(new Event('chaggu:assistant-release'));
    else { setListenOnOpen(false); setOpen(true); }
  };

  return (
    <>
      {!hidden && !open && (
        <button className="ai-bubble" aria-label={t('ai.open')} title={t('ai.bubbleHint')}
          onPointerDown={down} onPointerUp={up} onPointerLeave={() => { if (press.current && !press.current.long) { clearTimeout(press.current.timer); press.current = null; } }}
          onContextMenu={(e) => e.preventDefault()}>
          <img src={asset('/gg-mark-animado.svg')} alt="" width={34} height={34} draggable={false} />
        </button>
      )}
      {open && <AssistantPanel userId={me} listenOnOpen={listenOnOpen} onClose={() => setOpen(false)} />}
    </>
  );
}

function AssistantPanel({ userId, listenOnOpen, onClose }: { userId: string; listenOnOpen: boolean; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const [turns, setTurns] = useState<Turn[]>(() => load(userId));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [speakOn, setSpeakOn] = useState(() => { try { return localStorage.getItem(SPEAK_KEY) !== '0'; } catch { return true; } });
  const rec = useRef<any>(null);
    const byVoice = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { save(userId, turns); scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }, [turns, userId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('keydown', k); try { const r = rec.current; r?.stream?.getTracks().forEach((x: MediaStreamTrack) => x.stop()); window.speechSynthesis?.cancel(); } catch {} };
  }, [onClose]);
  useEffect(() => {
    if (listenOnOpen && Recognition) void startListening(true);
    else input.current?.focus();
    const release = () => stopListening();
    window.addEventListener('chaggu:assistant-release', release);
    return () => window.removeEventListener('chaggu:assistant-release', release);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchAction = (id: string, patch: Partial<AssistantActionDTO>) =>
    setTurns((ts) => ts.map((x) => (x.actions?.some((a) => a.id === id) ? { ...x, actions: x.actions.map((a) => (a.id === id ? { ...a, ...patch } : a)) } : x)));

  const lastTurn = turns[turns.length - 1];
  const pendingAll = turns.flatMap((x) => x.actions ?? []).filter((a) => a.status === 'pending');

  async function runAction(a: AssistantActionDTO, editedText?: string) {
    if (!a.token) return;
    patchAction(a.id, { status: 'done', error: null, ...(editedText ? { text: editedText } : {}) });
    try {
      const out = await client.request<AssistantActionDTO>('/assistant/run', { method: 'POST', json: { token: a.token, ...(editedText ? { text: editedText } : {}) } });
      patchAction(a.id, { status: 'done', token: undefined, undoToken: out.undoToken, link: out.link ?? a.link });
    } catch (e: any) {
      patchAction(a.id, { status: 'failed', error: errorText(e) });
    }
  }
  async function undo(a: AssistantActionDTO) {
    if (!a.undoToken) return;
    try {
      await client.request('/assistant/run', { method: 'POST', json: { token: a.undoToken } });
      patchAction(a.id, { status: 'undone', undoToken: undefined });
    } catch (e: any) { patchAction(a.id, { error: errorText(e) }); }
  }

  /** retry: vuelve a mandar la última pregunta (sin repetirla en el historial). */
  async function ask(content: string, retry = false) {
    const q = content.trim();
    if (!q || busy) return;
    setError(null); setText(''); setInterim('');
    const voice = byVoice.current; byVoice.current = false;
    // «Envíalos» con borradores pendientes: se confirman aquí mismo, sin volver a llamar al modelo.
    if (SEND_ALL.test(q) && pendingAll.length) {
      setTurns((ts) => [...ts, { role: 'user', content: q, at: Date.now() }]);
      await Promise.all(pendingAll.map((a) => runAction(a)));
      const done = pendingAll.length === 1 ? t('ai.sentOne') : t('ai.sentAll', { n: pendingAll.length });
      setTurns((ts) => [...ts, { role: 'assistant', content: done, at: Date.now() }]);
      if (voice || speakOn) speak(done);
      return;
    }
    const next = retry ? turns : [...turns, { role: 'user' as const, content: q, at: Date.now() }];
    if (!retry) setTurns(next);
    setBusy(true);
    try {
      // El modelo recibe el texto y un resumen de lo que ya hizo o dejó pendiente (sin tokens).
      const history = next.slice(-20).map((x) => ({
        role: x.role,
        content: x.actions?.length ? `${x.content}\n[${x.actions.map((a) => `${a.status}: ${a.kind} → ${a.target}: ${a.text}`).join(' | ')}]`.slice(0, 4000) : x.content.slice(0, 4000),
      }));
      const out = await client.request<AssistantTurnDTO>('/assistant/turn', { method: 'POST', json: { messages: history, timezone: tz(), lang: lang() } });
      setTurns((ts) => [...ts, { role: 'assistant', content: out.reply, actions: out.actions, suggestions: out.suggestions ?? [], at: Date.now() }]);
      if (voice || speakOn) speak(out.reply);
    } catch (e: any) {
      setError(e?.status === 503 ? t('ai.unavailable') : errorText(e));
    } finally { setBusy(false); }
  }

  async function startListening(_fromHold = false) {
    if (!Recognition || listening || rec.current) return;
    try { window.speechSynthesis?.cancel(); } catch {}
    setError(null);
    const session: { stopAsked: boolean; rec?: MediaRecorder; stream?: MediaStream; timer?: number } = { stopAsked: false };
    rec.current = session;
    setListening(true); setInterim('');
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e: any) {
      rec.current = null; setListening(false);
      setError(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? t('ai.micDenied') : t('ai.micMissing'));
      return;
    }
    const type = recorderType();
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = async () => {
      stream.getTracks().forEach((x) => x.stop());
      clearTimeout(session.timer);
      rec.current = null; setListening(false);
      const blob = new Blob(chunks, { type: r.mimeType || type || 'audio/webm' });
      if (blob.size < 1500) { setInterim(''); return; }
      setTranscribing(true);
      try {
        const out = await client.request<{ text: string }>(`/assistant/transcribe?lang=${lang()}`, {
          method: 'POST', body: blob, headers: { 'content-type': 'application/octet-stream', 'x-file-type': blob.type },
        });
        if (out.text) { byVoice.current = true; void ask(out.text); } else setError(t('ai.heardNothing'));
      } catch (e: any) { setError(e?.status === 503 ? t('ai.voiceUnavailable') : errorText(e)); }
      finally { setTranscribing(false); }
    };
    session.rec = r; session.stream = stream;
    r.start(250);
    session.timer = window.setTimeout(() => stopListening(), MAX_RECORD_MS);
    // Se soltó la burbuja antes de que el micrófono arrancara.
    if (session.stopAsked) stopListening();
  }
  function stopListening() {
    const s = rec.current;
    if (!s) return;
    s.stopAsked = true;
    try { if (s.rec && s.rec.state !== 'inactive') s.rec.stop(); } catch {}
  }

  const toggleSpeak = () => { const v = !speakOn; setSpeakOn(v); try { localStorage.setItem(SPEAK_KEY, v ? '1' : '0'); } catch {} if (!v) window.speechSynthesis?.cancel(); };
  const clear = () => { setTurns([]); setError(null); };
  const first = d.me.name.split(' ')[0] ?? d.me.name;
  const SUGGEST: { label: string; fill?: boolean }[] = [
    { label: t('ai.s.report') }, { label: t('ai.s.pending') }, { label: t('ai.s.due') },
    { label: t('ai.s.write'), fill: true }, { label: t('ai.s.group'), fill: true }, { label: t('ai.s.meeting'), fill: true },
    { label: t('ai.s.issue'), fill: true }, { label: t('ai.s.cancel'), fill: true },
  ];

  return (
    <div className="ai-wrap" role="dialog" aria-modal="false" aria-label={t('ai.title')}>
      <div className="ai-scrim only-mobile" onClick={onClose} />
      <section className="ai-panel">
        <header className="ai-head">
          <img className="ai-mark" src={asset('/gg-mark.svg')} alt="" width={30} height={30} />
          <span className="grow ai-head-t"><b>{t('ai.title')}</b><span className="muted small">{t('ai.subtitle')}</span></span>
          <button className="ai-icon" aria-pressed={speakOn} title={speakOn ? t('ai.speakOff') : t('ai.speakOn')} aria-label={speakOn ? t('ai.speakOff') : t('ai.speakOn')} onClick={toggleSpeak}>{speakOn ? '🔊' : '🔇'}</button>
          {turns.length > 0 && <button className="ai-icon" title={t('ai.clear')} aria-label={t('ai.clear')} onClick={clear}>⟲</button>}
          <button className="ai-icon" title={t('common.close')} aria-label={t('common.close')} onClick={onClose}>✕</button>
        </header>

        <div className="ai-body" ref={scroller}>
          {turns.length === 0 && (
            <div className="ai-empty">
              <p className="ai-hello">{t('ai.hello', { name: first })}</p>
              <p className="muted small">{t('ai.intro')}</p>
              <div className="ai-chips">
                {SUGGEST.map((s) => (
                  <button key={s.label} className="ai-chip" onClick={() => {
                    if (s.fill) { setText(s.label.replace(/…$/, ' ')); input.current?.focus(); } else void ask(s.label);
                  }}>{s.label}</button>
                ))}
              </div>
              {Recognition && <p className="muted small">{t('ai.voiceHint')}</p>}
            </div>
          )}
          {turns.map((x, i) => (
            <div key={i} className={`ai-turn ${x.role}`}>
              <div className="ai-say">{x.content}</div>
              {!!x.actions?.length && <div className="ai-actions">{x.actions.map((a) => <ActionCard key={a.id} a={a} onRun={runAction} onUndo={undo} onDiscard={() => patchAction(a.id, { status: 'undone', token: undefined })} onOpen={(to) => { navigate(to); onClose(); }}
                onRedo={() => { patchAction(a.id, { status: 'undone', token: undefined }); void ask(t('ai.redoAsk', { name: a.target })); }} />)}</div>}
            </div>
          ))}
          {pendingAll.length > 1 && (
            <button className="btn primary ai-sendall" onClick={() => pendingAll.forEach((a) => void runAction(a))}>{t('ai.sendAll', { n: pendingAll.length })}</button>
          )}
          {transcribing && <div className="ai-turn user"><div className="ai-say muted">{t('ai.transcribing')}</div></div>}
          {busy && <div className="ai-turn assistant"><div className="ai-say ai-dots" aria-label={t('common.wait')}><i /><i /><i /></div></div>}
          {!busy && !transcribing && !listening && lastTurn?.role === 'assistant' && !!lastTurn.suggestions?.length && (
            <div className="ai-chips ai-next">
              {lastTurn.suggestions.map((q) => <button key={q} className="ai-chip" onClick={() => void ask(q)}>{q}</button>)}
            </div>
          )}
          {error && <div className="ai-error" role="alert">{error}
            {lastTurn?.role === 'user' && <button className="btn ai-retry" onClick={() => void ask(lastTurn.content, true)}>{t('ai.retry')}</button>}
          </div>}
        </div>

        {listening && (
          <div className="ai-listen" role="status">
            <span className="ai-wave" aria-hidden><i /><i /><i /><i /><i /></span>
            <span className="grow">{interim || t('ai.listening')}</span>
            <button className="btn" onClick={stopListening}>{t('ai.stop')}</button>
          </div>
        )}
        <form className="ai-compose" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
          <textarea ref={input} rows={1} value={text} placeholder={t('ai.placeholder')} aria-label={t('ai.placeholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(text); } }} />
          {text.trim()
            ? <button className="ai-go" type="submit" disabled={busy} aria-label={t('ai.send')}>↑</button>
            : Recognition && <button className={`ai-go ${listening ? 'on' : ''}`} type="button" aria-label={listening ? t('ai.stop') : t('ai.talk')} disabled={transcribing} onClick={() => (listening ? stopListening() : void startListening())}>🎤</button>}
        </form>
      </section>
    </div>
  );
}

const KIND_ICON: Record<AssistantActionDTO['kind'], string> = { send_message: '✉', create_group: '▦', create_issue: '◆', update_issue: '✓', create_event: '▤', cancel_event: '⊘', mark_read: '◉' };

function ActionCard({ a, onRun, onUndo, onDiscard, onOpen, onRedo }: {
  a: AssistantActionDTO; onRun: (a: AssistantActionDTO, text?: string) => void; onUndo: (a: AssistantActionDTO) => void; onDiscard: () => void; onOpen: (to: string) => void; onRedo: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.text);
  const danger = a.kind === 'cancel_event';
  const verb = a.kind === 'send_message' ? t('ai.send') : a.kind === 'create_group' ? t('ai.create') : danger ? t('ai.cancelEvent') : t('ai.confirm');
  return (
    <div className={`ai-card ${a.status} ${danger ? 'danger' : ''}`}>
      <div className="ai-card-top">
        <span className="ai-card-ico" aria-hidden>{KIND_ICON[a.kind]}</span>
        <span className="grow ellipsis"><b>{a.target}</b></span>
        {a.status === 'done' && <span className="ai-ok">{t('ai.done')}</span>}
        {a.status === 'undone' && <span className="muted small">{t('ai.undone')}</span>}
        {a.status === 'failed' && <span className="ai-bad">{t('ai.failed')}</span>}
      </div>
      {editing
        ? <textarea className="ai-edit" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus />
        : <div className={`ai-card-text ${danger ? 'strike' : ''}`}>{a.text}</div>}
      {a.detail && <div className="muted small">{a.detail}</div>}
      {a.error && <div className="ai-bad small">{a.error}</div>}
      {a.status === 'pending' && (
        <div className="ai-card-btns">
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => onRun(a, editing && draft.trim() !== a.text ? draft.trim() : undefined)}>{verb}</button>
          {a.kind === 'send_message' && !editing && <button className="btn" onClick={() => setEditing(true)}>{t('ai.edit')}</button>}
          {a.kind === 'send_message' && !editing && <button className="btn" onClick={onRedo}>{t('ai.redo')}</button>}
          <button className="btn" onClick={onDiscard}>{t('ai.discard')}</button>
        </div>
      )}
      {a.status === 'done' && (a.undoToken || a.link) && (
        <div className="ai-card-btns">
          {a.link && <button className="btn" onClick={() => onOpen(a.link!)}>{t('ai.openIt')}</button>}
          {a.undoToken && <button className="btn" onClick={() => onUndo(a)}>{t('ai.undo')}</button>}
        </div>
      )}
    </div>
  );
}
