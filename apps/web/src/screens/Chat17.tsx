/**
 * Tanda 1.7 en la web (docs/TANDA-1.7.md): #grupos en el compositor, búsqueda dentro del chat, mensajes de una
 * sola vista (burbuja cerrada y visor a pantalla completa) y las tarjetas nuevas del chat (es hoy, tarea hecha
 * con confeti, tarea vencida con carita triste y sus botones, comentarios agrupados).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { BootstrapDTO, ChatSearchResultDTO, ConversationDTO, MessageDTO, ViewOnceOpenDTO } from '@tiecoms/contracts';
import { viewOnceStateFor } from '@tiecoms/client-core';
import { apiUrl, client, useClient } from '../app-client.ts';
import { activeHashQuery, claimEffect, findMatches, parseNotice, quickDueDates, resultPosition, searchTerms, viewOnceKind, type Notice17, type RefToken } from '../chat17.ts';
import { launchConfetti, showSadFace } from '../celebrate.ts';
import { dueDateLabel, errorText, locale, t } from '../i18n.ts';
import { openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { navigate } from '../router.ts';
import { quickSearch } from '../quick-search.ts';
import { compareConversations } from '../home-order.ts';
import { Avatar, ConvAvatar, Modal, conversationTitle, orgById, personById } from '../ui.tsx';
import { EventChatCard, EventComments } from './Calendar.tsx';
import { IssueChatCard, issueFlags } from './Issues.tsx';
import { openDialog } from '../actions.tsx';

// ---------- #grupos ----------
/** Conversaciones que puedo ver para «#»: el mismo buscador de «Mensaje nuevo» (grupos y chats). */
export function refOptions(d: BootstrapDTO, query: string, exclude?: string): ConversationDTO[] {
  const names = { title: (c: ConversationDTO) => conversationTitle(d, c) };
  const q = query.trim();
  const list = q ? (() => { const r = quickSearch(d, q, names); return [...r.groups, ...r.chats]; })()
    : [...d.conversations].filter((c) => !(c.parentId && c.deriveKind !== 'side')).sort(compareConversations);
  return list.filter((c) => c.id !== exclude).slice(0, 8);
}

/** Lista de «#» sobre el compositor (↑/↓/Enter/Tab/Esc), como la de menciones. */
export function useRefPicker({ text, caret, exclude, onPick }: {
  text: string; caret: number; exclude?: string; onPick: (range: { start: number; end: number }, token: RefToken) => void;
}) {
  const d = useClient((s) => s.data)!;
  const [index, setIndex] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const q = activeHashQuery(text, caret);
  const list = useMemo(() => (q ? refOptions(d, q.query, exclude) : []), [d, q?.query, q?.start, exclude]);
  const open = !!q && closedAt !== q.start && (list.length > 0 || !/\s/.test(q.query));
  useEffect(() => { setIndex(0); }, [q?.query]);
  useEffect(() => { if (!q) setClosedAt(null); }, [!!q]);
  const pick = (c: ConversationDTO) => { if (q) onPick({ start: q.start, end: caret }, { conversationId: c.id, label: conversationTitle(d, c) }); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || (!list.length && e.key !== 'Escape')) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % list.length); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + list.length) % list.length); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(list[index]!); return true; }
    if (e.key === 'Escape') { e.preventDefault(); setClosedAt(q!.start); return true; }
    return false;
  };
  const view = open ? (
    <div className="mention-picker ref-picker" role="listbox" aria-label={t('ref.picker')}>
      {list.map((c, i) => (
        <button key={c.id} type="button" role="option" aria-selected={i === index} className={i === index ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(c); }}>
          {c.avatarUrl ? <ConvAvatar c={c} size={26} /> : <span className="mention-all-ico">#</span>}
          <span className="grow" style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{conversationTitle(d, c)}</b>
            <span className="small muted ellipsis" style={{ display: 'block' }}>{c.kind === 'direct' ? t('chat.aDirect') : d.workspaces.find((w) => w.id === c.workspaceId)?.name ?? ''}</span></span>
        </button>
      ))}
      {!list.length && <div className="hint" style={{ padding: 8 }}>{t('ref.noMatch')}</div>}
    </div>
  ) : null;
  return { view, onKeyDown, open };
}

