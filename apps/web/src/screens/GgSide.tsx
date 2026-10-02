import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { GgSideDraft, GgSideMessageDTO, GgSideSuggestion } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, t } from '../i18n.ts';
import { openMenuAt, toast } from '../menu.tsx';
import { asset } from '../router.ts';
import { Modal } from '../ui.tsx';
import { GgConsentBanner, openGgChat } from './Assistant.tsx';

/**
 * «gg de este chat» (docs/WA-BANDEJA-GG-CHAT.md, parte B del contrato). Una conversación PRIVADA de la persona con gg
 * sobre UN chat (fuente 'c:<id>' o 'wa:<acc>:<jid>'); el chat general de gg sigue aparte. gg nunca ejecuta nada:
 * los borradores caen en la caja, la tarea abre el diálogo de crear tarea ya lleno y el recordatorio el de recordar.
 */
export const convSource = (id: string) => `c:${id}`;
export const waSource = (accountId: string, jid: string) => `wa:${accountId}:${jid}`;
export type Quote = { id: string; author: string; text: string };
type Tone = 'me' | 'shorter' | 'formal' | 'more';
const isConsent = (e: unknown) => (e as { code?: string })?.code === 'ai_consent_required';

/** Lo que el chat anfitrión sabe hacer con lo que propone gg (siempre pasando por la persona). */
export interface GgHost {
  /** Pone el texto en la caja como «Borrador de gg». Nunca envía. */
  useDraft: (text: string) => void;
  task: (p: { title: string; assigneeName?: string | null; due?: string | null; messageId?: string | null }) => void;
  reminder: (p: { title: string; due?: string | null; messageId?: string | null }) => void;
  /** Abre el directo con esa persona y le deja el borrador escrito (sin enviar). */
  messagePerson?: (name: string, draft: string) => void;
}

// ---------- El número del botón (caché del servidor, sin IA) ----------
const pending = new Map<string, number>();
const pendingListeners = new Set<() => void>();
const setPending = (source: string, n: number) => { if (pending.get(source) !== n) { pending.set(source, n); pendingListeners.forEach((l) => l()); } };
export function useGgPending(source: string) {
  const n = useSyncExternalStore((l) => { pendingListeners.add(l); return () => { pendingListeners.delete(l); }; }, () => pending.get(source) ?? 0);
  const consent = useClient((s) => s.data?.me.aiConsent === true);
  useEffect(() => {
    let live = true;
    client.ggSidePending([source]).then((r) => live && setPending(source, r[source] ?? 0)).catch(() => {});
    // Al entrar al chat: si hay mensajes nuevos de otra persona, el servidor recalcula (máximo 1 vez cada 10 min).
    if (consent) client.ggSidePendingRefresh(source).then((r) => live && setPending(source, r.pending)).catch(() => {});
    return () => { live = false; };
  }, [source, consent]);
  return n;
}

/** El ícono de gg: las letras en un círculo oscuro con la chispa (el mismo en todas partes). */
export const GgMark = ({ size = 22 }: { size?: number }) => (
  <span className="gg-dot" style={{ width: size, height: size }} aria-hidden><img src={asset('/gg-mark-oscuro.svg')} alt="" width={size * 0.72} height={size * 0.72} /></span>
);

/** Botón del encabezado del chat: entre el nombre y la píldora de llamadas; con número si algo espera de ti. */
export function GgButton({ source, on, onClick }: { source: string; on: boolean; onClick: () => void }) {
  const n = useGgPending(source);
  const label = n > 0 ? t('ggs.buttonN', { n }) : t('ggs.button');
  return (
    <button className={`gg-head-btn ${on ? 'is-on' : ''}`} onClick={onClick} title={label} aria-label={label} aria-pressed={on}>
      <GgMark size={24} />
      {n > 0 && <span className="gg-head-count">{n > 9 ? '9+' : n}</span>}
    </button>
  );
}

