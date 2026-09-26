import { useMemo, useState, type ReactNode } from 'react';
import type { BootstrapDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { asset, navigate, type Route } from '../router.ts';
import { Avatar, ConvAvatar, OrgMark, badgeColor, conversationTitle, counterpartOrg, orgById, personById } from '../ui.tsx';
import { hangsUnderOrigin, sidesOf } from './Side.tsx';
import { MentionsInbox } from './Mentions.tsx';
import { InviteDialog, NewGroupDialog, NewWorkspaceDialog } from './Dialogs.tsx';
import { conversationMenu, openDialog, workspaceMenu } from '../actions.tsx';
import { menuProps } from '../menu.tsx';
import { newEvent } from './Calendar.tsx';
import type { ConversationDTO, WorkspaceDTO } from '@tiecoms/contracts';
import { t } from '../i18n.ts';
import { openAccountMenu } from './Profile.tsx';
import { NewChatDialog, StackedAvatars } from './Chats.tsx';

const NAV = [
  { name: 'today', label: 'nav.today', ico: '◑', to: '/' },
  { name: 'inbox', label: 'nav.inbox', ico: '◍', to: '/conversaciones' },
  { name: 'agenda', label: 'nav.agenda', ico: '▤', to: '/agenda' },
  { name: 'issues', label: 'nav.issues', ico: '◆', to: '/asuntos' },
  { name: 'trazo', label: 'nav.trazo', ico: '⑂', to: '/trazo' },
  { name: 'people', label: 'nav.people', ico: '◎', to: '/participantes' },
  { name: 'files', label: 'nav.files', ico: '▣', to: '/archivos' },
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
export const HOME_TABS: HomeTab[] = ['all', 'unread', 'mentions', 'issues', 'chats', 'sides'];
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
  const [newWs, setNewWs] = useState(false);
  const [tab, setTabState] = useState<HomeTab>(storedTab);
  const setTab = (v: HomeTab) => { setTabState(v); try { localStorage.setItem(TAB_KEY, v); } catch {} };
  const groups = useMemo(() => sortHome(d, groupWorkspaces(d)), [d]);
  // Una conversación se muestra si cumple el filtro o si alguna lateral que cuelga de ella lo cumple.
  const shows = (c: ConversationDTO) => matchesTab(c, tab) || sidesOf(d, c.id).some((x) => matchesTab(x, tab));
  // Las laterales cuelgan de su conversación de origen (si la veo); si no, van con los chats.
  const directs = d.conversations.filter((c) => (c.kind === 'direct' || c.kind === 'multi') && !hangsUnderOrigin(d, c) && shows(c))
    .sort(compareConversations);
  const unreadTotal = d.conversations.reduce((n, c) => n + (isMuted(c) ? 0 : c.unread), 0);
  const pinnedConvs = d.conversations.filter((c) => c.pinnedAt && shows(c)).sort((a, b) => (a.pinnedAt ?? '').localeCompare(b.pinnedAt ?? ''));
  const pinnedWs = tab === 'all' ? d.workspaces.filter((w) => w.pinnedAt) : [];
  const visibleGroups = groups
    .map((g) => ({ ...g, workspaces: g.workspaces.filter((w) => tab === 'all' || d.conversations.some((c) => c.workspaceId === w.id && shows(c))) }))
    .filter((g) => g.workspaces.length > 0);
  const nothing = tab !== 'all' && !visibleGroups.length && !directs.length;
  const me = personById(d, d.me.id);
  const myOrg = orgById(d, d.me.primaryOrgId);
  const activeConv = route.name === 'conversation' ? route.id : null;
  const activeWs = route.name === 'workspace' ? route.id : null;

  return (
    <aside className="side">
      <div className="side-brand">
        <img src={asset("/tiecoms-mark.svg")} alt="TieComs" width={118} height={26} />
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
        {nothing && <div className="home-empty">{t(`home.empty.${tab}` as 'home.empty.all')}</div>}
        <div className="row" style={{ padding: '6px 10px 2px' }}>
          <span className="eyebrow grow">{t('side.companies')}</span>
          <button className="btn ghost small" onClick={() => setNewWs(true)} title={t('side.newSpace')} aria-label={t('side.newSpace')}>＋</button>
        </div>
        {(pinnedConvs.length > 0 || pinnedWs.length > 0) && (
          <div className="side-pinned">
            <div className="eyebrow" style={{ padding: '4px 10px' }}>📌 {t('side.pinned')}</div>
            {pinnedWs.map((w) => <WsTitle key={w.id} w={w} active={activeWs === w.id} />)}
            {pinnedConvs.map((c) => <ConvItem key={c.id} c={c} active={activeConv === c.id} showWs />)}
          </div>
        )}
        {groups.length === 0 && <div className="hint" style={{ padding: '6px 10px' }}>{t('side.empty')}</div>}
        {visibleGroups.map((g) => (
          <div key={g.org?.id ?? 'none'}>
            <div className="side-org"><OrgMark org={g.org} /><span className="ellipsis">{g.org?.name ?? t('common.noCompany')}</span></div>
            <div className="side-ws">
              {g.workspaces.map((w) => {
                const convs = d.conversations.filter((c) => c.workspaceId === w.id && shows(c)).sort(compareConversations);
                return (
                  <div key={w.id}>
                    <WsTitle w={w} active={activeWs === w.id} />
                    {convs.map((c) => <ConvWithSides key={c.id} c={c} activeConv={activeConv} tab={tab} />)}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div className="row" style={{ padding: '14px 10px 2px' }}>
          <span className="eyebrow grow">{t('side.directs')}</span>
          <button className="btn ghost small" onClick={() => openDialog((close) => <NewChatDialog onClose={close} />)} title={t('chat.new')} aria-label={t('chat.new')}>＋</button>
        </div>
        {directs.map((c) => <ConvWithSides key={c.id} c={c} activeConv={activeConv} tab={tab} />)}
        {directs.length === 0 && tab === 'all' && <button className="side-conv" onClick={() => openDialog((close) => <NewChatDialog onClose={close} />)}><span className="hash">＋</span><span className="grow muted">{t('chat.new')}</span></button>}
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
      {newWs && <NewWorkspaceDialog onClose={() => setNewWs(false)} />}
    </aside>
  );
}

/** Conversación y, debajo con sangría, sus laterales. */
function ConvWithSides({ c, activeConv, tab = 'all' }: { c: ConversationDTO; activeConv: string | null; tab?: HomeTab }) {
  const d = useClient((s) => s.data)!;
  const sides = sidesOf(d, c.id).filter((x) => tab === 'all' || matchesTab(x, tab));
  return (
    <>
      <ConvItem c={c} active={activeConv === c.id} />
      {sides.length > 0 && <div className="side-sides">{sides.map((x) => <ConvItem key={x.id} c={x} active={activeConv === x.id} />)}</div>}
    </>
  );
}

const isMuted = (c: ConversationDTO) => !!c.mutedUntil && Date.parse(c.mutedUntil) > Date.now();

function ConvItem({ c, active, showWs = false }: { c: ConversationDTO; active: boolean; showWs?: boolean }) {
  const d = useClient((s) => s.data)!;
  const muted = isMuted(c);
  const other = c.kind === 'direct' ? personById(d, c.memberIds.find((m) => m !== d.me.id)) : null;
  const ws = showWs ? d.workspaces.find((w) => w.id === c.workspaceId) : null;
  return (
    <button className={`side-conv ${active ? 'active' : ''} ${c.unread && !muted ? 'unread' : ''} ${muted ? 'is-muted' : ''}`} onClick={() => navigate(`/c/${c.id}`)}
      {...menuProps(() => conversationMenu(c, { onNewMeeting: () => newEvent({ conversationId: c.id }) }))}>
      {other ? <Avatar person={other} org={orgById(d, other.orgId)} size={22} />
        : <ConvAvatar c={c} size={22} fallback={c.kind === 'multi' && c.deriveKind !== 'side' ? <StackedAvatars c={c} size={20} /> : undefined} />}
      <span className="grow ellipsis">{conversationTitle(d, c)}{ws ? <span className="muted small"> · {ws.name}</span> : null}</span>
      {muted && <span className="small" title={t('side.muted')}>🔕</span>}
      {(c.unreadMentions ?? 0) > 0 && <span className="pill mention-pill" title={t('mention.youMentioned')}>@</span>}
      {c.unread > 0 && <span className={`pill ${muted ? 'is-muted' : ''}`} style={{ background: badgeColor(c.workspaceId ? counterpartOrg(d, c.workspaceId) : null) }}>{c.unread}</span>}
    </button>
  );
}

function WsTitle({ w, active }: { w: WorkspaceDTO; active: boolean }) {
  return (
    <button className="side-ws-title" style={{ width: '100%', background: active ? 'var(--card)' : undefined }} onClick={() => navigate(`/w/${w.id}`)}
      {...menuProps(() => workspaceMenu(w, {
        onNewGroup: () => openDialog((close) => <NewGroupDialog workspaceId={w.id} onClose={close} />),
        onInvite: () => openDialog((close) => <InviteDialog workspaceId={w.id} onClose={close} />),
      }))}>
      <span className="grow ellipsis">{w.pinnedAt ? '📌 ' : ''}{w.name}</span>
    </button>
  );
}

function MobileTabs({ route }: { route: Route }) {
  const unread = useClient((s) => s.data?.conversations.reduce((n, c) => n + (isMuted(c) ? 0 : c.unread), 0) ?? 0);
  const tabs = [
    { name: 'today', label: t('nav.today'), ico: '◑', to: '/' },
    { name: 'inbox', label: t('nav.chats'), ico: '◍', to: '/conversaciones' },
    { name: 'agenda', label: t('nav.agenda'), ico: '▤', to: '/agenda' },
    { name: 'issues', label: t('nav.issues'), ico: '◆', to: '/asuntos' },
    { name: 'spaces', label: t('nav.spaces'), ico: '▦', to: '/espacios' },
  ];
  return (
    <nav className="tabs" aria-label={t('nav.mainNav')}>
      {tabs.map((t) => (
        <button key={t.name} className={route.name === t.name ? 'on' : ''} onClick={() => navigate(t.to)}>
          <span className="ico">{t.ico}</span>{t.label}
          {t.name === 'inbox' && unread > 0 && <span className="pill">{unread}</span>}
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