/** Tocar #Nombre: abre la conversación si está en mi lista; si no, «No tienes acceso a #Nombre». */
export function openRef(d: BootstrapDTO, ref: { conversationId: string; name: string }) {
  if (d.conversations.some((c) => c.id === ref.conversationId)) navigate(`/c/${ref.conversationId}`);
  else toast(t('ref.noAccess', { name: ref.name }));
}

// ---------- Buscar dentro del chat ----------
interface SearchState { q: string; results: ChatSearchResultDTO[]; hasMore: boolean; loading: boolean; error: string | null; index: number }

/**
 * Barra de búsqueda arriba del chat: espera 250 ms mientras se escribe, «3 de 17» con ↑ ↓, salta al mensaje y
 * resalta lo que coincide (CSS Custom Highlight). En escritorio, además, la lista de resultados. Esc cierra.
 */
export function ChatSearchBar({ conv, onJump, onClose, scroller }: {
  conv: ConversationDTO; onJump: (seq: number) => void; onClose: () => void; scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const d = useClient((s) => s.data)!;
  const messages = useClient((s) => s.conversations[conv.id]?.messages);
  const [s, setS] = useState<SearchState>({ q: '', results: [], hasMore: false, loading: false, error: null, index: 0 });
  const [showList, setShowList] = useState(() => window.matchMedia?.('(min-width: 900px)').matches ?? true);
  const inputRef = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { requestAnimationFrame(() => inputRef.current?.focus()); }, []);

  const run = (q: string, before?: number) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setS((x) => ({ ...x, loading: true, error: null }));
    client.searchChat(conv.id, q, before, 30, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        setS((x) => {
          const results = before ? [...x.results, ...r.results] : r.results;
          const index = before ? x.index : 0;
          return { ...x, results, hasMore: r.hasMore, loading: false, index };
        });
        if (!before && r.results[0]) onJump(r.results[0].message.seq);
      })
      .catch((e) => { if (!ctl.signal.aborted) setS((x) => ({ ...x, loading: false, error: errorText(e) })); });
  };
  // Espera 250 ms mientras se escribe.
  useEffect(() => {
    const q = s.q.trim();
    if (q.length < 2) { abort.current?.abort(); setS((x) => ({ ...x, results: [], hasMore: false, loading: false, error: null, index: 0 })); return; }
    const h = setTimeout(() => run(q), 250);
    return () => clearTimeout(h);
  }, [s.q]);
  useEffect(() => () => abort.current?.abort(), []);

  const go = (index: number) => {
    const r = s.results[index];
    if (!r) return;
    setS((x) => ({ ...x, index }));
    onJump(r.message.seq);
    // Al llegar al último cargado, pide la página siguiente (más viejos).
    if (index >= s.results.length - 2 && s.hasMore && !s.loading) run(s.q.trim(), s.results[s.results.length - 1]!.message.seq);
  };
  const older = () => go(Math.min(s.results.length - 1, s.index + 1));
  const newer = () => go(Math.max(0, s.index - 1));
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) { e.preventDefault(); older(); }
    else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); if (e.key === 'Enter' && !s.results.length) return; e.key === 'Enter' ? older() : newer(); }
  };

  // Resaltado sobre las burbujas visibles (sin tocar el DOM de React): CSS Custom Highlight API.
  const terms = searchTerms(s.q);
  const current = s.results[s.index]?.message.id ?? null;
  useEffect(() => {
    const H = (globalThis as any).Highlight;
    const reg = (globalThis as any).CSS?.highlights;
    if (!H || !reg) return;
    const el = scroller.current;
    if (!el || terms.length < 2) { reg.delete('chat-search'); reg.delete('chat-search-current'); return; }
    const all: Range[] = [], cur: Range[] = [];
    for (const body of el.querySelectorAll<HTMLElement>('[data-mid] .msg-body')) {
      const mid = body.closest<HTMLElement>('[data-mid]')?.dataset.mid;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        for (const [start, len] of findMatches(n.textContent ?? '', terms)) {
          const r = new Range(); r.setStart(n, start); r.setEnd(n, start + len);
          (mid && mid === current ? cur : all).push(r);
        }
      }
    }
    reg.set('chat-search', new H(...all));
    reg.set('chat-search-current', new H(...cur));
  }, [terms, current, messages, s.results]);
  useEffect(() => () => { const reg = (globalThis as any).CSS?.highlights; reg?.delete('chat-search'); reg?.delete('chat-search-current'); }, []);

  const pos = resultPosition(s.index, s.results.length, s.hasMore);
  const tooShort = s.q.trim().length > 0 && s.q.trim().length < 2;
  return (
    <div className="chat-search" role="search">
      <div className="chat-search-bar">
        <span aria-hidden>🔎</span>
        <input ref={inputRef} className="input grow" value={s.q} placeholder={t('csearch.placeholder')} aria-label={t('csearch.open')}
          onChange={(e) => setS((x) => ({ ...x, q: e.target.value }))} onKeyDown={onKey} />
        <span className="chat-search-count small muted" aria-live="polite">
          {s.loading && !s.results.length ? t('csearch.loading') : tooShort ? t('csearch.min') : s.q.trim().length >= 2 ? (s.results.length ? t('csearch.of', { i: pos.i, n: pos.n }) : s.error ?? t('csearch.none')) : ''}
        </span>
        <button className="icon-btn" aria-label={t('csearch.prev')} title={t('csearch.prev')} disabled={s.index >= s.results.length - 1} onClick={older}>↑</button>
        <button className="icon-btn" aria-label={t('csearch.next')} title={t('csearch.next')} disabled={s.index <= 0} onClick={newer}>↓</button>
        {s.results.length > 0 && <button className="icon-btn only-desktop" aria-pressed={showList} aria-label="≡" onClick={() => setShowList((v) => !v)}>≡</button>}
        <button className="icon-btn" aria-label={t('csearch.close')} title={`${t('csearch.close')} (Esc)`} onClick={onClose}>×</button>
      </div>
      {showList && s.results.length > 0 && (
        <div className="chat-search-list only-desktop" role="listbox">
          {s.results.map((r, i) => {
            const author = personById(d, r.message.authorId);
            return (
              <button key={r.message.id} role="option" aria-selected={i === s.index} className={`chat-search-item ${i === s.index ? 'on' : ''}`} onClick={() => go(i)}>
                <Avatar person={author} org={orgById(d, author?.orgId)} size={24} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="row small" style={{ gap: 6 }}><b className="ellipsis grow">{author?.name ?? t('chat.formerParticipant')}</b>
                    <span className="muted">{new Date(r.message.createdAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: '2-digit' })}</span></span>
                  <span className="small chat-search-snippet">
                    {r.field === 'attachment' ? `${t('csearch.inAttachment')} · ` : r.field === 'transcript' ? `${t('csearch.inVoice')} · ` : ''}
                    <Snippet text={r.snippet} matches={r.matches} />
                  </span>
                </span>
              </button>
            );
          })}
          {s.hasMore && <button className="btn ghost small" disabled={s.loading} onClick={() => run(s.q.trim(), s.results[s.results.length - 1]!.message.seq)}>{s.loading ? t('csearch.loading') : '…'}</button>}
        </div>
      )}
    </div>
  );
}

