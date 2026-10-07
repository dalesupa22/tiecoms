import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BootstrapDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { navigate, type Route } from '../router.ts';
import { DRAG_TYPE, useGridSide, useWide } from '../split.ts';
import { GridArea } from './Split.tsx';
import { Avatar, counterpartOrg, orgById, personById } from '../ui.tsx';
import { MentionsInbox } from './Mentions.tsx';
import type { ConversationDTO } from '@tiecoms/contracts';
import { t } from '../i18n.ts';
import { AllList, DmsList, GroupsBody, GroupsViewButton, dmConversations } from './Groups.tsx';
import { QuickSearchField, QuickSearchSections, isMac, openCreateMenu, openNewMessage, quickKey, MessageSearchSection, useQuickResults } from './Quick.tsx';
import { activityOf, isMuted, pendingOf } from '../home-order.ts';
import { DndStrip, MeAvatar } from './Silence.tsx';
import { AssistantBubble } from './Assistant.tsx';
import { Rail, useSideMode, setSideMode } from './Rail.tsx';
import { NotifyAsk } from '../bubbles.tsx';
import { InboxPane, WaListPane, type PaneFrame } from './Panes.tsx';
import { useSleepTzSync } from './Sleep.tsx';
import { SidebarResize } from './SidebarResize.tsx';

export function groupWorkspaces(d: BootstrapDTO) {
  const groups = new Map<string, { org: ReturnType<typeof orgById>; workspaces: BootstrapDTO['workspaces'] }>();
  for (const w of d.workspaces) {
    const org = counterpartOrg(d, w.id);
    const key = org?.id ?? 'none';
    if (!groups.has(key)) groups.set(key, { org, workspaces: [] });
    groups.get(key)!.workspaces.push(w);
  }
  return [...groups.values()];
}

// Orden de Inicio: home-order.ts (puro, con pruebas); se reexporta aquí por compatibilidad.
export { activityOf, pendingOf, compareConversations } from '../home-order.ts';

/** Espacios y empresas: por no leído agregado y luego por la actividad más reciente de sus conversaciones. */
function groupRank(convs: ConversationDTO[]) {
  return { unread: convs.reduce((n, c) => n + pendingOf(c), 0), activity: convs.reduce((m, c) => (activityOf(c) > m ? activityOf(c) : m), '') };
}
function compareRank(a: { unread: number; activity: string }, b: { unread: number; activity: string }) {
  if ((a.unread > 0) !== (b.unread > 0)) return a.unread > 0 ? -1 : 1;
  return b.unread - a.unread || b.activity.localeCompare(a.activity);
}
export function sortHome(d: BootstrapDTO, groups: ReturnType<typeof groupWorkspaces>) {
  const inWs = (id: string) => d.conversations.filter((c) => c.workspaceId === id);
  return groups
    .map((g) => {
      const ws = [...g.workspaces].sort((a, b) => compareRank(groupRank(inWs(a.id)), groupRank(inWs(b.id))) || a.id.localeCompare(b.id));
      return { ...g, workspaces: ws, rank: groupRank(ws.flatMap((w) => inWs(w.id))) };
    })
    .sort((a, b) => compareRank(a.rank, b.rank) || (a.org?.id ?? '').localeCompare(b.org?.id ?? ''));
}

// ---------- Filtros de la bandeja (mismas reglas en web, iOS y Android) ----------
export type HomeTab = 'all' | 'unread' | 'mentions' | 'issues' | 'chats' | 'sides';
/** En la barra lateral, «Sin leer» y «Menciones» son filtros pequeños junto al botón de vista. */
const SIDE_FILTERS = ['unread', 'mentions'] as const;
const TAB_KEY = 'tiecoms:homeTab';
/** No leídos = unread > 0 y no silenciada; Asuntos = openIssues > 0; Chats = direct + multi; Laterales = deriveKind 'side'. */
export function matchesTab(c: ConversationDTO, tab: HomeTab) {
  switch (tab) {
    case 'unread': return c.unread > 0 && (!isMuted(c) || (c.unreadMentions ?? 0) > 0);
    case 'mentions': return (c.unreadMentions ?? 0) > 0;
    case 'issues': return c.openIssues > 0;
    case 'chats': return c.kind === 'direct' || c.kind === 'multi';
    case 'sides': return c.deriveKind === 'side';
    default: return true;
  }
}
function storedFilter(): HomeTab { try { const v = localStorage.getItem(TAB_KEY); return v === 'unread' || v === 'mentions' ? v : 'all'; } catch { return 'all'; } }

