import { useMemo, useState, type ReactNode } from 'react';
import type { BootstrapDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { asset, navigate, type Route } from '../router.ts';
import { Avatar, OrgMark, conversationTitle, counterpartOrg, orgById, personById } from '../ui.tsx';
import { InviteDialog, NewGroupDialog, NewWorkspaceDialog } from './Dialogs.tsx';
import { conversationMenu, openDialog, workspaceMenu } from '../actions.tsx';
import { menuProps } from '../menu.tsx';
import { newEvent } from './Calendar.tsx';
import type { ConversationDTO, WorkspaceDTO } from '@tiecoms/contracts';
import { t } from '../i18n.ts';
import { openAccountMenu } from './Profile.tsx';

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

function Sidebar({ route }: { route: Route }) {
  const d = useClient((s) => s.data)!;
  const [newWs, setNewWs] = useState(false);
  const groups = useMemo(() => groupWorkspaces(d), [d]);
  const directs = d.conversations.filter((c) => c.kind === 'direct');
  const unreadTotal = d.conversations.reduce((n, c) => n + (isMuted(c) ? 0 : c.unread), 0);
  const pinnedConvs = d.conversations.filter((c) => c.pinnedAt).sort((a, b) => (a.pinnedAt ?? '').localeCompare(b.pinnedAt ?? ''));
  const pinnedWs = d.workspaces.filter((w) => w.pinnedAt);
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
        {groups.map((g) => (
          <div key={g.org?.id ?? 'none'}>
            <div className="side-org"><OrgMark org={g.org} /><span className="ellipsis">{g.org?.name ?? t('common.noCompany')}</span></div>
            <div className="side-ws">
              {g.workspaces.map((w) => {
                const convs = d.conversations.filter((c) => c.workspaceId === w.id);
                return (
                  <div key={w.id}>
                    <WsTitle w={w} active={activeWs === w.id} />
                    {convs.map((c) => <ConvItem key={c.id} c={c} active={activeConv === c.id} />)}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {directs.length > 0 && (
          <>
            <div className="eyebrow" style={{ padding: '14px 10px 4px' }}>{t('side.directs')}</div>
            {directs.map((c) => <ConvItem key={c.id} c={c} active={activeConv === c.id} />)}
          </>
        )}
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
        : <span className="hash">{c.parentId ? '⑂' : c.kind === 'internal' ? '◌' : c.level === 'directivo' ? '◆' : '#'}</span>}
      <span className="grow ellipsis">{conversationTitle(d, c)}{ws ? <span className="muted small"> · {ws.name}</span> : null}</span>
      {muted && <span className="small" title={t('side.muted')}>🔕</span>}
      {c.unread > 0 && <span className={`pill ${muted ? 'is-muted' : ''}`}>{c.unread}</span>}
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
