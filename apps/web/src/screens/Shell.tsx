import { useMemo, useState, type ReactNode } from 'react';
import type { BootstrapDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { asset, navigate, type Route } from '../router.ts';
import { Avatar, OrgMark, conversationTitle, counterpartOrg, orgById, personById } from '../ui.tsx';
import { NewWorkspaceDialog } from './Dialogs.tsx';

const NAV = [
  { name: 'today', label: 'Hoy', ico: '◑', to: '/' },
  { name: 'inbox', label: 'Conversaciones', ico: '◍', to: '/conversaciones' },
  { name: 'people', label: 'Participantes', ico: '◎', to: '/participantes' },
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
  const unreadTotal = d.conversations.reduce((n, c) => n + c.unread, 0);
  const me = personById(d, d.me.id);
  const myOrg = orgById(d, d.me.primaryOrgId);
  const activeConv = route.name === 'conversation' ? route.id : null;
  const activeWs = route.name === 'workspace' ? route.id : null;

  return (
    <aside className="side">
      <div className="side-brand">
        <img src={asset("/tiecoms-mark.svg")} alt="TieComs" width={118} height={26} />
        <span className="eyebrow" style={{ fontSize: 10 }}>Tu red</span>
      </div>
      <nav className="nav">
        {NAV.map((n) => (
          <button key={n.name} className={`nav-item ${route.name === n.name ? 'active' : ''}`} onClick={() => navigate(n.to)}>
            <span className="ico">{n.ico}</span><span className="grow">{n.label}</span>
            {n.name === 'today' && unreadTotal > 0 && <span className="pill">{unreadTotal}</span>}
          </button>
        ))}
      </nav>
      <div className="side-scroll">
        <div className="row" style={{ padding: '6px 10px 2px' }}>
          <span className="eyebrow grow">Empresas y espacios</span>
          <button className="btn ghost small" onClick={() => setNewWs(true)} title="Nuevo espacio con un cliente">＋</button>
        </div>
        {groups.length === 0 && <div className="hint" style={{ padding: '6px 10px' }}>Crea tu primer espacio de trabajo con otra empresa.</div>}
        {groups.map((g) => (
          <div key={g.org?.id ?? 'none'}>
            <div className="side-org"><OrgMark org={g.org} /><span className="ellipsis">{g.org?.name ?? 'Sin empresa'}</span></div>
            <div className="side-ws">
              {g.workspaces.map((w) => {
                const convs = d.conversations.filter((c) => c.workspaceId === w.id);
                return (
                  <div key={w.id}>
                    <button className="side-ws-title" style={{ width: '100%', background: activeWs === w.id ? 'var(--card)' : undefined }} onClick={() => navigate(`/w/${w.id}`)}>
                      <span className="grow ellipsis">{w.name}</span>
                    </button>
                    {convs.map((c) => (
                      <button key={c.id} className={`side-conv ${activeConv === c.id ? 'active' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => navigate(`/c/${c.id}`)}>
                        <span className="hash">{c.kind === 'internal' ? '◌' : c.level === 'directivo' ? '◆' : '#'}</span>
                        <span className="grow ellipsis">{conversationTitle(d, c)}</span>
                        {c.unread > 0 && <span className="pill">{c.unread}</span>}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {directs.length > 0 && (
          <>
            <div className="eyebrow" style={{ padding: '14px 10px 4px' }}>Directos</div>
            {directs.map((c) => {
              const other = personById(d, c.memberIds.find((m) => m !== d.me.id));
              return (
                <button key={c.id} className={`side-conv ${activeConv === c.id ? 'active' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => navigate(`/c/${c.id}`)}>
                  <Avatar person={other} org={orgById(d, other?.orgId)} size={22} />
                  <span className="grow ellipsis">{conversationTitle(d, c)}</span>
                  {c.unread > 0 && <span className="pill">{c.unread}</span>}
                </button>
              );
            })}
          </>
        )}
      </div>
      <button className="side-foot" style={{ border: 0, borderTop: '1px solid var(--line)', background: 'transparent', textAlign: 'left' }} onClick={() => navigate('/ajustes')}>
        <Avatar person={me} org={myOrg} size={34} />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="ellipsis" style={{ display: 'block', fontWeight: 700 }}>{d.me.name}</span>
          <span className="ellipsis small muted" style={{ display: 'block' }}>{myOrg?.name}</span>
        </span>
        <span className="muted">⚙</span>
      </button>
      {newWs && <NewWorkspaceDialog onClose={() => setNewWs(false)} />}
    </aside>
  );
}

function MobileTabs({ route }: { route: Route }) {
  const unread = useClient((s) => s.data?.conversations.reduce((n, c) => n + c.unread, 0) ?? 0);
  const tabs = [
    { name: 'today', label: 'Hoy', ico: '◑', to: '/' },
    { name: 'inbox', label: 'Chats', ico: '◍', to: '/conversaciones' },
    { name: 'spaces', label: 'Espacios', ico: '▦', to: '/espacios' },
    { name: 'people', label: 'Personas', ico: '◎', to: '/participantes' },
  ];
  return (
    <nav className="tabs" aria-label="Navegación principal">
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
        {connection !== 'online' && <div className="conn" role="status">{connection === 'connecting' ? 'Conectando…' : 'Sin conexión. Tus mensajes quedan en cola y se envían al volver.'}</div>}
        {children}
      </main>
      <MobileTabs route={route} />
    </div>
  );
}

export function SignOutButton() {
  return <button className="btn" onClick={() => client.logout().then(() => navigate('/login', true))}>Cerrar sesión</button>;
}