function Snippet({ text, matches }: { text: string; matches: [number, number][] }) {
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const [start, len] of [...matches].sort((a, b) => a[0] - b[0])) {
    if (start < at || start + len > text.length) continue;
    out.push(text.slice(at, start), <mark key={start}>{text.slice(start, start + len)}</mark>);
    at = start + len;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

// ---------- Una sola vista ----------
/** Burbuja cerrada «① Foto / ① Mensaje / ① Nota de voz» con su estado; tocarla abre el visor (una vez). */
export function ViewOnceBubble({ m }: { m: MessageDTO }) {
  const d = useClient((s) => s.data)!;
  const state = viewOnceStateFor(m, d.me.id);
  const kind = viewOnceKind(m);
  const label = kind === 'photo' ? t('once.photo') : kind === 'voice' ? t('once.voice') : t('once.message');
  const seen = (m.openedBy ?? []).map((o) => personById(d, o.userId)?.name.split(' ')[0]).filter(Boolean) as string[];
  const status = state === 'sent' ? (seen.length ? t('once.seenBy', { names: seen.join(', ') }) : t('once.sent'))
    : state === 'opened' ? t('once.opened') : t('once.tapToOpen');
  const [busy, setBusy] = useState(false);
  const canOpen = state === 'unopened' && !busy;
  const open = async () => {
    if (!canOpen) return;
    setBusy(true);
    try {
      const r = await client.openViewOnce(m);
      openDialog((close) => <ViewOnceViewer m={m} content={r} onClose={close} />);
    } catch (e: any) {
      if (e?.code === 'already_opened' || e?.code === 'expired') client.markViewOnceOpened(m);
      toast(errorText(e));
    } finally { setBusy(false); }
  };
  return (
    <button type="button" className={`once-bubble is-${state}`} onClick={() => void open()} disabled={!canOpen} aria-label={`${label} · ${status}`}>
      <span className="once-ico" aria-hidden>1</span>
      <span className="grow" style={{ textAlign: 'left' }}>
        <b style={{ display: 'block' }}>{label.replace(/^①\s*/, '')}</b>
        <span className="small muted">{busy ? t('common.loading') : status}</span>
      </span>
    </button>
  );
}

/** Visor a pantalla completa: sin clic derecho ni arrastrar. Al cerrarlo el mensaje queda «Abierto». */
function ViewOnceViewer({ m, content, onClose }: { m: MessageDTO; content: ViewOnceOpenDTO; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const author = personById(d, m.authorId);
  return (
    <div className="once-viewer" role="dialog" aria-modal="true" aria-label={t('once.toggle')} onContextMenu={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()}>
      <div className="once-viewer-head">
        <span className="once-ico" aria-hidden>1</span>
        <span className="grow"><b>{author?.name}</b> · <span className="muted">{t('once.hint')}</span></span>
        <button className="icon-btn" aria-label={t('once.close')} onClick={onClose}>×</button>
      </div>
      <div className="once-viewer-body">
        {content.attachments.map((a) => a.kind === 'voice'
          ? <audio key={a.id} src={apiUrl(a.url)} controls autoPlay controlsList="nodownload noplaybackrate" />
          : a.contentType.startsWith('image/') ? <img key={a.id} src={apiUrl(a.url)} alt="" draggable={false} /> : null)}
        {content.body && <div className="once-viewer-text">{content.body}</div>}
      </div>
    </div>
  );
}

// ---------- Tarjetas nuevas del chat ----------
/** Solo lo que llega en vivo mientras el chat está a la vista: una vez por mensaje y dispositivo. */
function useLiveEffect(m: MessageDTO, live: boolean, fx: 'confetti' | 'sad', anchor: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!live || document.visibilityState !== 'visible') return;
    let store: Storage | null = null;
    try { store = localStorage; } catch {}
    if (!claimEffect(store, m.id)) return;
    const r = anchor.current?.getBoundingClientRect();
    const at = r ? { x: r.left + r.width / 2, y: r.top + Math.min(r.height, 120) / 2 } : undefined;
    if (fx === 'confetti') launchConfetti(at); else showSadFace(at);
  }, [live, m.id]);
}

