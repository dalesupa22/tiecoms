import { useEffect, useMemo, useState } from 'react';
import type { ConversationDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { navigate } from '../router.ts';
import { Avatar, OrgMark, conversationSubtitle, conversationTitle, counterpartOrg, orgById, personById, plural, timeLabel } from '../ui.tsx';
import { InviteDialog, NewGroupDialog, NewWorkspaceDialog } from './Dialogs.tsx';
import { SignOutButton, groupWorkspaces } from './Shell.tsx';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
}

function ConvCard({ c }: { c: ConversationDTO }) {
  const d = useClient((s) => s.data)!;
  const other = c.kind === 'direct' ? personById(d, c.memberIds.find((m) => m !== d.me.id)) : null;
  const org = other ? orgById(d, other.orgId) : c.workspaceId ? counterpartOrg(d, c.workspaceId) : null;
  return (
    <button className="card conv-card" onClick={() => navigate(`/c/${c.id}`)}>
      {other ? <Avatar person={other} org={org} size={38} /> : <OrgMark org={org} size={38} />}
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="row"><b className="ellipsis grow">{conversationTitle(d, c)}</b><span className="small muted">{timeLabel(c.lastMessageAt)}</span></span>
        <span className="small muted ellipsis" style={{ display: 'block' }}>{conversationSubtitle(d, c)}</span>
        <span className="small ellipsis" style={{ display: 'block', color: c.unread ? 'var(--ink)' : 'var(--muted)' }}>{c.lastMessagePreview ?? 'Sin mensajes todavía'}</span>
      </span>
      {c.unread > 0 && <span className="pill">{c.unread}</span>}
    </button>
  );
}

export function TodayScreen() {
  const d = useClient((s) => s.data)!;
  const pending = useClient((s) => s.pending);
  const [newWs, setNewWs] = useState(false);
  const unreadConvs = d.conversations.filter((c) => c.unread > 0);
  const unread = unreadConvs.reduce((n, c) => n + c.unread, 0);
  const recent = d.conversations.filter((c) => c.lastMessageAt).slice(0, 6);
  const orgsCount = new Set(d.workspaces.flatMap((w) => w.organizationIds)).size;
  const firstName = d.me.name.split(' ')[0];
  const rawDate = new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  const date = rawDate.charAt(0).toUpperCase() + rawDate.slice(1);

  return (
    <div className="page"><div className="page-narrow">
      <div className="small muted">{date}</div>
      <h1>{greeting()}, {firstName}.</h1>
      <div className="muted">{unread ? `${plural(unread, 'mensaje nuevo', 'mensajes nuevos')} en ${plural(unreadConvs.length, 'conversación', 'conversaciones')}` : 'Estás al día.'} · {plural(d.workspaces.length, 'espacio', 'espacios')} con {plural(Math.max(0, orgsCount - 1), 'empresa', 'empresas')}</div>
      <div className="stats">
        <div className="stat dark"><div className="eyebrow">Sin leer</div><div className="num">{unread}</div></div>
        <div className="stat dark"><div className="eyebrow">Te esperan</div><div className="num">{unreadConvs.length}</div></div>
        <div className="stat"><div className="eyebrow">Espacios</div><div className="num">{d.workspaces.length}</div></div>
        <div className="stat"><div className="eyebrow">En cola</div><div className="num">{pending.length}</div></div>
      </div>
      {d.workspaces.length === 0 ? (
        <div className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          <div className="serif" style={{ fontSize: 30 }}>Empieza con un cliente</div>
          <div className="muted">Crea un espacio para un tema de trabajo, invita a la otra empresa con un enlace y conversen en grupos con audiencia propia.</div>
          <button className="btn primary" onClick={() => setNewWs(true)}>＋ Nuevo espacio con un cliente</button>
        </div>
      ) : (
        <div className="cols">
          <section>
            <div className="row" style={{ marginBottom: 10 }}><span className="eyebrow grow">Te esperan</span><span className="small muted">{unreadConvs.length} conversaciones</span></div>
            <div className="list">
              {unreadConvs.length ? unreadConvs.map((c) => <ConvCard key={c.id} c={c} />) : <div className="empty">Nada pendiente. Buen momento para avanzar.</div>}
            </div>
          </section>
          <section>
            <div className="row" style={{ marginBottom: 10 }}><span className="eyebrow grow">Actividad reciente</span></div>
            <div className="list">{recent.map((c) => <ConvCard key={c.id} c={c} />)}</div>
            <button className="btn" style={{ marginTop: 12, width: '100%' }} onClick={() => setNewWs(true)}>＋ Nuevo espacio con un cliente</button>
          </section>
        </div>
      )}
      {newWs && <NewWorkspaceDialog onClose={() => setNewWs(false)} />}
    </div></div>
  );
}

