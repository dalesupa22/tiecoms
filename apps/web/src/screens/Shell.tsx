import { useState, type ReactNode } from 'react';
import type { BootstrapDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { asset, navigate, type Route } from '../router.ts';
import { Avatar, counterpartOrg, orgById, personById } from '../ui.tsx';
import { MentionsInbox } from './Mentions.tsx';
import { openDialog } from '../actions.tsx';
import type { ConversationDTO } from '@tiecoms/contracts';
import { t } from '../i18n.ts';
import { openAccountMenu } from './Profile.tsx';
import { NewChatDialog } from './Chats.tsx';
import { ConvItem, GroupsTree, dmConversations } from './Groups.tsx';

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

// ---------- Orden de Inicio (mismas reglas en web, iOS y Android) ----------
/** Actividad: el último mensaje de una persona si lo hay; si no, el último mensaje. */
export const activityOf = (c: ConversationDTO) => c.lastHumanPreview?.createdAt ?? c.lastMessageAt ?? '';
/** Con no leídos (no silenciada) cuenta como pendiente; silenciada con no leídos cuenta como leída. */
export const pendingOf = (c: ConversationDTO) => (c.unread > 0 && (!isMuted(c) || (c.unreadMentions ?? 0) > 0) ? c.unread : 0);
/**
 * Primero las que tienen no leídos, luego el resto; en cada bloque las fijadas arriba y después por
 * actividad descendente. Desempate por id para que el orden sea estable.
 */
export function compareConversations(a: ConversationDTO, b: ConversationDTO) {
  // Una mención sin leer sube arriba del todo (aunque la conversación esté silenciada).
  const ma = (a.unreadMentions ?? 0) > 0 ? 1 : 0, mb = (b.unreadMentions ?? 0) > 0 ? 1 : 0;
  if (ma !== mb) return mb - ma;
  const ua = pendingOf(a) > 0 ? 1 : 0, ub = pendingOf(b) > 0 ? 1 : 0;
  if (ua !== ub) return ub - ua;
  const pa = a.pinnedAt ? 1 : 0, pb = b.pinnedAt ? 1 : 0;
  if (pa !== pb) return pb - pa;
  return activityOf(b).localeCompare(activityOf(a)) || a.id.localeCompare(b.id);
}
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

// ---------- Pestañas de Inicio (mismas reglas en web, iOS y Android) ----------
export type HomeTab = 'all' | 'unread' | 'mentions' | 'issues' | 'chats' | 'sides';
/** Chats y sidechats tienen su propia sección (DMs): los filtros de Grupos no los repiten. */
export const HOME_TABS: HomeTab[] = ['all', 'unread', 'mentions', 'issues'];
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
function storedTab(): HomeTab { try { const v = localStorage.getItem(TAB_KEY) as HomeTab | null; return v && HOME_TABS.includes(v) ? v : 'all'; } catch { return 'all'; } }

function HomeTabs({ d, tab, onTab }: { d: BootstrapDTO; tab: HomeTab; onTab: (t: HomeTab) => void }) {
  return (
    <div className="home-tabs" role="tablist" aria-label={t('home.filters')}>
      {HOME_TABS.map((k) => {
        const n = k === 'all' ? d.conversations.length : k === 'mentions' ? d.conversations.reduce((s, c) => s + (c.unreadMentions ?? 0), 0) : d.conversations.filter((c) => matchesTab(c, k)).length;
        return (
          <button key={k} role="tab" aria-selected={tab === k} className={`home-tab ${tab === k ? 'on' : ''}`} onClick={() => onTab(k)}>
            {t(`home.tab.${k}`)}{k !== 'all' && n > 0 ? <span className="home-tab-n">{n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function Sidebar({ route }: { route: Route }) {
  const d = useClient((s) => s.data)!;
  const [tab, setTabState] = useState<HomeTab>(storedTab);
  const setTab = (v: HomeTab) => { setTabState(v); try { localStorage.setItem(TAB_KEY, v); } catch {} };
  const unreadTotal = d.conversations.reduce((n, c) => n + (isMuted(c) ? 0 : c.unread), 0);
  const pinnedConvs = d.conversations.filter((c) => c.pinnedAt && matchesTab(c, tab)).sort((a, b) => (a.pinnedAt ?? '').localeCompare(b.pinnedAt ?? ''));
  const dms = dmConversations(d, tab);
  const me = personById(d, d.me.id);
  const myOrg = orgById(d, d.me.primaryOrgId);
  const activeConv = route.name === 'conversation' ? route.id : null;
  const activeWs = route.name === 'workspace' ? route.id : null;

  return (
    <aside className="side">
      <div className="side-brand">
        <img src={asset("/chaggu-logo.svg")} alt="Chaggu" width={78} height={34} />
        <span className="eyebrow" style={{ fontSize: 10 }}>{t('brand.network')}</span>
      </div>
      <nav className="nav">
        {NAV.map((n) => (
          <button key={n.name} className={`nav-item ${route.name === n.name ? 'active' : ''}`} onClick={() => navigate(n.to)}>
            <span className="ico">{n.ico}</span><span className="grow">{t(n.label)}</span>
            {n.name === 'today' && unreadTotal > 0 && <span className="pill">{unreadTotal}</span>}
          </button>
        ))}
      </nav>
      <div className="side-scroll">
        <HomeTabs d={d} tab={tab} onTab={setTab} />
        {tab === 'mentions' ? <MentionsInbox /> : <>
        {pinnedConvs.length > 0 && (
          <div className="side-pinned">
            <div className="eyebrow" style={{ padding: '4px 10px' }}>📌 {t('side.pinned')}</div>
            {pinnedConvs.map((c) => <ConvItem key={c.id} c={c} active={activeConv === c.id} showWs />)}
          </div>
        )}
        <GroupsTree tab={tab} activeConv={activeConv} activeWs={activeWs} />
        <div className="row" style={{ padding: '14px 10px 2px' }}>
          <span className="eyebrow grow">{t('nav.dms')}</span>
          <button className="btn ghost small" onClick={() => openDialog((close) => <NewChatDialog onClose={close} />)} title={t('dms.new')} aria-label={t('dms.new')}>＋</button>
        </div>
        {dms.map((c) => <ConvItem key={c.id} c={c} active={activeConv === c.id} />)}
        {dms.length === 0 && tab === 'all' && <button className="side-conv" onClick={() => openDialog((close) => <NewChatDialog onClose={close} />)}><span className="hash">＋</span><span className="grow muted">{t('dms.new')}</span></button>}
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

const isMuted = (c: ConversationDTO) => !!c.mutedUntil && Date.parse(c.mutedUntil) > Date.now();

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
