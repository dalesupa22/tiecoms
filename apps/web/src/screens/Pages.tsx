import { ProviderIcon } from './Mail.tsx';
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { ConversationDTO, StorageUsageDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, getLang, langPreference, locale, setLang, t, tn, useLang, type Lang } from '../i18n.ts';
import { navigate } from '../router.ts';
import { openProfile } from './Profile.tsx';
import { NewChatDialog, StackedAvatars } from './Chats.tsx';
import { directOtherId, Avatar, ConvAvatar, OrgMark, SideIcon, conversationSubtitle, conversationTitle, counterpartOrg, orgById, personById, conversationPreview, timeLabel } from '../ui.tsx';
import { InviteDialog, NewGroupDialog } from './Dialogs.tsx';
import { InviteResult, PendingInvitations } from './Invitations.tsx';
import { IssueDrawer, IssueRow, isClosed } from './Issues.tsx';
import { newEvent } from './Calendar.tsx';
import { SleepDialog, sleepSummary } from './Sleep.tsx';
import { MeetingsSettings } from './Meetings.tsx';
import { TEXT_SIZES, setTextSize, useTextSize } from '../text-size.ts';
import { THEME_PREFS, setThemePreference, useThemePreference } from '../theme.ts';
import { formatBytes } from '../video.ts';
import { askNotifications, conversationMenu, dndMenu, dndText, mutedText, openDialog, personMenu } from '../actions.tsx';
import { menuProps, openMenuAt, toast } from '../menu.tsx';
import { isMuted } from '../home-order.ts';
import { DEFAULT_RINGTONE, DEFAULT_SOUND, playMessageSound, previewRingtone, setSoundEnabled, soundEnabled, subscribeSound } from '../sound.ts';
import { MESSAGE_SOUNDS, RINGTONES } from '@tiecoms/contracts';
import { SignOutButton, groupWorkspaces } from './Shell.tsx';
import { JoinWithCodeDialog, openCreateGroup } from './Groups.tsx';

/** Una conversación en tarjeta (Hoy, Conversaciones). La pantalla Hoy vive en Home.tsx (docs/HOY.md). */
export function ConvCard({ c }: { c: ConversationDTO }) {
  const d = useClient((s) => s.data)!;
  const other = c.kind === 'direct' ? personById(d, directOtherId(d, c)) : null;
  const org = other ? orgById(d, other.orgId) : c.workspaceId ? counterpartOrg(d, c.workspaceId) : null;
  const muted = isMuted(c);
  return (
    <button className={`card conv-card ${muted ? 'is-muted' : ''}`} onClick={() => navigate(`/c/${c.id}`)} {...menuProps(() => conversationMenu(c, { onNewMeeting: () => newEvent({ conversationId: c.id }) }))}>
      {other ? <Avatar person={other} org={org} size={38} /> : c.avatarUrl ? <ConvAvatar c={c} size={38} /> : c.deriveKind === 'side' ? <SideIcon size={38} /> : c.kind === 'multi' ? <StackedAvatars c={c} size={30} /> : <OrgMark org={org} size={38} />}
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="row">{c.deriveKind === 'side' && <span className="chip-side is-sidechat">{t('groups.sidechat')}</span>}<b className="ellipsis grow">{c.deriveKind === 'side' ? conversationTitle(d, c).replace(/^(Sidechat|Consulta)\s*·\s*/i, '') : conversationTitle(d, c)}</b><span className="small muted">{timeLabel(c.lastMessageAt)}</span></span>
        <span className="small muted ellipsis" style={{ display: 'block' }}>{conversationSubtitle(d, c)}</span>
        <span className="small ellipsis" style={{ display: 'block', color: c.unread ? 'var(--ink)' : 'var(--muted)' }}>{conversationPreview(d, c) ?? t('conv.noMessages')}</span>
      </span>
      {muted && <span className="mute-ico" title={mutedText(c) ?? t('side.muted')} aria-label={t('side.muted')}>🔕</span>}
      {(c.unreadMentions ?? 0) > 0 && <span className="pill mention-pill" title={t('mention.youMentioned')}>@</span>}
      {c.unread > 0 && <span className={`pill ${muted ? 'is-muted' : ''}`}>{c.unread}</span>}
    </button>
  );
}