function SideFilters({ d, filter, onFilter }: { d: BootstrapDTO; filter: HomeTab; onFilter: (f: HomeTab) => void }) {
  return (
    <div className="side-filters" role="group" aria-label={t('inbox.filters')}>
      {SIDE_FILTERS.map((k) => {
        const n = k === 'mentions' ? d.conversations.reduce((s, c) => s + (c.unreadMentions ?? 0), 0) : d.conversations.filter((c) => matchesTab(c, k)).length;
        return (
          <button key={k} aria-pressed={filter === k} className={`side-filter ${filter === k ? 'on' : ''}`} onClick={() => onFilter(filter === k ? 'all' : k)}>
            {k === 'mentions' ? '@' : '●'} {t(k === 'mentions' ? 'inbox.fMentions' : 'inbox.fUnread')}{n > 0 && <span className="home-tab-n">{n}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Arriba de la barra: ✎ Mensaje nuevo (también ⌘K / Ctrl+K desde cualquier pantalla) y «＋ Crear»
 * (grupo, asunto, reunión o unirme con código). Los mismos dos botones que en Grupos, DMs, Asuntos y Calendario.
 */
function QuickChat() {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        if (document.querySelector('.modal')) return;
        e.preventDefault(); openNewMessage();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <div className="quick-bar">
      <button className="quick-chat" onClick={openNewMessage} title={t('chat.quickHint', { key: quickKey })} aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}>
        <span aria-hidden>✎</span><span className="grow">{t('chat.quick')}</span><kbd>{quickKey}</kbd>
      </button>
      <button className="quick-create-side" aria-haspopup="menu" title={t('quick.create')} aria-label={t('quick.create')} onClick={(e) => openCreateMenu(e.currentTarget)}>＋</button>
    </div>
  );
}

function Sidebar({ route }: { route: Route }) {
  const d = useClient((s) => s.data)!;
  const [filter, setFilterState] = useState<HomeTab>(storedFilter);
  // Todo, Grupos o DMs lo elige el riel (Rail.tsx).
  const sideTab = useSideMode();
  // Buscar un chat desde la barra (pedido de Danny, 29-sep-2026): chats, grupos y personas; se limpia al abrir uno.
  const [sq, setSq] = useState('');
  const sideSearching = !!sq.trim();
  const quickR = useQuickResults(sq);
  const quickHas = !!(quickR.people.length || quickR.groups.length || quickR.chats.length);
  const routeKey = route.name === 'conversation' ? route.id : route.name;
  useEffect(() => { setSq(''); }, [routeKey]);
  const sideInput = useRef<HTMLInputElement>(null);
  // ⌘F / Ctrl+F: en un chat busca texto en la conversación; si ya estás ahí (o fuera de un chat), chats, grupos y personas.
  // ⌘⇧F / Ctrl+Shift+F: siempre chats, grupos y personas.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'f') return;
      if (document.querySelector('.modal')) return;
      e.preventDefault();
      if (sideTab === 'whatsapp' || sideTab === 'mail') { const field = document.querySelector<HTMLInputElement>('.provider-sidebar:not([hidden]) input[type=search], .provider-sidebar:not([hidden]) .pane-search input'); field?.focus(); return; }
      const inChatSearch = !!(document.activeElement as HTMLElement | null)?.closest('.chat-search');
      if (!e.shiftKey && route.name === 'conversation' && !inChatSearch) { dispatchEvent(new Event('chaggu:chat-search')); return; }
      sideInput.current?.focus(); sideInput.current?.select();
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [route.name, sideTab]);
  const setFilter = (v: HomeTab) => { setFilterState(v); try { localStorage.setItem(TAB_KEY, v); } catch {} };
  const dms = dmConversations(d, filter);
  const activeConv = route.name === 'conversation' ? route.id : route.name === 'waChat' ? `wa:${route.accountId}:${route.jid}` : null;
  return (
    <aside className="side">
      <QuickChat />
      <DndStrip />
      <div className="side-search"><QuickSearchField inputRef={sideInput} value={sq} onChange={setSq} placeholder={t('side.searchChats')} order={['chats', 'groups', 'people']} hint={isMac ? '⌘F' : 'Ctrl+F'} /></div>
      <NotifyAsk />
      {!sideSearching && <div className="side-title">
        <span className="grow">{t(sideTab === 'groups' ? 'nav.groups' : sideTab === 'dms' ? 'side.dmsTitle' : 'side.allTitle')}</span>
        {/* Lista | Árbol y plegar van en un solo botón de vista (solo en Grupos). */}
        {sideTab === 'groups' && filter !== 'mentions' && <GroupsViewButton tab={filter} withView />}
      </div>}
      {!sideSearching && <div className="home-tabs-row side-tools">
        <SideFilters d={d} filter={filter} onFilter={setFilter} />
      </div>}
      <div className="side-scroll">
        {sideSearching ? <><QuickSearchSections query={sq} order={['chats', 'groups', 'people']} withMessages /><MessageSearchSection query={sq} hasQuick={quickHas} /></>
          : filter === 'mentions' ? <MentionsInbox />
          : sideTab === 'all' ? <AllList tab={filter} activeConv={activeConv} />
          : sideTab === 'groups' ? <GroupsBody tab={filter} activeConv={activeConv} />
          : <>
            <DmsList tab={filter} activeConv={activeConv} />
            {dms.length === 0 && <button className="side-conv" onClick={openNewMessage}><span className="hash">✎</span><span className="grow muted">{t('dms.new')}</span></button>}
          </>}
      </div>
    </aside>
  );
}

/** Íconos de línea de la barra inferior (mismos dibujos que iOS y Android). */
const TAB_ICONS: Record<string, ReactNode> = {
  groups: <><circle cx="8" cy="8" r="3" /><circle cx="16" cy="8" r="3" /><path d="M2.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M12.5 15.2c.9-.8 2.1-1.2 3.5-1.2 2.7 0 4.9 1.8 5.5 5" /></>,
  dms: <><path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h8a2.5 2.5 0 0 1 2.5 2.5v5A2.5 2.5 0 0 1 14 14H8.5L5 17v-3.1A2.5 2.5 0 0 1 3.5 11.5z" /><path d="M16.5 8.5H18a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-1.5 2.3V21l-3.2-2.5H12a2.5 2.5 0 0 1-2.3-1.5" /></>,
  tasks: <><path d="M4 6.5l1.8 1.8L9 5M4 16.5l1.8 1.8L9 15" /><path d="M12 7h8M12 17h8" /></>,
  agenda: <><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /><circle cx="8.5" cy="14.5" r=".6" /><circle cx="12" cy="14.5" r=".6" /><circle cx="15.5" cy="14.5" r=".6" /></>,
  calls: <path d="M6.6 3.5h2.3l1.4 4-2 1.3a11 11 0 0 0 6.9 6.9l1.3-2 4 1.4v2.3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" />,
};
function TabIcon({ name }: { name: string }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{TAB_ICONS[name]}</svg>;
}

/** Barra inferior móvil: 5 pestañas fijas (docs/GRUPOS.md), 6 con las llamadas prendidas. Solo íconos, sin texto. */
function MobileTabs({ route }: { route: Route }) {
  const d = useClient((s) => s.data);
  const taskInbox = useClient((s) => s.taskInbox.length);
  const unreadOf = (f: (c: ConversationDTO) => boolean) => d?.conversations.filter(f).reduce((n, c) => n + (isMuted(c) ? 0 : c.unread), 0) ?? 0;
  const me = d ? personById(d, d.me.id) : null;
  const tabs = [
    { name: 'groups', label: t('nav.groups'), ico: 'groups', to: '/grupos', badge: unreadOf((c) => !!c.workspaceId) },
    { name: 'dms', label: t('nav.dms'), ico: 'dms', to: '/dms', badge: unreadOf((c) => c.kind === 'direct' || c.kind === 'multi') },
    { name: 'issues', label: t('nav.issues'), ico: 'tasks', to: '/asuntos', badge: taskInbox },
    { name: 'agenda', label: t('nav.calendar'), ico: 'agenda', to: '/agenda', badge: 0 },
    ...(d?.features?.calls ? [{ name: 'calls', label: t('nav.calls'), ico: 'calls', to: '/llamadas', badge: d.missedCalls ?? 0 }] : []),
    { name: 'settings', label: t('nav.you'), ico: null, to: '/ajustes', badge: 0 },
  ];
  return (
    <nav className={`tabs ${tabs.length === 6 ? 'n6' : ''}`} aria-label={t('nav.mainNav')}>
      {tabs.map((x) => (
        <button key={x.name} className={route.name === x.name || (x.name === 'groups' && route.name === 'today') ? 'on' : ''} onClick={() => navigate(x.to)}
          aria-label={x.label} title={x.label}>
          {x.ico ? <span className="ico"><TabIcon name={x.ico} /></span> : <span className="ico">{d ? <MeAvatar size={24} /> : <Avatar person={me} org={null} size={24} />}</span>}
          {/* Solo íconos, sin texto (pedido de Danny, 29-sep-2026); el nombre va en aria-label y title. */}
          {x.badge > 0 && <span className={`pill ${x.name === 'calls' ? 'is-missed' : ''}`}>{x.badge}</span>}
        </button>
      ))}
    </nav>
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  useSleepTzSync();
  const connection = useClient((s) => s.connection);
  const inConv = route.name === 'conversation';
  // WhatsApp y Correo con la cuadrícula al lado (botón «Cuadrícula al lado»): arrastras directo a un cuadrito o a un chat.
  const wide = useWide();
  const mode = useSideMode();
  const provider = mode === 'whatsapp' || mode === 'mail' ? mode : null;
  const shellRef = useRef<HTMLDivElement>(null);
  const [visited, setVisited] = useState<Set<string>>(() => new Set(provider ? [provider] : []));
  const [expandedProvider, setExpandedProvider] = useState<string | null>(() => new URLSearchParams(location.search).get('provider'));
  useEffect(() => { if (provider) setVisited((v) => v.has(provider) ? v : new Set([...v, provider])); }, [provider]);
  useEffect(() => {
    const sync = () => { const value = new URLSearchParams(location.search).get('provider'); setExpandedProvider(value); };
    addEventListener('popstate', sync); addEventListener('chaggu:provider', sync); addEventListener('chaggu:navigate', sync);
    return () => { removeEventListener('popstate', sync); removeEventListener('chaggu:provider', sync); removeEventListener('chaggu:navigate', sync); };
  }, []);
  const providerFrame = (name: 'whatsapp' | 'mail'): PaneFrame => ({
    active: provider === name, count: 1, pinned: false, presentation: 'sidebar', expanded: expandedProvider === name,
    onClose: () => setSideMode('all'), onPin: () => {}, onTint: () => {},
    onOnly: () => { const url = new URL(location.href); if (expandedProvider === name) url.searchParams.delete('provider'); else url.searchParams.set('provider', name); history.pushState(null, '', url); setExpandedProvider(expandedProvider === name ? null : name); window.dispatchEvent(new Event('chaggu:provider')); },
  });
  const sideGrid = useGridSide() && wide && (route.name === 'whatsapp' || route.name === 'mail');
  return (
    <div ref={shellRef} className={`shell ${inConv ? 'in-conv' : ''} ${provider ? 'has-provider' : ''} ${provider && expandedProvider !== provider && wide ? 'provider-resizable' : ''}`}>
      <Rail route={route} />
      <div className="sidebar-host">
        <div className="sidebar-chats" hidden={!!provider}><Sidebar route={route} /></div>
        {(['whatsapp', 'mail'] as const).filter((p) => visited.has(p) || p === provider).map((p) => <aside key={p} id={`provider-sidebar-${p}`} hidden={provider !== p} className={`provider-sidebar ${expandedProvider === p ? 'is-expanded' : ''}`} aria-label={p === 'mail' ? t('nav.mail') : 'WhatsApp'}>
          {p === 'whatsapp' ? <WaListPane frame={providerFrame(p)} /> : <InboxPane frame={providerFrame(p)} />}
        </aside>)}
        {provider && wide && expandedProvider !== provider && <SidebarResize key={provider} shellRef={shellRef} provider={provider} />}
      </div>
      {/* Fuera de un chat, soltar una conversación arrastrada la abre (dentro, Split.tsx la pone al lado). */}
      <main className={`main ${sideGrid ? 'has-grid-side' : ''}`} onDragOver={inConv ? undefined : (e) => { if (Array.from(e.dataTransfer.types).includes(DRAG_TYPE)) e.preventDefault(); }}
        onDrop={inConv ? undefined : (e) => { const id = e.dataTransfer.getData(DRAG_TYPE); if (id) { e.preventDefault(); navigate(`/c/${id}`); } }}>
        {connection !== 'online' && <div className="conn" role="status">{connection === 'connecting' ? t('conn.connecting') : t('conn.offline')}</div>}
        {children}
        {sideGrid && <aside className="grid-side" aria-label={t('nav.grid')}><GridArea id={null} side /></aside>}
      </main>
      <MobileTabs route={route} />
      {/* gg siempre a mano (Danny, 29-sep-2026): también dentro de un chat, por encima del campo de escribir. */}
      <AssistantBubble hidden={false} inConv={inConv || route.name === 'grid' || route.name === 'waChat' || sideGrid || !!provider} />
    </div>
  );
}

export function SignOutButton() {
  return <button className="btn" onClick={() => client.logout().then(() => navigate('/login', true))}>{t('settings.logout')}</button>;
}
