import { useEffect, useMemo, useState } from 'react';
import type { ConversationDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, getLang, langPreference, locale, setLang, t, tn, useLang, type Lang } from '../i18n.ts';
import { navigate } from '../router.ts';
import { Avatar, OrgMark, conversationSubtitle, conversationTitle, counterpartOrg, orgById, personById, previewText, timeLabel } from '../ui.tsx';
import { InviteDialog, NewGroupDialog, NewWorkspaceDialog } from './Dialogs.tsx';
import { IssueDrawer, IssueRow, isClosed } from './Issues.tsx';
import { TodayAgenda, newEvent } from './Calendar.tsx';
import { RemindersSection } from './Bring.tsx';
import { askNotifications, conversationMenu, personMenu } from '../actions.tsx';
import { menuProps } from '../menu.tsx';
import { SignOutButton, groupWorkspaces } from './Shell.tsx';

function greeting() {
  const h = new Date().getHours();
  return t(h < 12 ? 'today.morning' : h < 19 ? 'today.afternoon' : 'today.evening');
}

function ConvCard({ c }: { c: ConversationDTO }) {
  const d = useClient((s) => s.data)!;
  const other = c.kind === 'direct' ? personById(d, c.memberIds.find((m) => m !== d.me.id)) : null;
  const org = other ? orgById(d, other.orgId) : c.workspaceId ? counterpartOrg(d, c.workspaceId) : null;
  return (
    <button className="card conv-card" onClick={() => navigate(`/c/${c.id}`)} {...menuProps(() => conversationMenu(c, { onNewMeeting: () => newEvent({ conversationId: c.id }) }))}>
      {other ? <Avatar person={other} org={org} size={38} /> : <OrgMark org={org} size={38} />}
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="row"><b className="ellipsis grow">{conversationTitle(d, c)}</b><span className="small muted">{timeLabel(c.lastMessageAt)}</span></span>
        <span className="small muted ellipsis" style={{ display: 'block' }}>{conversationSubtitle(d, c)}</span>
        <span className="small ellipsis" style={{ display: 'block', color: c.unread ? 'var(--ink)' : 'var(--muted)' }}>{previewText(c.lastMessagePreview) ?? t('conv.noMessages')}</span>
      </span>
      {c.unread > 0 && <span className="pill">{c.unread}</span>}
    </button>
  );
}

