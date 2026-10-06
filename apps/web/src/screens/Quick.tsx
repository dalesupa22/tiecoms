import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { MailPickDialog } from './Mail.tsx';
import type { BootstrapDTO, ChatSearchResultDTO, ConversationDTO, PersonDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { openDialog } from '../actions.tsx';
import { errorText, t } from '../i18n.ts';
import { openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { navigate } from '../router.ts';
import { flashPane } from '../split.ts';
import { Avatar, conversationSubtitle, conversationTitle, orgById, personById } from '../ui.tsx';
import { directWith, issueDestinations, quickSearch, type Namer, type QuickResults } from '../quick-search.ts';
import { NewChatDialog } from './Chats.tsx';
import { ConvItem, JoinWithCodeDialog, openCreateGroup } from './Groups.tsx';
import { NewIssueDialog } from './Issues.tsx';
import { newEvent } from './Calendar.tsx';
import { newRoomDialog, startMeetingNow } from './MyLinks.tsx';

// ---------- Barra de arriba: ✎ Mensaje nuevo · ＋ Crear (docs/GRUPOS.md › Barra de arriba y búsqueda rápida) ----------
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const quickKey = isMac ? '⌘K' : 'Ctrl+K';
export const openNewMessage = () => openDialog((close) => <NewChatDialog onClose={close} />);

/** «＋» solo para crear: grupo, asunto o reunión (o entrar con código). */
export function createMenuItems(): MenuItem[] {
  const d = client.getState().data;
  const canIssue = !!d && issueDestinations(d).length > 0;
  return [
    { label: t('groups.new'), icon: '▦', onSelect: () => openCreateGroup() },
    { label: t('issue.newTitle'), icon: '◆', disabled: !canIssue,
      onSelect: () => openDialog((close) => <NewIssueDialog onClose={close} onCreated={(i) => navigate(`/c/${i.conversationId}?issue=${i.id}`)} />) },
    // Como «Nueva» de Google Meet: un enlace para después, una reunión ya, o programarla en el calendario.
    ...(d?.features?.calls ? [
      { label: t('quick.roomLater'), icon: '🔗', onSelect: () => newRoomDialog() },
      { label: t('quick.roomNow'), icon: '🎥', onSelect: () => void startMeetingNow() },
    ] : []),
    { label: d?.features?.calls ? t('quick.schedule') : t('cal.newTitle'), icon: '📅', onSelect: () => newEvent() },
    ...(d?.features?.mail ? [{ label: t('mail.bringOne'), icon: '✉', onSelect: () => openDialog((close) => <MailPickDialog onClose={close} />) }] : []),
    { divider: true },
    { label: t('join.title'), icon: '⌗', onSelect: () => openDialog((close) => <JoinWithCodeDialog onClose={close} />) },
  ];
}

/** El menú sale debajo del botón, alineado a su borde derecho. */
export function openCreateMenu(anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  openMenuAt(r.right - 236, r.bottom + 4, createMenuItems());
}

/** ✎ y «＋ Crear»: los mismos dos botones en Grupos, DMs, Asuntos y Calendario. */
export function QuickActions() {
  return (
    <div className="quick-actions" role="group">
      <button className="icon-btn quick-compose" onClick={openNewMessage} title={`${t('dms.new')} (${quickKey})`} aria-label={t('dms.new')}
        aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}>✎</button>
      <button className="btn small quick-create" aria-haspopup="menu" onClick={(e) => openCreateMenu(e.currentTarget)}>＋ {t('quick.create')}</button>
    </div>
  );
}

// ---------- Abrir el directo con una persona ----------
/** Clic en una persona (búsqueda, «Recientes», «Mensaje nuevo»): abre su directo y, si no existe, lo crea (idempotente). */
export async function openDirect(personId: string) {
  const d = client.getState().data!;
  const existing = directWith(d, personId);
  if (existing) { openChat(existing.id); return; }
  const r = await client.request<{ id: string }>('/chats', { method: 'POST', json: { userIds: [personId] } });
  await client.loadBootstrap();
  openChat(r.id);
}
/** Abre un chat y lo hace brillar: si ya era el abierto (misma URL) o estaba fuera de la vista en la cuadrícula, igual se ve. */
export function openChat(id: string) {
  navigate(`/c/${id}`);
  flashPane(id);
}

export const namerFor = (d: BootstrapDTO): Namer => ({ title: (c) => conversationTitle(d, c), subtitle: (c) => conversationSubtitle(d, c) });
export const roleLine = (p: PersonDTO) => [p.title, p.area].filter(Boolean).join(' · ');

/** Persona con su foto, cargo o empresa y un globito (clic = abre el chat). */
export function PersonRow({ d, p, active = false, onOpen }: { d: BootstrapDTO; p: PersonDTO; active?: boolean; onOpen: () => void }) {
  const org = orgById(d, p.orgId);
  const line = [roleLine(p), org?.name ?? (p.guest ? t('common.guest') : '')].filter(Boolean).join(' · ');
  return (
    <button type="button" className={`person-row ${active ? 'is-active' : ''}`} onClick={onOpen} title={t('search.opensChat')} data-active={active || undefined}>
      <Avatar person={p} org={org} size={32} />
      <span className="grow" style={{ minWidth: 0 }}>
        <b className="ellipsis" style={{ display: 'block' }}>{p.name}</b>
        {line && <span className="small muted ellipsis" style={{ display: 'block' }}>{line}</span>}
      </span>
      <span className="person-row-go" aria-hidden>💬</span>
    </button>
  );
}

// ---------- Resultados de búsqueda en Grupos y DMs ----------
type Part = 'people' | 'groups' | 'chats';
const LIMIT = 8;

export function useQuickResults(query: string): QuickResults {
  const d = useClient((s) => s.data)!;
  return quickSearch(d, query, namerFor(d));
}

/** Lo primero que se abre con Enter en el buscador (en el orden de la pantalla). */
export function firstResult(r: QuickResults, order: Part[]): (() => void) | null {
  for (const part of order) {
    if (part === 'people' && r.people[0]) { const p = r.people[0]; return () => void openDirect(p.id).catch((e) => toast(errorText(e))); }
    const c: ConversationDTO | undefined = part === 'groups' ? r.groups[0] : part === 'chats' ? r.chats[0] : undefined;
    if (c) return () => navigate(`/c/${c.id}`);
  }
  return null;
}

/** Al buscar en Grupos o DMs también salen personas (clic = escribirle), grupos y chats; quien tiene su directo en Chats no se repite. */
export function QuickSearchSections({ query, order, withMessages = false }: { query: string; order: Part[]; withMessages?: boolean }) {
  const d = useClient((s) => s.data)!;
  const r = useQuickResults(query);
  const empty = !r.people.length && !r.groups.length && !r.chats.length;
  // Si abajo se buscan mensajes, el «sin resultados» lo decide esa sección.
  if (empty) return withMessages ? null : <div className="empty">{t('search.none', { q: query.trim() })}</div>;
  const head = (k: 'search.people' | 'search.groups' | 'search.chats') => <div className="eyebrow quick-head">{t(k)}</div>;
  return (
    <div className="quick-results">
      {order.map((part) => {
        if (part === 'people' && r.people.length) return (
          <section key={part}>{head('search.people')}
            {r.people.slice(0, LIMIT).map((p) => <PersonRow key={p.id} d={d} p={p} onOpen={() => void openDirect(p.id).catch((e) => toast(errorText(e)))} />)}
          </section>
        );
        const list = part === 'groups' ? r.groups : part === 'chats' ? r.chats : [];
        if (!list.length) return null;
        return (
          <section key={part}>{head(part === 'groups' ? 'search.groups' : 'search.chats')}
            {list.slice(0, LIMIT).map((c) => <ConvItem key={c.id} c={c} active={false} showWs={part === 'groups'} showOrg />)}
          </section>
        );
      })}
    </div>
  );
}

/** Buscador de Grupos y DMs: Enter abre el primer resultado; Esc borra. */
export function QuickSearchField({ value, onChange, placeholder, order, inputRef, hint }: { value: string; onChange: (v: string) => void; placeholder: string; order: Part[]; inputRef?: Ref<HTMLInputElement>; hint?: string }) {
  const r = useQuickResults(value);
  return (
    <div className="search-field">
      <span aria-hidden className="muted">⌕</span>
      <input ref={inputRef} className="grow" type="search" value={value} placeholder={placeholder} aria-label={placeholder} autoComplete="off" spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { const go = firstResult(r, order); if (go) { e.preventDefault(); go(); } }
          else if (e.key === 'Escape' && value) { e.preventDefault(); onChange(''); }
        }} />
      {value ? <button type="button" className="search-clear" onClick={() => onChange('')} aria-label={t('common.clear')}>×</button>
        : hint ? <kbd className="search-kbd" aria-hidden>{hint}</kbd> : null}
    </div>
  );
}