export function Notice17Row({ m, p, canPost, live, onIssue }: { m: MessageDTO; p: Notice17; canPost: boolean; live: boolean; onIssue: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLiveEffect(m, live && (p.k === 'issue.done' || p.k === 'issue.overdue'), p.k === 'issue.overdue' ? 'sad' : 'confetti', ref);
  const [replying, setReplying] = useState(false);
  // «Tarea de Ana» / «Evento de Ana»: quien la creó, no quien la completó, venció o comentó.
  const issueCreator = useClient((s) => ('issueId' in p ? s.issues[p.issueId]?.createdBy : undefined)) ?? m.authorId;
  const eventCreator = useClient((s) => ('eventId' in p ? s.events[p.eventId]?.organizerId : undefined)) ?? m.authorId;
  const row = (child: React.ReactNode) => <div ref={ref} id={`msg-${m.conversationId}-${m.seq}`} data-notice={p.k} className="msg-card-row">{child}</div>;
  if (p.k === 'event.today') {
    const time = new Date(p.startsAt).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
    return row(<EventChatCard eventId={p.eventId} creatorId={eventCreator} tone="today" banner={t('today.banner', { time })} />);
  }
  if (p.k === 'issue.done') {
    return row(<IssueChatCard issueId={p.issueId} creatorId={issueCreator} canPost={canPost} onOpen={onIssue} tone="done" hideReply banner={t('done.banner', { name: p.byName })} />);
  }
  if (p.k === 'issue.overdue') {
    return row(<IssueChatCard issueId={p.issueId} creatorId={issueCreator} canPost={canPost} onOpen={onIssue} tone="overdue" hideReply
      banner={<><span className="sad-face" aria-hidden>😢</span> {t('overdue.banner', { title: p.title, date: dueDateLabel(p.dueDate) })}</>}
      footer={canPost ? <OverdueActions issueId={p.issueId} conversationId={m.conversationId} /> : null} />);
  }
  const strip = (
    <div className="comments-strip">
      <span className="grow" style={{ minWidth: 0 }}>
        <b>{p.count > 1 ? t('comments.many', { n: p.count }) : t('comments.one')}</b>
        <span className="small ellipsis" style={{ display: 'block' }}><b>{p.lastByName.split(' ')[0]}</b> {p.lastExcerpt}</span>
      </span>
      {canPost && <button className="btn small" onClick={() => setReplying((v) => !v)}>{t('comments.reply')}</button>}
    </div>
  );
  if (p.k === 'issue.comments') {
    return row(<IssueChatCard issueId={p.issueId} creatorId={issueCreator} canPost={canPost} onOpen={onIssue} tone="comments" hideReply={!replying} banner={strip} />);
  }
  return row(<EventChatCard eventId={p.eventId} creatorId={eventCreator} tone="comments" banner={strip} footer={replying ? <EventReply eventId={p.eventId} /> : null} />);
}

function EventReply({ eventId }: { eventId: string }) {
  const ev = useClient((s) => s.events[eventId]);
  if (!ev) return null;
  return <EventComments ev={ev} canPost autoFocus />;
}

/** Botones de «No cumplimos»: Nueva fecha (Hoy, Mañana, Próximo lunes, Elegir fecha), Marcar hecha y Reasignar. */
function OverdueActions({ issueId, conversationId }: { issueId: string; conversationId: string }) {
  const d = useClient((s) => s.data)!;
  const i = useClient((s) => s.issues[issueId]);
  // Ya con otra fecha (o cerrada), la tarjeta queda como registro y sin botones.
  if (!i || i.status === 'done' || i.status === 'cancelled' || !issueFlags(i).overdue) return null;
  const setDue = (dueDate: string) => client.updateIssue(issueId, { dueDate }).then(() => toast(t('overdue.moved', { date: dueDateLabel(dueDate) }))).catch((e) => toast(errorText(e)));
  const dateMenu = (el: HTMLElement) => {
    const q = quickDueDates();
    const r = el.getBoundingClientRect();
    openMenuAt(r.left, r.bottom + 4, [
      { label: `${t('overdue.today')} · ${dueDateLabel(q.today)}`, onSelect: () => void setDue(q.today) },
      { label: `${t('overdue.tomorrow')} · ${dueDateLabel(q.tomorrow)}`, onSelect: () => void setDue(q.tomorrow) },
      { label: `${t('overdue.monday')} · ${dueDateLabel(q.monday)}`, onSelect: () => void setDue(q.monday) },
      { divider: true },
      { label: t('overdue.pick'), icon: '📅', onSelect: () => openDialog((close) => <PickDateDialog onClose={close} onPick={(v) => { close(); void setDue(v); }} />) },
    ]);
  };
  const conv = d.conversations.find((c) => c.id === conversationId);
  const ownerMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const items: MenuItem[] = (conv?.memberIds ?? []).map((id) => personById(d, id)).filter((p) => p && p.kind === 'human' && p.id !== i.ownerId)
      .map((p) => ({ label: p!.id === d.me.id ? `${p!.name} ${t('common.you')}` : p!.name, onSelect: () => void client.updateIssue(issueId, { ownerId: p!.id }).then(() => toast(t('overdue.reassigned', { name: p!.name }))).catch((e) => toast(errorText(e))) }));
    openMenuAt(r.left, r.bottom + 4, items);
  };
  return (
    <div className="overdue-actions">
      <button className="btn small" onClick={(e) => dateMenu(e.currentTarget)}>📅 {t('overdue.newDate')}</button>
      <button className="btn small primary" onClick={() => void client.updateIssue(issueId, { status: 'done' }).catch((e) => toast(errorText(e)))}>✓ {t('overdue.markDone')}</button>
      <button className="btn small ghost" onClick={(e) => ownerMenu(e.currentTarget)}>👤 {t('overdue.reassign')}</button>
    </div>
  );
}

function PickDateDialog({ onClose, onPick }: { onClose: () => void; onPick: (ymd: string) => void }) {
  const [v, setV] = useState(quickDueDates().tomorrow);
  return (
    <Modal title={t('overdue.pickTitle')} onClose={onClose}>
      <input className="input" type="date" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!v} onClick={() => onPick(v)}>{t('overdue.newDate')}</button>
      </div>
    </Modal>
  );
}

export { parseNotice };