export function InboxScreen() {
  const d = useClient((s) => s.data)!;
  const [filter, setFilter] = useState<'all' | 'unread' | 'direct'>('all');
  const [q, setQ] = useState('');
  const list = d.conversations.filter((c) => (filter === 'unread' ? c.unread > 0 : filter === 'direct' ? c.kind === 'direct' || c.kind === 'multi' : true))
    .filter((c) => !q || conversationTitle(d, c).toLowerCase().includes(q.toLowerCase()));
  const label = { all: t('inbox.all'), unread: t('inbox.unread'), direct: t('inbox.directs') };
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <div className="row"><h1 className="grow">{t('nav.inbox')}</h1><button className="btn primary small" onClick={() => openDialog((close) => <NewChatDialog onClose={close} />)}>＋ {t('chat.new')}</button></div>
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
  const groups = useMemo(() => groupWorkspaces(d), [d]);
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <div className="row"><h1 className="grow">{t('nav.spaces')}</h1><button className="btn small" onClick={() => navigate('/participantes')}>{t('nav.people')}</button><button className="btn primary small" onClick={() => openCreateGroup({ kind: 'company' })}>{t('spaces.new')}</button></div>
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
                {c.avatarUrl ? <ConvAvatar c={c} size={34} /> : <span className="mark" style={{ width: 34, height: 34, background: c.kind === 'internal' ? 'var(--surface)' : 'var(--paper-3)', border: '1px solid var(--line)', fontSize: 14 }}>{c.parentId ? '⑂' : c.kind === 'internal' ? '◌' : c.level === 'directivo' ? '◆' : '#'}</span>}
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="row"><b className="grow ellipsis">{conversationTitle(d, c)}</b><span className="small muted">{timeLabel(c.lastMessageAt)}</span></span>
                  <span className="small muted ellipsis" style={{ display: 'block' }}>{t(c.kind === 'internal' ? 'kind.internal' : c.level === 'directivo' ? 'kind.directivo' : 'kind.operativo')} · {tn(c.memberIds.length, 'n.participant', 'n.participants')}</span>
                </span>
                {isMuted(c) && <span className="mute-ico" title={mutedText(c) ?? t('side.muted')} aria-label={t('side.muted')}>🔕</span>}
                {(c.unreadMentions ?? 0) > 0 && <span className="pill mention-pill" title={t('mention.youMentioned')}>@</span>}
                {c.unread > 0 && <span className={`pill ${isMuted(c) ? 'is-muted' : ''}`}>{c.unread}</span>}
              </button>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 10 }}>{t('ws.onlyYours')}</div>
          <div className="eyebrow" style={{ margin: '24px 0 10px' }}>{t('nav.issues')}</div>
          <div className="list">
            {(() => {
              const visible = new Set(convs.map((c) => c.id));
              const list = Object.values(issues).filter((i) => i.workspaceId === id && !isClosed(i) && !!i.conversationId && visible.has(i.conversationId));
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
                {p.id !== d.me.id && <button className="btn small" onClick={() => client.openDirect(p.id).then((r) => navigate(`/c/${r.id}`)).catch((e) => toast(errorText(e)))}>✉ {t('people.sendMessage')}</button>}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div></div>
  );
}

export function InviteColleague({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ email: string; emailSent: boolean; link: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setSent(null);
    try {
      const to = email.trim();
      const r = await client.createOrgInvitation(orgId, { email: to, lang: getLang() });
      setSent({ email: to, emailSent: r.emailSent, link: `${location.origin}/signup?org=${encodeURIComponent(r.token)}` });
      setEmail(''); setReload((n) => n + 1);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <b>{t('settings.inviteColleague')}</b>
      <div className="small muted">{t('settings.inviteColleagueHint', { org: orgName })}</div>
      <form className="linkbox" onSubmit={send}>
        <input className="input" type="email" required placeholder={t('settings.inviteEmailPh')} value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn primary" disabled={busy || !email.trim()}>{busy ? t('common.wait') : t('dlg.sendInvite')}</button>
      </form>
      {error && <div className="error">{error}</div>}
      {sent && <InviteResult email={sent.email} emailSent={sent.emailSent} link={sent.link} />}
      <PendingInvitations scope="organizations" id={orgId} reload={reload} />
    </div>
  );
}

export function SettingsScreen() {
  const d = useClient((s) => s.data)!;
  const mailOn = d?.features?.mail === true;
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
      <h1>{t('nav.you')}</h1>
      <div className="card" style={{ padding: 18, display: 'flex', gap: 14, alignItems: 'center', margin: '14px 0 24px', flexWrap: 'wrap' }}>
        <Avatar person={personById(d, d.me.id)} org={myOrg} size={48} />
        <div className="grow"><b>{d.me.name}</b><div className="small muted">{d.me.email} · {[d.me.title, myOrg?.name].filter(Boolean).join(' · ')}</div></div>
        <button className="btn" onClick={openProfile}>{t('profile.edit')}</button>
        <SignOutButton />
      </div>

      <div className="eyebrow" style={{ marginBottom: 10 }}>{t('join.title')}</div>
      <button className="card conv-card" style={{ marginBottom: 24 }} onClick={() => openDialog((close) => <JoinWithCodeDialog onClose={close} />)}>
        <span style={{ fontSize: 22 }} aria-hidden>⌗</span>
        <span className="grow"><b>{t('join.title')}</b><span className="small muted" style={{ display: 'block' }}>{t('join.hint')}</span></span>
        <span className="muted">›</span>
      </button>
      {d.organizations.filter((o) => (o.myRole === 'owner' || o.myRole === 'admin') && o.verifiedDomain).map((o) => (
        <label key={`jp-${o.id}`} className="card conv-card check" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={o.joinPolicy === 'auto'} onChange={(e) => client.setJoinPolicy(o.id, e.target.checked ? 'auto' : 'invite').catch((err) => toast(errorText(err)))} />
          <span className="grow"><b>{t('org.autoJoin', { domain: o.verifiedDomain ?? '' })}</b><span className="small muted" style={{ display: 'block' }}>{t('org.autoJoinHint', { org: o.name })}</span></span>
        </label>
      ))}
      {d.organizations.filter((o) => o.myRole === 'owner' || o.myRole === 'admin').map((o) => (
        <button key={o.id} className="card conv-card" style={{ marginBottom: 24 }} onClick={() => navigate(`/supervision/${o.id}`)}>
          <span style={{ fontSize: 22 }} aria-hidden>◉</span>
          <span className="grow"><b>{t('over.title', { org: o.name })}</b><span className="small muted" style={{ display: 'block' }}>{t('over.entryHint')}</span></span>
          <span className="muted">›</span>
        </button>
      ))}

      <div className="eyebrow" style={{ marginBottom: 10 }}>{t('link.settingsTitle')}</div>
      <label className="card conv-card check" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={!!d.me.linkDigest} onChange={(e) => client.setLinkDigest(e.target.checked).catch((err) => toast(errorText(err)))} />
        <span className="grow"><b>{t('link.digest')}</b><span className="small muted" style={{ display: 'block' }}>{t('link.digestHint')}</span></span>
      </label>
      {d.organizations.filter((o) => o.myRole === 'owner' || o.myRole === 'admin').map((o) => (
        <label key={`ra-${o.id}`} className="card conv-card check" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={o.reactionActions !== false} onChange={(e) => client.setReactionActions(o.id, e.target.checked).catch((err) => toast(errorText(err)))} />
          <span className="grow"><b>{t('react.actionsSetting', { org: o.name })}</b><span className="small muted" style={{ display: 'block' }}>{t('react.actionsSettingHint')}</span></span>
        </label>
      ))}
      <button className="card conv-card" style={{ marginBottom: 24 }} onClick={() => navigate('/ver-despues')}>
        <span style={{ fontSize: 22 }} aria-hidden>🔖</span>
        <span className="grow"><b>{t('nav.saved')}</b><span className="small muted" style={{ display: 'block' }}>{t('link.savedIntro')}</span></span>
        <span className="muted">›</span>
      </button>

      {mailOn && (
        <>
          {/* En el celular no hay «Más»: Tú › Correo es la entrada a la lista, además del ＋ del chat (docs/CORREO.md). */}
          <div className="eyebrow" style={{ marginBottom: 10 }}>{t('mail.title')}</div>
          <button className="card conv-card" style={{ marginBottom: 24 }} onClick={() => navigate('/correo')}>
            <span className="row" style={{ gap: 4 }} aria-hidden><ProviderIcon provider="google" size={20} /><ProviderIcon provider="microsoft" size={20} /></span>
            <span className="grow"><b>{t('mail.settingsRow')}</b><span className="small muted" style={{ display: 'block' }}>{t('mail.settingsHint')}</span></span>
            <span className="muted">›</span>
          </button>
        </>
      )}
      <div className="eyebrow" style={{ marginBottom: 10 }}>{t('settings.whatsapp')}</div>
      <button className="card conv-card" style={{ marginBottom: 24 }} onClick={() => navigate('/whatsapp')}>
        <span style={{ fontSize: 22 }} aria-hidden>✆</span>
        <span className="grow"><b>{t('wa.connect').replace('＋ ', '')}</b><span className="small muted" style={{ display: 'block' }}>{t('settings.whatsappHint')}</span></span>
        <span className="muted">›</span>
      </button>
      <div className="eyebrow" style={{ marginBottom: 10 }}>{t('meet.settingsTitle')}</div>
      <div style={{ marginBottom: 24 }}><MeetingsSettings /></div>
      <div className="eyebrow" style={{ marginBottom: 10 }}>{t('notif.title')}</div>
      <SilenceSettings />
      <NotificationToggle />
      <div className="eyebrow" style={{ marginBottom: 10 }}>{t('text.title')}</div>
      <TextSizeSetting />
      <div className="eyebrow" style={{ marginBottom: 10 }}>{t('settings.language')}</div>
      <div className="seg" style={{ marginBottom: 24, maxWidth: 480 }}>
        {langOptions.map(([v, label]) => (
          <button key={label} className={pref === v ? 'on' : ''} onClick={() => setLang(v)} lang={v ?? getLang()}>{label}</button>
        ))}
      </div>
      <div className="eyebrow" style={{ marginBottom: 10 }}>{t('theme.title')}</div>
      <ThemeSetting />

      {canInvite && myOrg && (
        <>
          <div className="eyebrow" style={{ marginBottom: 10 }}>{t('settings.team')}</div>
          <div style={{ marginBottom: 24 }}><InviteColleague orgId={myOrg.id} orgName={myOrg.name} /></div>
        </>
      )}

      <div className="eyebrow" style={{ marginBottom: 10 }}>{t('storage.title')}</div>
      <StorageUsage adminOrgs={d.organizations.filter((o) => o.myRole === 'owner' || o.myRole === 'admin').map((o) => ({ id: o.id, name: o.name }))} />

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

/** «Almacenamiento usado: 1,2 GB · videos 800 MB · fotos … · archivos …» (solo medición, docs/VIDEO.md). */
function StorageUsage({ adminOrgs }: { adminOrgs: { id: string; name: string }[] }) {
  const [mine, setMine] = useState<StorageUsageDTO | null>(null);
  const [orgs, setOrgs] = useState<(StorageUsageDTO & { name: string })[]>([]);
  const orgKey = adminOrgs.map((o) => o.id).join(',');
  useEffect(() => {
    let alive = true;
    client.myStorage().then((r) => alive && setMine(r)).catch(() => {});
    Promise.all(adminOrgs.map((o) => client.orgStorage(o.id).then((r) => ({ ...r, name: o.name })).catch(() => null)))
      .then((list) => alive && setOrgs(list.filter((x): x is StorageUsageDTO & { name: string } => !!x)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgKey]);
  const lang = getLang();
  const fmt = (n: number) => formatBytes(n, lang);
  const parts = mine ? ([
    ['videos', mine.breakdown.videos, 'storage.videos', '#3d5a80'], ['photos', mine.breakdown.photos, 'storage.photos', '#2a9d8f'],
    ['files', mine.breakdown.files, 'storage.files', '#e9c46a'], ['voice', mine.breakdown.voice, 'storage.voice', '#e76f51'],
  ] as const) : [];
  return (
    <div className="card" style={{ padding: 16, marginBottom: 24 }} data-testid="storage-usage">
      {!mine ? <span className="small muted">{t('common.loading')}</span> : (
        <>
          <b>{t('storage.used', { total: fmt(mine.totalBytes) })}</b>
          <span className="small muted">{parts.filter(([, n]) => n > 0).map(([, n, k]) => ` · ${t(k, { n: fmt(n) })}`).join('')}</span>
          {mine.totalBytes > 0 && (
            <div className="storage-bar" aria-hidden>
              {parts.filter(([, n]) => n > 0).map(([id, n, , color]) => <span key={id} style={{ width: `${(n / mine.totalBytes) * 100}%`, background: color }} />)}
            </div>
          )}
          <div className="hint" style={{ marginTop: 6 }}>{t('storage.hint')}</div>
          {orgs.map((o) => <div key={o.id} className="small" style={{ marginTop: 8 }}>{t(o.people === 1 ? 'storage.orgOne' : 'storage.org', { org: o.name, total: fmt(o.totalBytes), n: o.people ?? 0 })}</div>)}
        </>
      )}
    </div>
  );
}

/** Apariencia: Automático (sistema) · Claro · Oscuro. Se guarda en este dispositivo (theme.ts). */
function ThemeSetting() {
  const pref = useThemePreference();
  return (
    <div style={{ marginBottom: 24, maxWidth: 480 }} data-testid="theme-setting">
      <div className="seg" role="radiogroup" aria-label={t('theme.title')}>
        {THEME_PREFS.map((v) => (
          <button key={v} role="radio" aria-checked={pref === v} className={pref === v ? 'on' : ''} onClick={() => setThemePreference(v)}>{t(`theme.${v}`)}</button>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 6 }}>{t('theme.hint')}</div>
    </div>
  );
}

/** Tamaño del texto: 5 pasos con vista previa inmediata (toda la app cambia al mover el control). */
function TextSizeSetting() {
  const v = useTextSize();
  const i = TEXT_SIZES.indexOf(v as (typeof TEXT_SIZES)[number]);
  const names = [t('text.small'), t('text.default'), t('text.large'), t('text.larger'), t('text.largest')];
  return (
    <div className="card text-size">
      <span className="a-small" aria-hidden>A</span>
      <input type="range" min={0} max={TEXT_SIZES.length - 1} step={1} value={i < 0 ? 1 : i} aria-label={t('text.title')} aria-valuetext={names[i] ?? names[1]}
        onChange={(e) => setTextSize(TEXT_SIZES[Number(e.target.value)]!)} />
      <span className="a-big" aria-hidden>A</span>
      <span className="small muted" style={{ minWidth: 84, textAlign: 'right' }}>{names[i] ?? names[1]}</span>
    </div>
  );
}

/** «No molestar» y «Sonido de mensajes» (también en el menú de la cuenta). */
function SilenceSettings() {
  const until = useClient((s) => s.data?.me.dndUntil);
  const sleep = useClient((s) => s.data?.me.sleep);
  const sound = useSyncExternalStore(subscribeSound, soundEnabled);
  const status = dndText(until);
  return (
    <>
      <button className="card conv-card" style={{ marginBottom: 12 }} aria-haspopup="menu"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenuAt(r.left + 16, r.bottom - 6, dndMenu(until).items!); }}>
        <span style={{ fontSize: 22 }} aria-hidden>🌙</span>
        <span className="grow"><b>{t('dnd.title')}</b><span className="small muted" style={{ display: 'block' }}>{status ?? t('dnd.hint')}</span></span>
        <span className="muted">›</span>
      </button>
      <button className="card conv-card" style={{ marginBottom: 12 }} onClick={() => openDialog((close) => <SleepDialog onClose={close} />)}>
        <span style={{ fontSize: 22 }} aria-hidden>🛌</span>
        <span className="grow"><b>{t('sleep.title')}</b><span className="small muted" style={{ display: 'block' }}>{sleepSummary(sleep) ?? t('sleep.explain')}</span></span>
        <span className="muted">›</span>
      </button>
      <label className="card conv-card check" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={sound} onChange={(e) => setSoundEnabled(e.target.checked)} />
        <span className="grow"><b>{t('sound.title')}</b><span className="small muted" style={{ display: 'block' }}>{t('sound.hint')}</span></span>
      </label>
      <SoundDefaults />
    </>
  );
}

/** Sonido predeterminado de los chats y tono de llamada (docs/SONIDOS.md); cada chat puede tener el suyo. */
function SoundDefaults() {
  const me = useClient((s) => s.data?.me);
  const msg = me?.messageSound ?? null;
  const ring = me?.ringtone ?? null;
  const save = (p: Parameters<typeof client.setSounds>[0]) => void client.setSounds(p).catch((e) => toast(errorText(e)));
  const at = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return [r.left, r.bottom + 4] as const; };
  const msgMenu = (el: HTMLElement) => openMenuAt(...at(el), [
    ...MESSAGE_SOUNDS.map((x) => ({ label: `${(msg ?? DEFAULT_SOUND) === x ? '✓ ' : ''}${t(`sound.n.${x}` as any)}`, onSelect: () => { playMessageSound(x, false, true); save({ messageSound: x }); } })),
    { divider: true },
    { label: `${msg === 'none' ? '✓ ' : ''}${t('sound.none')}`, onSelect: () => save({ messageSound: 'none' }) },
  ]);
  const ringMenu = (el: HTMLElement) => openMenuAt(...at(el), RINGTONES.map((x) => ({
    label: `${(ring ?? DEFAULT_RINGTONE) === x ? '✓ ' : ''}${t(`ring.n.${x}` as any)}`, onSelect: () => { previewRingtone(x); save({ ringtone: x }); },
  })));
  return <>
    <button className="card conv-card" style={{ marginBottom: 12 }} onClick={(e) => msgMenu(e.currentTarget)}>
      <span style={{ fontSize: 22 }} aria-hidden>🎵</span>
      <span className="grow"><b>{t('sound.defaultTitle')}</b><span className="small muted" style={{ display: 'block' }}>{msg === 'none' ? t('sound.none') : t(`sound.n.${msg ?? DEFAULT_SOUND}` as any)} · {t('sound.defaultHint')}</span></span>
      <span className="muted">›</span>
    </button>
    <button className="card conv-card" style={{ marginBottom: 12 }} onClick={(e) => ringMenu(e.currentTarget)}>
      <span style={{ fontSize: 22 }} aria-hidden>📞</span>
      <span className="grow"><b>{t('ring.title')}</b><span className="small muted" style={{ display: 'block' }}>{t(`ring.n.${ring ?? DEFAULT_RINGTONE}` as any)}</span></span>
      <span className="muted">›</span>
    </button>
  </>;
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