/**
 * Buscar en todos los chats (pedido de Danny, 29-sep-2026): debajo de chats, grupos y personas, los mensajes que
 * coinciden, del más nuevo al más viejo, con «Ver más». Tocar uno abre el chat en ese mensaje.
 */
export function MessageSearchSection({ query, hasQuick }: { query: string; hasQuick: boolean }) {
  const d = useClient((s) => s.data)!;
  const [results, setResults] = useState<ChatSearchResultDTO[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const q = query.trim();
  const load = async (before?: string) => {
    ctl.current?.abort();
    const c = new AbortController(); ctl.current = c;
    setBusy(true);
    try {
      const r = await client.searchAll(q, before, 20, c.signal);
      if (c.signal.aborted) return;
      setResults((x) => (before ? [...(x ?? []), ...r.results] : r.results)); setMore(r.hasMore);
    } catch (e: any) { if (!c.signal.aborted && e?.name !== 'AbortError') setResults((x) => x ?? []); }
    finally { if (!c.signal.aborted) setBusy(false); }
  };
  useEffect(() => {
    setResults(null); setMore(false);
    if (q.length < 2) return;
    const h = setTimeout(() => void load(), 350);
    return () => { clearTimeout(h); ctl.current?.abort(); };
  }, [q]);
  if (q.length < 2) return null;
  const hl = (snippet: string, matches: [number, number][]) => {
    const out: ReactNode[] = []; let at = 0;
    matches.forEach(([s, l], i) => { out.push(snippet.slice(at, s)); out.push(<mark key={i}>{snippet.slice(s, s + l)}</mark>); at = s + l; });
    out.push(snippet.slice(at));
    return out;
  };
  const when = (iso: string) => { const dt = new Date(iso); const today = new Date().toDateString() === dt.toDateString(); return dt.toLocaleString(undefined, today ? { hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short' }); };
  return (
    <section className="msg-search">
      <div className="eyebrow quick-head">{t('search.messages')}{busy && !results ? ' · …' : ''}</div>
      {results?.length === 0 && !hasQuick && <div className="empty">{t('search.none', { q })}</div>}
      {results?.length === 0 && hasQuick && <div className="hint" style={{ padding: '4px 10px' }}>{t('search.noMessages')}</div>}
      {results?.map((r) => {
        const conv = d.conversations.find((c) => c.id === r.message.conversationId);
        const author = personById(d, r.message.authorId);
        return (
          <button key={r.message.id} className="msg-search-row" onClick={() => navigate(`/c/${r.message.conversationId}?m=${r.message.seq}`)}>
            <span className="row" style={{ gap: 6 }}>
              <b className="ellipsis grow">{conv ? conversationTitle(d, conv) : t('chat.aConversation')}</b>
              <span className="small muted">{when(r.message.createdAt)}</span>
            </span>
            <span className="small msg-search-snip">
              {r.field === 'mail' ? '✉ ' : r.field === 'attachment' ? '📎 ' : r.field === 'transcript' ? '🎙 ' : ''}
              <b>{r.message.authorId === d.me.id ? t('common.youShort') : author?.name.split(' ')[0] ?? ''}</b>{': '}{hl(r.snippet, r.matches)}
            </span>
          </button>
        );
      })}
      {more && <button className="link-btn small" disabled={busy} onClick={() => void load(results?.at(-1)?.message.createdAt)}>{busy ? t('common.loading') : t('search.moreMessages')}</button>}
    </section>
  );
}