// ---------- Panel lateral «gg de este chat» ----------
export function GgSidePanel({ source, chatName, quoted, onClearQuote, host, onClose, onJump, request }: {
  source: string; chatName: string; quoted: Quote[]; onClearQuote: (id?: string) => void; host: GgHost; onClose: () => void;
  onJump?: (messageId: string) => void;
  /** Algo que pidió el chat (p. ej. «Responder por mí» o «Resúmeme estos mensajes»): se hace al abrir. */
  request?: { key: number; kind: 'reply' | 'ask'; text?: string; ids?: string[] } | null;
}) {
  const consent = useClient((s) => s.data?.me.aiConsent === true);
  const [messages, setMessages] = useState<GgSideMessageDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [needConsent, setNeedConsent] = useState(false);
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const done = useRef<number | null>(null);

  const fail = (e: unknown) => { if (isConsent(e)) setNeedConsent(true); else toast(errorText(e)); };
  const load = useCallback(async () => {
    try {
      const th = await client.ggSide(source);
      setPending(source, th.pending);
      if (th.messages.length) { setMessages(th.messages); return; }
      setMessages([]);
      setBusy(true);
      const o = await client.ggSideOpen(source);
      setMessages([o.message]);
      setPending(source, o.message.extra?.pending?.length ?? 0);
      setNeedConsent(false);
    } catch (e) { setMessages((m) => m ?? []); fail(e); } finally { setBusy(false); }
  }, [source]);
  useEffect(() => { setMessages(null); void load(); }, [load]);
  // Al autorizar desde el banner, gg arranca solo.
  useEffect(() => { if (consent && needConsent) { setNeedConsent(false); void load(); } }, [consent]);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [messages, busy]);

  const ask = async (q: string, ids?: string[]) => {
    const body = q.trim();
    if (!body || busy) return;
    const quoteIds = ids ?? quoted.map((x) => x.id);
    const mine: GgSideMessageDTO = { id: `tmp-${Date.now()}`, role: 'user', body, quoted: ids ? null : quoted.length ? quoted : null, createdAt: new Date().toISOString() };
    setMessages((m) => [...(m ?? []), mine]);
    setText(''); onClearQuote();
    setBusy(true);
    try { const r = await client.ggSideAsk(source, body, quoteIds); setMessages((m) => [...(m ?? []), r.message]); }
    catch (e) { setMessages((m) => (m ?? []).filter((x) => x.id !== mine.id)); setText(body); fail(e); } finally { setBusy(false); }
  };
  const reply = async (tone?: Tone) => {
    if (busy) return;
    setBusy(true);
    try {
      await client.ggSideReply(source, tone, quoted.map((x) => x.id));
      onClearQuote();
      // El servidor dejó guardado el mensaje con los borradores: se vuelve a leer el hilo.
      setMessages((await client.ggSide(source)).messages);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!request || done.current === request.key || messages === null) return;
    done.current = request.key;
    if (request.kind === 'reply') void reply();
    else if (request.text) void ask(request.text, request.ids);
  }, [request, messages === null]);

  const fresh = async () => {
    try { await client.ggSideNew(source); setMessages([]); setBusy(true); const o = await client.ggSideOpen(source); setMessages([o.message]); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const lastGg = [...(messages ?? [])].reverse().find((m) => m.role === 'gg');
  const starters = (messages?.length ?? 0) <= 1;
  // Tras unos borradores, los chips de tono van junto a ellos (no se repiten abajo).
  const chips = starters || lastGg?.extra?.drafts?.length ? [] : lastGg?.extra?.followUps ?? [];
  const chip = (c: string) => (c === t('ggs.chipReply') || /^responder por m[ií]$|^reply for me$/i.test(c) ? void reply() : void ask(c));
  const submit = (e: FormEvent) => { e.preventDefault(); void ask(text); };

  return (
    <aside className="panel gg-side" aria-label={t('ggs.title')}>
      <div className="row gg-side-head">
        <GgMark size={26} />
        <span className="grow" style={{ minWidth: 0 }}>
          <b className="ellipsis" style={{ display: 'block' }}>{t('ggs.title')}</b>
          <span className="small muted ellipsis" style={{ display: 'block' }}>{chatName}</span>
        </span>
        <button className="icon-btn" aria-label={t('menu.open')} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, [
          { label: t('ggs.newSession'), icon: '＋', onSelect: () => void fresh() },
          { label: t('ggs.openGg'), icon: '↗', onSelect: () => void openGgChat() },
        ]); }}>⋯</button>
        <button className="icon-btn" aria-label={t('common.close')} onClick={onClose}>×</button>
      </div>
      <div className="gg-side-scope small">🔒 {t('ggs.scope')}</div>
      {needConsent && <div style={{ padding: '0 12px' }}><GgConsentBanner /></div>}
      <div className="gg-side-msgs" ref={box}>
        {messages === null && <div className="hint">{t('common.loading')}</div>}
        {messages?.map((m) => <GgSideBubble key={m.id} m={m} last={m === lastGg} host={host} onJump={onJump} onTone={(x) => void reply(x)} onAsk={(q, ids) => void ask(q, ids)} />)}
        {busy && <div className="gg-side-thinking small muted">✨ {t('ggs.thinking')}</div>}
      </div>
      <div className="gg-side-foot">
        <div className="gg-chips">
          {(starters ? [t('ggs.chipReply'), t('ggs.chipSummary'), t('ggs.chipMissing'), t('ggs.chipAgreed')] : chips).map((c) => (
            <button key={c} className="gg-chip" disabled={busy || needConsent} onClick={() => chip(c)}>{c}</button>
          ))}
        </div>
        {quoted.length > 0 && (
          <div className="gg-quotes">
            <span className="eyebrow">{t('ggs.quoted')}</span>
            {quoted.map((q) => (
              <span key={q.id} className="gg-quote"><b>{q.author}</b> {q.text.slice(0, 90)}<button className="icon-btn" aria-label={t('common.close')} onClick={() => onClearQuote(q.id)}>×</button></span>
            ))}
          </div>
        )}
        <form className="gg-ask" onSubmit={submit}>
          <textarea className="input" rows={2} maxLength={2000} placeholder={t('ggs.askPh')} value={text} disabled={needConsent}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(text); } }} />
          <button className="btn primary small" disabled={!text.trim() || busy || needConsent}>{t('ggs.send')}</button>
        </form>
      </div>
    </aside>
  );
}

