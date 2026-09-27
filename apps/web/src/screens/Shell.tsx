import { useEffect, useState, type ReactNode } from 'react';
import type { BootstrapDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { asset, navigate, type Route } from '../router.ts';
import { Avatar, counterpartOrg, orgById, personById } from '../ui.tsx';
import { MentionsInbox } from './Mentions.tsx';
import type { ConversationDTO } from '@tiecoms/contracts';
import { t } from '../i18n.ts';
import { openAccountMenu } from './Profile.tsx';
import { AllList, DmsList, GroupsBody, GroupsViewButton, GroupsViewToggle, dmConversations, useGroupsView } from './Groups.tsx';
import { isMac, openCreateMenu, openNewMessage, quickKey } from './Quick.tsx';
import { activityOf, isMuted, pendingOf } from '../home-order.ts';

const NAV = [
  { name: 'today', label: 'nav.today', ico: '◑', to: '/' },
  { name: 'inbox', label: 'nav.inbox', ico: '◍', to: '/conversaciones' },
  { name: 'agenda', label: 'nav.agenda', ico: '▤', to: '/agenda' },
  { name: 'issues', label: 'nav.issues', ico: '◆', to: '/asuntos' },
  { name: 'trazo', label: 'nav.trazo', ico: '⑂', to: '/trazo' },
  { name: 'people', label: 'nav.people', ico: '◎', to: '/participantes' },
  { name: 'files', label: 'nav.files', ico: '▣', to: '/archivos' },
  { name: 'saved', label: 'nav.saved', ico: '🔖', to: '/ver-despues' },
  { name: 'whatsapp', label: 'nav.whatsapp', ico: '✆', to: '/whatsapp' },
] as const;
/** Today, Conversaciones, Calendario y Asuntos siempre; el resto bajo «Más». */
const NAV_MAIN = 4;
const NAV_MORE_KEY = 'tiecoms:navMore';

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

// ---------- Pestañas «Todo · Grupos · DMs» de la barra lateral (solo web de escritorio) ----------
type SideTab = 'all' | 'groups' | 'dms';
const SIDE_TAB_KEY = 'chaggu:sidebarTab';
function storedSideTab(): SideTab { try { const v = localStorage.getItem(SIDE_TAB_KEY); return v === 'groups' || v === 'dms' ? v : 'all'; } catch { return 'all'; } }
const isDmRow = (c: ConversationDTO) => (c.kind === 'direct' || c.kind === 'multi') && !(c.parentId && c.deriveKind !== 'side');

function SideTabs({ d, tab, onTab }: { d: BootstrapDTO; tab: SideTab; onTab: (t: SideTab) => void }) {
  // Globo: no leídos pendientes (no silenciados, o con mención). «Grupos» incluye las respuestas de sus hilos.
  const sum = (f: (c: ConversationDTO) => boolean) => d.conversations.filter(f).reduce((n, c) => n + pendingOf(c), 0);
  const groups = sum((c) => !!c.workspaceId && c.deriveKind !== 'side');
  const dms = sum(isDmRow);
  const n: Record<SideTab, number> = { all: groups + dms, groups, dms };
  return (
    <div className="side-tabs" role="tablist" aria-label={t('inbox.tabs')}>
      {(['all', 'groups', 'dms'] as const).map((k) => (
        <button key={k} role="tab" aria-selected={tab === k} className={`side-tab ${tab === k ? 'on' : ''}`} onClick={() => onTab(k)}>
          {t(`inbox.tab.${k}`)}{n[k] > 0 && <span className="side-tab-n">{n[k]}</span>}
        </button>
      ))}
    </div>
  );
}

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
  const [sideTab, setSideTabState] = useState<SideTab>(storedSideTab);
  const view = useGroupsView();
  // Las secciones menos usadas van bajo «Más» para que los grupos y las relaciones quepan sin scroll.
  const [navMore, setNavMore] = useState(() => { try { return localStorage.getItem(NAV_MORE_KEY) === '1'; } catch { return false; } });
  const toggleNavMore = () => { const v = !navMore; setNavMore(v); try { localStorage.setItem(NAV_MORE_KEY, v ? '1' : '0'); } catch {} };
  const setFilter = (v: HomeTab) => { setFilterState(v); try { localStorage.setItem(TAB_KEY, v); } catch {} };
  const setSideTab = (v: SideTab) => { setSideTabState(v); try { localStorage.setItem(SIDE_TAB_KEY, v); } catch {} };
  const unreadTotal = d.conversations.reduce((n, c) => n + (isMuted(c) ? 0 : c.unread), 0);
  const dms = dmConversations(d, filter);
  const me = personById(d, d.me.id);
  const myOrg = orgById(d, d.me.primaryOrgId);
  const activeConv = route.name === 'conversation' ? route.id : null;

  return (
    <aside className="side">
      <div className="side-brand">
        <img src={asset("/chaggu-logo.svg")} alt="Chaggu" width={78} height={34} />
        <span className="eyebrow" style={{ fontSize: 10 }}>{t('brand.network')}</span>
      </div>
      <QuickChat />
      <nav className="nav">
        {NAV.filter((n, i) => i < NAV_MAIN || navMore || route.name === n.name).map((n) => (
          <button key={n.name} className={`nav-item ${route.name === n.name ? 'active' : ''}`} onClick={() => navigate(n.to)}>
            <span className="ico">{n.ico}</span><span className="grow">{t(n.label)}</span>
            {n.name === 'today' && unreadTotal > 0 && <span className="pill">{unreadTotal}</span>}
          </button>
        ))}
        <button className="nav-item nav-more" aria-expanded={navMore} onClick={toggleNavMore}>
          <span className="ico">{navMore ? '⌃' : '⋯'}</span><span className="grow">{navMore ? t('nav.less') : t('nav.more')}</span>
        </button>
      </nav>
      <SideTabs d={d} tab={sideTab} onTab={setSideTab} />
      <div className="home-tabs-row side-tools">
        <SideFilters d={d} filter={filter} onFilter={setFilter} />
        {/* Lista | Árbol vive junto a ☰; ☰ (plegar) solo aplica en Árbol. */}
        {sideTab === 'groups' && filter !== 'mentions' && <GroupsViewToggle />}
        {sideTab === 'groups' && view === 'tree' && filter !== 'mentions' && <GroupsViewButton tab={filter} />}
      </div>
      <div className="side-scroll">
        {filter === 'mentions' ? <MentionsInbox />
          : sideTab === 'all' ? <AllList tab={filter} activeConv={activeConv} />
          : sideTab === 'groups' ? <GroupsBody tab={filter} activeConv={activeConv} />
          : <>
            <DmsList tab={filter} activeConv={activeConv} />
            {dms.length === 0 && <button className="side-conv" onClick={openNewMessage}><span className="hash">✎</span><span className="grow muted">{t('dms.new')}</span></button>}
          </>}
      </div>
      <button className="side-foot" style={{ border: 0, borderTop: '1px solid var(--line)', background: 'transparent', textAlign: 'left' }}
        aria-haspopup="menu" title={t('profile.menu')} onClick={(e) => openAccountMenu(e.currentTarget)}>
        <Avatar person={me} org={myOrg} size={34} />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="ellipsis" style={{ display: 'block', fontWeight: 700 }}>{d.me.name}</span>
          <span className="ellipsis small muted" style={{ display: 'block' }}>{myOrg?.name}</span>
        </span>
        <span className="muted" aria-hidden>⋯</span>
      </button>
    </aside>
  );
}