export function InboxScreen() {
  const d = useClient((s) => s.data)!;
  const [filter, setFilter] = useState<'all' | 'unread' | 'direct'>('all');
  const [q, setQ] = useState('');
  const list = d.conversations.filter((c) => (filter === 'unread' ? c.unread > 0 : filter === 'direct' ? c.kind === 'direct' : true))
    .filter((c) => !q || conversationTitle(d, c).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <h1>Conversaciones</h1>
      <div className="row" style={{ margin: '14px 0', flexWrap: 'wrap' }}>
        <input className="input grow" style={{ minWidth: 180 }} placeholder="Buscar conversación o persona" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg" style={{ minWidth: 260 }}>
          {(['all', 'unread', 'direct'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f === 'all' ? 'Todas' : f === 'unread' ? 'Sin leer' : 'Directos'}</button>)}
        </div>
      </div>
      <div className="list">{list.length ? list.map((c) => <ConvCard key={c.id} c={c} />) : <div className="empty">No hay conversaciones con ese filtro.</div>}</div>
    </div></div>
  );
}

export function SpacesScreen() {
  const d = useClient((s) => s.data)!;
  const [newWs, setNewWs] = useState(false);
  const groups = useMemo(() => groupWorkspaces(d), [d]);
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <div className="row"><h1 className="grow">Espacios</h1><button className="btn primary small" onClick={() => setNewWs(true)}>＋ Nuevo</button></div>
      {groups.length === 0 && <div className="empty">Aún no tienes espacios.</div>}
      {groups.map((g) => (
        <section key={g.org?.id ?? 'none'} style={{ marginTop: 18 }}>
          <div className="row" style={{ marginBottom: 8 }}><OrgMark org={g.org} /><b>{g.org?.name ?? 'Sin empresa'}</b></div>
          <div className="list">
            {g.workspaces.map((w) => (
              <button key={w.id} className="card conv-card" onClick={() => navigate(`/w/${w.id}`)}>
                <span className="grow"><b>{w.name}</b><span className="small muted" style={{ display: 'block' }}>{w.department ?? ''} · {plural(d.conversations.filter((c) => c.workspaceId === w.id).length, 'grupo', 'grupos')}</span></span>
                <span className="muted">›</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {newWs && <NewWorkspaceDialog onClose={() => setNewWs(false)} />}
    </div></div>
  );
}

const ROLE: Record<string, string> = { lead: 'Lidera', admin: 'Administra', member: 'Participa', guest: 'Tercero' };

export function WorkspaceScreen({ id }: { id: string }) {
  const d = useClient((s) => s.data)!;
  const ws = d.workspaces.find((w) => w.id === id);
  const [dialog, setDialog] = useState<'group' | 'invite' | null>(null);
  if (!ws) return <div className="page"><div className="empty">Este espacio no existe o está fuera de tu alcance.</div></div>;
  const convs = d.conversations.filter((c) => c.workspaceId === id);
  const orgs = ws.organizationIds.map((o) => orgById(d, o)).filter(Boolean);
  const members = ws.memberIds.map((m) => personById(d, m)).filter(Boolean);
  const byOrg = new Map<string, typeof members>();
  for (const p of members) { const k = p!.orgId ?? 'guest'; byOrg.set(k, [...(byOrg.get(k) ?? []), p]); }
  const isGuest = ws.myRole === 'guest';

  return (
    <div className="page"><div className="page-narrow">
      <button className="btn ghost small only-mobile" onClick={() => navigate('/espacios')}>‹ Espacios</button>
      <div className="row" style={{ gap: 6, marginTop: 6 }}>{orgs.map((o) => <OrgMark key={o!.id} org={o} size={24} />)}</div>
      <h1>{ws.name}</h1>
      <div className="muted">{[ws.department, orgs.map((o) => o!.name).join(' · '), ROLE[ws.myRole]].filter(Boolean).join(' · ')}</div>
      {!isGuest && (
        <div className="row" style={{ margin: '16px 0 24px', flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => setDialog('invite')}>＋ Invitar empresa o tercero</button>
          <button className="btn" onClick={() => setDialog('group')}>＋ Nuevo grupo</button>
        </div>
      )}
      <div className="cols">
        <section>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Tus grupos en este espacio</div>
          <div className="list">
            {convs.map((c) => (
              <button key={c.id} className="card conv-card" onClick={() => navigate(`/c/${c.id}`)}>
                <span className="mark" style={{ width: 34, height: 34, background: c.kind === 'internal' ? '#fff' : 'var(--paper-3)', border: '1px solid var(--line)', fontSize: 14 }}>{c.kind === 'internal' ? '◌' : c.level === 'directivo' ? '◆' : '#'}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="row"><b className="grow ellipsis">{c.name}</b><span className="small muted">{timeLabel(c.lastMessageAt)}</span></span>
                  <span className="small muted ellipsis" style={{ display: 'block' }}>{c.kind === 'internal' ? 'Solo tu empresa' : c.level === 'directivo' ? 'Directivo' : 'Operativo'} · {plural(c.memberIds.length, 'participante', 'participantes')}</span>
                </span>
                {c.unread > 0 && <span className="pill">{c.unread}</span>}
              </button>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 10 }}>Solo ves los grupos en los que participas; los demás no revelan su nombre.</div>
        </section>
        <section>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Participantes {isGuest ? '' : `· ${members.length}`}</div>
          {isGuest && <div className="hint">Como tercero invitado ves solo a las personas de tus grupos.</div>}
          {[...byOrg.entries()].map(([orgId, people]) => (
            <div key={orgId} className="card" style={{ padding: 12, marginBottom: 10 }}>
              <div className="row" style={{ marginBottom: 6 }}><OrgMark org={orgById(d, orgId)} size={22} /><b>{orgById(d, orgId)?.name ?? 'Terceros invitados'}</b></div>
              {people.map((p) => (
                <div key={p!.id} className="member">
                  <Avatar person={p} org={orgById(d, p!.orgId)} size={30} />
                  <span className="grow" style={{ minWidth: 0 }}><span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>{p!.name}</span><span className="small muted ellipsis" style={{ display: 'block' }}>{p!.title ?? ''}</span></span>
                  {p!.id !== d.me.id && <button className="btn ghost small" title="Mensaje directo" onClick={() => client.openDirect(p!.id).then((r) => navigate(`/c/${r.id}`))}>✉</button>}
                </div>
              ))}
            </div>
          ))}
        </section>
      </div>
      {dialog === 'group' && <NewGroupDialog workspaceId={id} onClose={() => setDialog(null)} />}
      {dialog === 'invite' && <InviteDialog workspaceId={id} onClose={() => setDialog(null)} />}
    </div></div>
  );
}

export function PeopleScreen() {
  const d = useClient((s) => s.data)!;
  const [q, setQ] = useState('');
  const people = d.people.filter((p) => p.id !== d.me.id && (!q || `${p.name} ${p.title ?? ''} ${orgById(d, p.orgId)?.name ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const byOrg = new Map<string, typeof people>();
  for (const p of people) { const k = p.kind === 'agent' ? 'agents' : p.orgId ?? 'guest'; byOrg.set(k, [...(byOrg.get(k) ?? []), p]); }
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 860 }}>
      <h1>Participantes</h1>
      <div className="muted">Personas con las que compartes espacios. Solo ves a quien está dentro de tu alcance.</div>
      <input className="input" style={{ margin: '14px 0' }} placeholder="Buscar por nombre, cargo o empresa" value={q} onChange={(e) => setQ(e.target.value)} />
      {people.length === 0 && <div className="empty">Aún no compartes espacios con otras personas.</div>}
      {[...byOrg.entries()].map(([k, list]) => (
        <section key={k} style={{ marginBottom: 18 }}>
          <div className="row" style={{ marginBottom: 8 }}>{k !== 'agents' && k !== 'guest' && <OrgMark org={orgById(d, k)} />}<b>{k === 'agents' ? 'Agentes' : k === 'guest' ? 'Terceros invitados' : orgById(d, k)?.name}</b><span className="small muted">{list.length}</span></div>
          <div className="list">
            {list.map((p) => (
              <div key={p.id} className="card conv-card">
                <Avatar person={p} org={orgById(d, p.orgId)} size={36} />
                <span className="grow" style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{p.name}</b><span className="small muted ellipsis" style={{ display: 'block' }}>{[p.title, p.area].filter(Boolean).join(' · ')}{p.guest && p.guestUntil ? ` · hasta ${new Date(p.guestUntil).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}` : ''}</span></span>
                <button className="btn small" onClick={() => client.openDirect(p.id).then((r) => navigate(`/c/${r.id}`))}>Mensaje</button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div></div>
  );
}

export function SettingsScreen() {
  const d = useClient((s) => s.data)!;
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof client.sessions>> | null>(null);
  const load = () => client.sessions().then(setSessions).catch(() => {});
  useEffect(() => { void load(); }, []);
  const myOrg = orgById(d, d.me.primaryOrgId);
  const PLAT: Record<string, string> = { web: 'Web', macos: 'macOS', windows: 'Windows', android: 'Android', ios: 'iOS' };
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 720 }}>
      <h1>Tu cuenta</h1>
      <div className="card" style={{ padding: 18, display: 'flex', gap: 14, alignItems: 'center', margin: '14px 0 24px' }}>
        <Avatar person={personById(d, d.me.id)} org={myOrg} size={48} />
        <div className="grow"><b>{d.me.name}</b><div className="small muted">{d.me.email} · {[d.me.title, myOrg?.name].filter(Boolean).join(' · ')}</div></div>
        <SignOutButton />
      </div>
      <div className="eyebrow" style={{ marginBottom: 10 }}>Dispositivos con sesión abierta</div>
      <div className="list">
        {sessions?.sessions.map((s) => (
          <div key={s.id} className="card conv-card">
            <span className="grow"><b>{s.deviceName}</b> <span className="tag">{PLAT[s.platform] ?? s.platform}</span><span className="small muted" style={{ display: 'block' }}>Última actividad {new Date(s.lastSeenAt).toLocaleString('es-CO')}</span></span>
            {s.id === sessions.current ? <span className="tag">Este dispositivo</span> : <button className="btn small" onClick={() => client.revokeSession(s.id).then(load)}>Cerrar</button>}
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 18 }}>TieComs para Web · próximamente macOS, Windows, Android e iOS con la misma cuenta y los mismos no leídos.</div>
    </div></div>
  );
}