function GgSideBubble({ m, last, host, onJump, onTone, onAsk }: { m: GgSideMessageDTO; last: boolean; host: GgHost; onJump?: (id: string) => void; onTone: (t: Tone) => void; onAsk: (q: string, ids?: string[]) => void }) {
  const x = m.extra ?? {};
  if (m.role === 'user') {
    return (
      <div className="gg-b me">
        {!!m.quoted?.length && <div className="gg-b-quoted small">{m.quoted.map((q) => <div key={q.id} className="ellipsis">❝ <b>{q.author}</b> {q.text}</div>)}</div>}
        <div>{m.body}</div>
      </div>
    );
  }
  return (
    <div className="gg-b">
      {!!m.quoted?.length && <div className="gg-b-quoted small">{m.quoted.map((q) => <div key={q.id} className="ellipsis">❝ <b>{q.author}</b> {q.text}</div>)}</div>}
      <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
      {!!x.pending?.length && (
        <div className="gg-pending">
          <span className="eyebrow">{t('ggs.pending')}</span>
          {x.pending.map((p, i) => (
            <button key={i} className="gg-pending-item" disabled={!p.messageId || !onJump} onClick={() => p.messageId && onJump?.(p.messageId)}>• {p.text}</button>
          ))}
        </div>
      )}
      {!!x.drafts?.length && <DraftCards drafts={x.drafts} host={host} />}
      {!!x.drafts?.length && last && <ToneChips onTone={onTone} />}
      {!!x.suggestions?.length && <SuggestionList list={x.suggestions} host={host} onAsk={onAsk} />}
    </div>
  );
}