/** Barra inferior móvil: 5 pestañas fijas (docs/GRUPOS.md). */
function MobileTabs({ route }: { route: Route }) {
  const d = useClient((s) => s.data);
  const unreadOf = (f: (c: ConversationDTO) => boolean) => d?.conversations.filter(f).reduce((n, c) => n + (isMuted(c) ? 0 : c.unread), 0) ?? 0;
  const me = d ? personById(d, d.me.id) : null;
  const tabs = [
    { name: 'groups', label: t('nav.groups'), ico: '▦', to: '/grupos', badge: unreadOf((c) => !!c.workspaceId) },
    { name: 'dms', label: t('nav.dms'), ico: '◍', to: '/dms', badge: unreadOf((c) => c.kind === 'direct' || c.kind === 'multi') },
    { name: 'issues', label: t('nav.issues'), ico: '◆', to: '/asuntos', badge: 0 },
    { name: 'agenda', label: t('nav.calendar'), ico: '▤', to: '/agenda', badge: 0 },
    { name: 'settings', label: t('nav.you'), ico: null, to: '/ajustes', badge: 0 },
  ];
  return (
    <nav className="tabs" aria-label={t('nav.mainNav')}>
      {tabs.map((x) => (
        <button key={x.name} className={route.name === x.name || (x.name === 'groups' && route.name === 'today') ? 'on' : ''} onClick={() => navigate(x.to)}>
          {x.ico ? <span className="ico">{x.ico}</span> : <span className="ico"><Avatar person={me} org={d ? orgById(d, d.me.primaryOrgId) : null} size={22} /></span>}{x.label}
          {x.badge > 0 && <span className="pill">{x.badge}</span>}
        </button>
      ))}
    </nav>
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const connection = useClient((s) => s.connection);
  const inConv = route.name === 'conversation';
  return (
    <div className={`shell ${inConv ? 'in-conv' : ''}`}>
      <Sidebar route={route} />
      <main className="main">
        {connection !== 'online' && <div className="conn" role="status">{connection === 'connecting' ? t('conn.connecting') : t('conn.offline')}</div>}
        {children}
      </main>
      <MobileTabs route={route} />
    </div>
  );
}

export function SignOutButton() {
  return <button className="btn" onClick={() => client.logout().then(() => navigate('/login', true))}>{t('settings.logout')}</button>;
}