export function TodayScreen() {
  const d = useClient((s) => s.data)!;
  const pending = useClient((s) => s.pending);
  const issues = useClient((s) => s.issues);
  const [newWs, setNewWs] = useState(false);
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  useEffect(() => { client.loadIssues({ mine: true, open: true }).catch(() => {}); }, []);
  const visible = new Set(d.conversations.map((c) => c.id));
  const mine = Object.values(issues).filter((i) => i.ownerId === d.me.id && !isClosed(i) && visible.has(i.conversationId))
    .sort((a, b) => (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'));
  const unreadConvs = d.conversations.filter((c) => c.unread > 0);
  const unread = unreadConvs.reduce((n, c) => n + c.unread, 0);
  const recent = d.conversations.filter((c) => c.lastMessageAt).slice(0, 6);
  const orgsCount = new Set(d.workspaces.flatMap((w) => w.organizationIds)).size;
  const firstName = d.me.name.split(' ')[0];
  const rawDate = new Date().toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  const date = rawDate.charAt(0).toUpperCase() + rawDate.slice(1);

  return (
    <div className="page"><div className="page-narrow">
      <div className="small muted">{date}</div>
      <h1>{greeting()}, {firstName}.</h1>
      <div className="muted">
        {unread ? t('today.summary', { messages: tn(unread, 'n.newMessage', 'n.newMessages'), conversations: tn(unreadConvs.length, 'n.conversation', 'n.conversations') }) : t('today.upToDate')}
        {' · '}{t('today.spacesWith', { spaces: tn(d.workspaces.length, 'n.space', 'n.spaces'), companies: tn(Math.max(0, orgsCount - 1), 'n.company', 'n.companies') })}
      </div>
      <div className="stats">
        <div className="stat dark"><div className="eyebrow">{t('today.unread')}</div><div className="num">{unread}</div></div>
        <div className="stat dark"><div className="eyebrow">{t('today.waiting')}</div><div className="num">{unreadConvs.length}</div></div>
        <div className="stat"><div className="eyebrow">{t('today.spaces')}</div><div className="num">{d.workspaces.length}</div></div>
        <div className="stat"><div className="eyebrow">{t('issue.yours')}</div><div className="num">{mine.length}</div></div>
      </div>
      {d.workspaces.length === 0 ? (
        <div className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          <div className="serif" style={{ fontSize: 30 }}>{t('today.startTitle')}</div>
          <div className="muted">{t('today.startBody')}</div>
          <button className="btn primary" onClick={() => setNewWs(true)}>{t('today.newSpace')}</button>
        </div>
      ) : (
        <div className="cols">
          <section>
            <div className="row" style={{ marginBottom: 10 }}><span className="eyebrow grow">{t('today.waiting')}</span><span className="small muted">{tn(unreadConvs.length, 'n.conversation', 'n.conversations')}</span></div>
            <div className="list">
              {unreadConvs.length ? unreadConvs.map((c) => <ConvCard key={c.id} c={c} />) : <div className="empty">{t('today.nothing')}</div>}
            </div>
          </section>
          <section>
            <TodayAgenda />
            <RemindersSection />
            <div className="row" style={{ marginBottom: 10 }}><span className="eyebrow grow">{t('issue.yours')}</span><button className="btn ghost small" onClick={() => navigate('/asuntos')}>{t('nav.issues')} ›</button></div>
            <div className="list" style={{ marginBottom: 20 }}>
              {mine.length ? mine.slice(0, 5).map((i) => <IssueRow key={i.id} i={i} onOpen={setOpenIssue} />) : <div className="empty">{t('issue.yoursEmpty')}</div>}
            </div>
            <div className="row" style={{ marginBottom: 10 }}><span className="eyebrow grow">{t('today.recent')}</span></div>
            <div className="list">{recent.map((c) => <ConvCard key={c.id} c={c} />)}</div>
            <button className="btn" style={{ marginTop: 12, width: '100%' }} onClick={() => setNewWs(true)}>{t('today.newSpace')}</button>
          </section>
        </div>
      )}
      {newWs && <NewWorkspaceDialog onClose={() => setNewWs(false)} />}
      {openIssue && <IssueDrawer id={openIssue} onClose={() => setOpenIssue(null)} />}
      {pending.length > 0 && <div className="hint" style={{ marginTop: 16 }}>{t('today.queued')}: {pending.length}</div>}
    </div></div>
  );
}

export function InboxScreen() {
  const d = useClient((s) => s.data)!;
  const [filter, setFilter] = useState<'all' | 'unread' | 'direct'>('all');
  const [q, setQ] = useState('');
  const list = d.conversations.filter((c) => (filter === 'unread' ? c.unread > 0 : filter === 'direct' ? c.kind === 'direct' : true))
    .filter((c) => !q || conversationTitle(d, c).toLowerCase().includes(q.toLowerCase()));
  const label = { all: t('inbox.all'), unread: t('inbox.unread'), direct: t('inbox.directs') };
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <h1>{t('nav.inbox')}</h1>
      <div className="row" style={{ margin: '14px 0', flexWrap: 'wrap' }}>
        <input className="input grow" style={{ minWidth: 180 }} placeholder={t('inbox.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg" style={{ minWidth: 260 }}>
          {(['all', 'unread', 'direct'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{label[f]}</button>)}
        </div>
      </div>
      <div className="list">{list.length ? list.map((c) => <ConvCard key={c.id} c={c} />) : <div className="empty">{t('inbox.empty')}</div>}</div>
    </div></div>
  );
}

export function SpacesScreen() {
  const d = useClient((s) => s.data)!;
  const [newWs, setNewWs] = useState(false);
  const groups = useMemo(() => groupWorkspaces(d), [d]);
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <div className="row"><h1 className="grow">{t('nav.spaces')}</h1><button className="btn small" onClick={() => navigate('/participantes')}>{t('nav.people')}</button><button className="btn primary small" onClick={() => setNewWs(true)}>{t('spaces.new')}</button></div>
      {groups.length === 0 && <div className="empty">{t('spaces.empty')}</div>}
      {groups.map((g) => (
        <section key={g.org?.id ?? 'none'} style={{ marginTop: 18 }}>
          <div className="row" style={{ marginBottom: 8 }}><OrgMark org={g.org} /><b>{g.org?.name ?? t('common.noCompany')}</b></div>
          <div className="list">
            {g.workspaces.map((w) => (
              <button key={w.id} className="card conv-card" onClick={() => navigate(`/w/${w.id}`)}>
                <span className="grow"><b>{w.name}</b><span className="small muted" style={{ display: 'block' }}>{[w.department, tn(d.conversations.filter((c) => c.workspaceId === w.id).length, 'n.group', 'n.groups')].filter(Boolean).join(' · ')}</span></span>
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

const ROLE_KEY = { lead: 'role.Lead', admin: 'role.Admin', member: 'role.Member', guest: 'role.Guest' } as const;

export function WorkspaceScreen({ id }: { id: string }) {
  const d = useClient((s) => s.data)!;
  const ws = d.workspaces.find((w) => w.id === id);
  const [dialog, setDialog] = useState<'group' | 'invite' | null>(null);
  const issues = useClient((s) => s.issues);
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  useEffect(() => { client.loadIssues({ workspaceId: id }).catch(() => {}); }, [id]);
  if (!ws) return <div className="page"><div className="empty">{t('ws.notFound')}</div></div>;
  const convs = d.conversations.filter((c) => c.workspaceId === id);
  const orgs = ws.organizationIds.map((o) => orgById(d, o)).filter(Boolean);
  const members = ws.memberIds.map((m) => personById(d, m)).filter(Boolean);
  const byOrg = new Map<string, typeof members>();
  for (const p of members) { const k = p!.orgId ?? 'guest'; byOrg.set(k, [...(byOrg.get(k) ?? []), p]); }
  const isGuest = ws.myRole === 'guest';

  return (
    <div className="page"><div className="page-narrow">
      <button className="btn ghost small only-mobile" onClick={() => navigate('/espacios')}>{t('spaces.back')}</button>
      <div className="row" style={{ gap: 6, marginTop: 6 }}>{orgs.map((o) => <OrgMark key={o!.id} org={o} size={24} />)}</div>
      <h1>{ws.name}</h1>
      <div className="muted">{[ws.department, orgs.map((o) => o!.name).join(' · '), t(ROLE_KEY[ws.myRole])].filter(Boolean).join(' · ')}</div>
      {!isGuest && (
        <div className="row" style={{ margin: '16px 0 24px', flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => setDialog('invite')}>{t('ws.invite')}</button>
          <button className="btn" onClick={() => setDialog('group')}>{t('ws.newGroup')}</button>
          <button className="btn" onClick={() => newEvent({ conversationId: convs.find((c) => c.canPost && c.kind !== 'direct')?.id })}>{t('cal.new')}</button>
        </div>
      )}
      <div className="cols">
        <section>
          <div className="eyebrow" style={{ marginBottom: 10 }}>{t('ws.yourGroups')}</div>
          <div className="list">
            {convs.map((c) => (
              <button key={c.id} className="card conv-card" onClick={() => navigate(`/c/${c.id}`)} {...menuProps(() => conversationMenu(c, { onNewMeeting: () => newEvent({ conversationId: c.id }) }))}>
                <span className="mark" style={{ width: 34, height: 34, background: c.kind === 'internal' ? '#fff' : 'var(--paper-3)', border: '1px solid var(--line)', fontSize: 14 }}>{c.parentId ? '⑂' : c.kind === 'internal' ? '◌' : c.level === 'directivo' ? '◆' : '#'}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="row"><b className="grow ellipsis">{conversationTitle(d, c)}</b><span className="small muted">{timeLabel(c.lastMessageAt)}</span></span>
                  <span className="small muted ellipsis" style={{ display: 'block' }}>{t(c.kind === 'internal' ? 'kind.internal' : c.level === 'directivo' ? 'kind.directivo' : 'kind.operativo')} · {tn(c.memberIds.length, 'n.participant', 'n.participants')}</span>
                </span>
                {c.unread > 0 && <span className="pill">{c.unread}</span>}
              </button>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 10 }}>{t('ws.onlyYours')}</div>
          <div className="eyebrow" style={{ margin: '24px 0 10px' }}>{t('nav.issues')}</div>
          <div className="list">
            {(() => {
              const visible = new Set(convs.map((c) => c.id));
              const list = Object.values(issues).filter((i) => i.workspaceId === id && !isClosed(i) && visible.has(i.conversationId));
              return list.length ? list.map((i) => <IssueRow key={i.id} i={i} onOpen={setOpenIssue} />) : <div className="empty">{t('issue.noIssues')}</div>;
            })()}
          </div>
        </section>
        <section>
          <div className="eyebrow" style={{ marginBottom: 10 }}>{t('ws.participants')}{isGuest ? '' : ` · ${members.length}`}</div>
          {isGuest && <div className="hint">{t('ws.guestHint')}</div>}
          {[...byOrg.entries()].map(([orgId, people]) => (
            <div key={orgId} className="card" style={{ padding: 12, marginBottom: 10 }}>
              <div className="row" style={{ marginBottom: 6 }}><OrgMark org={orgById(d, orgId)} size={22} /><b>{orgById(d, orgId)?.name ?? t('common.guests')}</b></div>
              {people.map((p) => (
                <div key={p!.id} className="member">
                  <Avatar person={p} org={orgById(d, p!.orgId)} size={30} />
                  <span className="grow" style={{ minWidth: 0 }}><span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>{p!.name}</span><span className="small muted ellipsis" style={{ display: 'block' }}>{p!.title ?? ''}</span></span>
                  {p!.id !== d.me.id && <button className="btn ghost small" title={t('common.directMessage')} aria-label={t('common.directMessage')} onClick={() => client.openDirect(p!.id).then((r) => navigate(`/c/${r.id}`))}>✉</button>}
                </div>
              ))}
            </div>
          ))}
        </section>
      </div>
      {dialog === 'group' && <NewGroupDialog workspaceId={id} onClose={() => setDialog(null)} />}
      {dialog === 'invite' && <InviteDialog workspaceId={id} onClose={() => setDialog(null)} />}
      {openIssue && <IssueDrawer id={openIssue} onClose={() => setOpenIssue(null)} />}
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
      <h1>{t('nav.people')}</h1>
      <div className="muted">{t('people.subtitle')}</div>
      <input className="input" style={{ margin: '14px 0' }} placeholder={t('people.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      {people.length === 0 && <div className="empty">{t('people.empty')}</div>}
      {[...byOrg.entries()].map(([k, list]) => (
        <section key={k} style={{ marginBottom: 18 }}>
          <div className="row" style={{ marginBottom: 8 }}>{k !== 'agents' && k !== 'guest' && <OrgMark org={orgById(d, k)} />}<b>{k === 'agents' ? t('common.agents') : k === 'guest' ? t('common.guests') : orgById(d, k)?.name}</b><span className="small muted">{list.length}</span></div>
          <div className="list">
            {list.map((p) => (
              <div key={p.id} className="card conv-card" {...menuProps(() => personMenu(p))}>
                <Avatar person={p} org={orgById(d, p.orgId)} size={36} />
                <span className="grow" style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{p.name}</b><span className="small muted ellipsis" style={{ display: 'block' }}>{[p.title, p.area].filter(Boolean).join(' · ')}{p.guest && p.guestUntil ? ` · ${t('people.until', { date: new Date(p.guestUntil).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) })}` : ''}</span></span>
                <button className="btn small" onClick={() => client.openDirect(p.id).then((r) => navigate(`/c/${r.id}`))}>{t('common.message')}</button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div></div>
  );
}

function InviteColleague({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function generate() {
    setBusy(true); setError(null);
    try {
      const r = await client.createOrgInvitation(orgId, { email: email || undefined });
      setLink(`${location.origin}/signup?org=${encodeURIComponent(r.token)}`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <b>{t('settings.inviteColleague')}</b>
      <div className="small muted">{t('settings.inviteColleagueHint', { org: orgName })}</div>
      {link ? (
        <div className="linkbox">
          <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} />
          <button className="btn primary" onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true); }}>{copied ? t('common.copied') : t('common.copy')}</button>
        </div>
      ) : (
        <div className="linkbox">
          <input className="input" type="email" placeholder={t('settings.inviteEmailPh')} value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn primary" disabled={busy} onClick={generate}>{t('settings.generate')}</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function SettingsScreen() {
  const d = useClient((s) => s.data)!;
  useLang();
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof client.sessions>> | null>(null);
  const load = () => client.sessions().then(setSessions).catch(() => {});
  useEffect(() => { void load(); }, []);
  const myOrg = orgById(d, d.me.primaryOrgId);
  const canInvite = myOrg?.myRole === 'owner' || myOrg?.myRole === 'admin';
  const pref = langPreference();
  const PLAT: Record<string, string> = { web: 'Web', macos: 'macOS', windows: 'Windows', android: 'Android', ios: 'iOS' };
  const langOptions: [Lang | null, string][] = [[null, t('settings.langAuto')], ['es', 'Español'], ['en', 'English']];
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 720 }}>
      <h1>{t('settings.title')}</h1>
      <div className="card" style={{ padding: 18, display: 'flex', gap: 14, alignItems: 'center', margin: '14px 0 24px', flexWrap: 'wrap' }}>
        <Avatar person={personById(d, d.me.id)} org={myOrg} size={48} />
        <div className="grow"><b>{d.me.name}</b><div className="small muted">{d.me.email} · {[d.me.title, myOrg?.name].filter(Boolean).join(' · ')}</div></div>
        <SignOutButton />
      </div>

      <div className="eyebrow" style={{ marginBottom: 10 }}>{t('notif.title')}</div>
      <NotificationToggle />
      <div className="eyebrow" style={{ marginBottom: 10 }}>{t('settings.language')}</div>
      <div className="seg" style={{ marginBottom: 24, maxWidth: 480 }}>
        {langOptions.map(([v, label]) => (
          <button key={label} className={pref === v ? 'on' : ''} onClick={() => setLang(v)} lang={v ?? getLang()}>{label}</button>
        ))}
      </div>

      {canInvite && myOrg && (
        <>
          <div className="eyebrow" style={{ marginBottom: 10 }}>{t('settings.team')}</div>
          <div style={{ marginBottom: 24 }}><InviteColleague orgId={myOrg.id} orgName={myOrg.name} /></div>
        </>
      )}

      <div className="eyebrow" style={{ marginBottom: 10 }}>{t('settings.devices')}</div>
      <div className="list">
        {sessions?.sessions.map((s) => (
          <div key={s.id} className="card conv-card">
            <span className="grow"><b>{s.deviceName}</b> <span className="tag">{PLAT[s.platform] ?? s.platform}</span><span className="small muted" style={{ display: 'block' }}>{t('settings.lastSeen', { date: new Date(s.lastSeenAt).toLocaleString(locale()) })}</span></span>
            {s.id === sessions.current ? <span className="tag">{t('settings.thisDevice')}</span> : <button className="btn small" onClick={() => client.revokeSession(s.id).then(load)}>{t('settings.closeSession')}</button>}
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 18 }}>{t('settings.platforms')}</div>
    </div></div>
  );
}

function NotificationToggle() {
  const supported = 'Notification' in window;
  const [perm, setPerm] = useState(supported ? Notification.permission : 'denied');
  if (!supported) return null;
  return (
    <div className="card conv-card" style={{ marginBottom: 24 }}>
      <span className="grow">{perm === 'granted' ? t('notif.on') : perm === 'denied' ? t('notif.blocked') : t('notif.enable')}</span>
      {perm === 'default' && <button className="btn primary small" onClick={() => { askNotifications(); setTimeout(() => setPerm(Notification.permission), 1500); }}>{t('notif.enable')}</button>}
    </div>
  );
}