/** Corta · Cálida · Con acción. Elegir pone el texto en la caja; la acción abre su diálogo ya lleno. */
function DraftCards({ drafts, host, onPicked }: { drafts: GgSideDraft[]; host: GgHost; onPicked?: () => void }) {
  return (
    <div className="gg-drafts">
      {drafts.map((d, i) => (
        <div key={i} className="gg-draft">
          <span className="eyebrow">{t(`ggs.style.${d.style}`)}</span>
          <div className="gg-draft-text">{d.text}</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="btn small primary" onClick={() => { host.useDraft(d.text); onPicked?.(); }}>{t('ggs.use')}</button>
            {d.action && (
              <button className="btn small" onClick={() => {
                if (d.action!.kind === 'task') host.task({ title: d.action!.title, assigneeName: d.action!.assigneeName, due: d.action!.due });
                else host.reminder({ title: d.action!.title, due: d.action!.due });
                onPicked?.();
              }}>{d.action.kind === 'task' ? `◆ ${t('ggs.task')}` : `⏰ ${t('ggs.reminder')}`}: {d.action.title}</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
function ToneChips({ onTone, disabled }: { onTone: (t: Tone) => void; disabled?: boolean }) {
  return (
    <div className="gg-chips">
      {(['me', 'shorter', 'formal', 'more'] as const).map((k) => <button key={k} className="gg-chip" disabled={disabled} onClick={() => onTone(k)}>{t(`ggs.tone.${k}`)}</button>)}
    </div>
  );
}

/** Ejecuta UNA sugerencia por el camino de siempre (nada sale solo). */
export function runSuggestion(s: GgSideSuggestion, host: GgHost, onAsk: (q: string, ids?: string[]) => void) {
  const p = s.params ?? {};
  const first = s.forMessageIds[0] ?? null;
  if (s.kind === 'reply') { if (s.draft) host.useDraft(s.draft); else onAsk(t('ggs.chipReply'), s.forMessageIds); }
  else if (s.kind === 'task') host.task({ title: s.title.replace(/^(crear tarea|create task)\s*:\s*/i, ''), assigneeName: p.assigneeName, due: p.due, messageId: first });
  else if (s.kind === 'reminder') host.reminder({ title: s.title.replace(/^(recordatorio|reminder)\s*:\s*/i, ''), due: p.due, messageId: first });
  else if (s.kind === 'message_person') {
    if (host.messagePerson && p.personName) host.messagePerson(p.personName, s.draft ?? '');
    else if (s.draft) host.useDraft(s.draft);
  } else onAsk(t('ggs.summaryOf'), s.forMessageIds);
}

function SuggestionList({ list, host, onAsk, onDone }: { list: GgSideSuggestion[]; host: GgHost; onAsk: (q: string, ids?: string[]) => void; onDone?: () => void }) {
  const [on, setOn] = useState<Set<string>>(() => new Set(list.slice(0, 1).map((s) => s.id)));
  const picked = list.filter((s) => on.has(s.id));
  return (
    <div className="gg-sugs">
      {list.map((s) => (
        <label key={s.id} className="gg-sug">
          <input type="checkbox" checked={on.has(s.id)} onChange={() => setOn((x) => { const n = new Set(x); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="tag">{t(`ggs.kind.${s.kind}`)}</span> <b>{s.title}</b>
            {(s.detail || s.draft) && <span className="small muted" style={{ display: 'block' }}>{s.detail ?? s.draft}</span>}
          </span>
        </label>
      ))}
      <button className="btn small primary" disabled={!picked.length} onClick={() => { picked.forEach((s) => runSuggestion(s, host, onAsk)); onDone?.(); }}>
        {picked.length > 1 ? t('ggs.doN', { n: picked.length }) : t('ggs.doOne')}
      </button>
    </div>
  );
}

// ---------- «Responder por mí» junto a la caja ----------
/** 3 borradores con chips de tono. Se cargan al tocar el botón (no solos, para no gastar IA). */
export function ReplyForMe({ source, host }: { source: string; host: GgHost }) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<GgSideDraft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [needConsent, setNeedConsent] = useState(false);
  const consent = useClient((s) => s.data?.me.aiConsent === true);
  const load = async (tone?: Tone) => {
    setBusy(true);
    try { setDrafts((await client.ggSideReply(source, tone)).drafts); setNeedConsent(false); }
    catch (e) { if (isConsent(e)) setNeedConsent(true); else toast(errorText(e)); } finally { setBusy(false); }
  };
  useEffect(() => { if (open && consent && needConsent) void load(); }, [consent]);
  return (
    <div className="gg-reply-wrap">
      {open && (
        <div className="gg-reply-pop card" role="dialog" aria-label={t('ggs.replyForMe')}>
          <div className="row"><GgMark size={20} /><b className="grow">{t('ggs.replyForMe')}</b><button className="icon-btn" aria-label={t('common.close')} onClick={() => setOpen(false)}>×</button></div>
          <div className="small muted">{t('ggs.replyHint')}</div>
          {needConsent && <GgConsentBanner />}
          {busy && <div className="small muted">✨ {t('ggs.thinking')}</div>}
          {drafts && !busy && <DraftCards drafts={drafts} host={host} onPicked={() => setOpen(false)} />}
          {drafts && <ToneChips disabled={busy} onTone={(x) => void load(x)} />}
        </div>
      )}
      <button className={`btn small gg-reply-btn ${open ? 'is-on' : ''}`} onClick={() => { const next = !open; setOpen(next); if (next && !drafts) void load(); }}>✨ {t('ggs.replyForMe')}</button>
    </div>
  );
}

// ---------- Selección múltiple: «✨ Pedir a gg (N)» ----------
export function SelectionBar({ n, onAsk, onClear }: { n: number; onAsk: () => void; onClear: () => void }) {
  if (!n) return null;
  return (
    <div className="gg-sel-bar" role="toolbar">
      <button className="btn primary small" onClick={onAsk}>{t('ggs.askN', { n })}</button>
      <button className="icon-btn" aria-label={t('ggs.clearSel')} title={t('ggs.clearSel')} onClick={onClear}>×</button>
    </div>
  );
}

/** Sugerencias VARIAS para los mensajes elegidos: casillas, «Hacer estas N» y campo libre. */
export function SuggestDialog({ source, messageIds, host, onAsk, onClose }: { source: string; messageIds: string[]; host: GgHost; onAsk: (q: string, ids: string[]) => void; onClose: () => void }) {
  const [list, setList] = useState<GgSideSuggestion[] | null>(null);
  const [needConsent, setNeedConsent] = useState(false);
  const [free, setFree] = useState('');
  const consent = useClient((s) => s.data?.me.aiConsent === true);
  const load = useCallback(() => {
    setList(null);
    client.ggSideSuggest(source, messageIds).then((r) => { setList(r.suggestions); setNeedConsent(false); })
      .catch((e) => { setList([]); if (isConsent(e)) setNeedConsent(true); else toast(errorText(e)); });
  }, [source, messageIds.join(',')]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (consent && needConsent) load(); }, [consent]);
  const ask = (q: string, ids?: string[]) => { onAsk(q, ids ?? messageIds); onClose(); };
  return (
    <Modal title={t('ggs.suggestTitle', { n: messageIds.length })} onClose={onClose}>
      {needConsent && <GgConsentBanner />}
      {list === null && <div className="small muted">✨ {t('ggs.thinking')}</div>}
      {list?.length === 0 && !needConsent && <div className="small muted">{t('ggs.noSuggestions')}</div>}
      {!!list?.length && <SuggestionList list={list} host={host} onAsk={ask} onDone={onClose} />}
      <form className="gg-ask" onSubmit={(e) => { e.preventDefault(); if (free.trim()) ask(free.trim()); }}>
        <input className="input" maxLength={2000} placeholder={t('ggs.freePh')} value={free} onChange={(e) => setFree(e.target.value)} />
        <button className="btn small" disabled={!free.trim()}>{t('ggs.send')}</button>
      </form>
    </Modal>
  );
}
