import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BootstrapDTO, ConversationDTO, CreateGroupRequest, InvitationPreviewDTO, IssueDTO, MessageDTO, OrganizationDTO, OversightDTO, WorkspaceDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, getLang, locale, t, tn } from '../i18n.ts';
import { navigate, queryParam } from '../router.ts';
import { Avatar, ConvAvatar, Modal, OrgMark, badgeColor, conversationTitle, orgById, personById, timeLabel } from '../ui.tsx';
import { conversationMenu, openDialog, workspaceMenu } from '../actions.tsx';
import { copyText, menuProps, toast, type MenuItem } from '../menu.tsx';
import { newEvent } from './Calendar.tsx';
import { InviteDialog } from './Dialogs.tsx';
import { NewIssueDialog, isClosed } from './Issues.tsx';
import { MessageText } from './Mentions.tsx';
import { NewChatDialog, StackedAvatars } from './Chats.tsx';
import { compareConversations, matchesTab, pendingOf, activityOf, type HomeTab } from './Shell.tsx';

// ---------- Árbol de Grupos (mismas reglas en web, iOS y Android: docs/GRUPOS.md) ----------
export interface GroupNode { conv: ConversationDTO; derived: ConversationDTO[]; issues: IssueDTO[] }
export interface WsNode { ws: WorkspaceDTO; header: boolean; groups: GroupNode[] }
export interface CompanyNode { key: string; org: OrganizationDTO | null; name: string; pending: boolean; workspaces: WsNode[] }
export interface GroupSection { key: string; kind: 'org' | 'relations' | 'guest'; org: OrganizationDTO | null; companies: CompanyNode[] }

const isMuted = (c: ConversationDTO) => !!c.mutedUntil && Date.parse(c.mutedUntil) > Date.now();
const openIssuesOf = (issues: Record<string, IssueDTO>, conversationId: string) =>
  Object.values(issues).filter((i) => i.conversationId === conversationId && !isClosed(i))
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.updatedAt.localeCompare(a.updatedAt));

function rankOf(convs: ConversationDTO[]) {
  return { unread: convs.reduce((n, c) => n + pendingOf(c), 0), activity: convs.reduce((m, c) => (activityOf(c) > m ? activityOf(c) : m), '') };
}
function byRank(a: { unread: number; activity: string }, b: { unread: number; activity: string }) {
  if ((a.unread > 0) !== (b.unread > 0)) return a.unread > 0 ? -1 : 1;
  return b.unread - a.unread || b.activity.localeCompare(a.activity);
}
const convsOfWs = (w: WsNode) => w.groups.flatMap((g) => [g.conv, ...g.derived]);
const convsOfCompany = (c: CompanyNode) => c.workspaces.flatMap(convsOfWs);

/** ¿Dónde va un espacio? Tu organización, Relaciones (con la otra empresa o pendiente) o Invitado en. */
export function placeWorkspace(d: BootstrapDTO, w: WorkspaceDTO): { section: 'org' | 'relations' | 'guest'; companyKey: string; org: OrganizationDTO | null; name: string; pending: boolean } {
  const mine = new Set(d.organizations.filter((o) => o.myRole).map((o) => o.id));
  if (w.myRole === 'guest') {
    const host = orgById(d, w.owningOrgId);
    return { section: 'guest', companyKey: `guest:${w.owningOrgId}`, org: host, name: host?.name ?? w.name, pending: false };
  }
  const other = w.organizationIds.find((id) => !mine.has(id));
  if (other) {
    const org = orgById(d, other);
    return { section: 'relations', companyKey: `org:${other}`, org, name: org?.name ?? w.name, pending: false };
  }
  if (w.counterpartName) {
    return { section: 'relations', companyKey: `pending:${w.counterpartName.toLowerCase()}`, org: null, name: w.counterpartName, pending: true };
  }
  const own = orgById(d, w.owningOrgId);
  return { section: 'org', companyKey: `org:${w.owningOrgId}`, org: own, name: own?.name ?? w.name, pending: false };
}

/**
 * Arma las secciones: Tu organización (una por empresa mía), Relaciones e Invitado en. Bajo cada grupo van
 * sus derivadas y sus asuntos abiertos; los sidechats no cuelgan aquí (van en DMs).
 */
export function buildGroupTree(d: BootstrapDTO, issues: Record<string, IssueDTO>, tab: HomeTab = 'all'): GroupSection[] {
  const visible = new Set(d.conversations.map((c) => c.id));
  const shows = (c: ConversationDTO, derived: ConversationDTO[]) => matchesTab(c, tab) || derived.some((x) => matchesTab(x, tab));
  const companies = new Map<string, CompanyNode & { section: GroupSection['kind'] }>();
  for (const w of d.workspaces) {
    const inWs = d.conversations.filter((c) => c.workspaceId === w.id && (c.kind === 'group' || c.kind === 'internal') && c.deriveKind !== 'side');
    // Una derivada cuelga de su origen si lo veo en el mismo espacio.
    const isChild = (c: ConversationDTO) => !!c.parentId && visible.has(c.parentId) && inWs.some((p) => p.id === c.parentId);
    const groups = inWs.filter((c) => !isChild(c))
      .map((conv) => ({ conv, derived: inWs.filter((x) => x.parentId === conv.id && isChild(x)).sort(compareConversations), issues: openIssuesOf(issues, conv.id) }))
      .filter((g) => tab === 'all' || shows(g.conv, g.derived))
      .sort((a, b) => compareConversations(a.conv, b.conv));
    if (tab !== 'all' && !groups.length) continue;
    const p = placeWorkspace(d, w);
    if (!companies.has(p.companyKey)) companies.set(p.companyKey, { key: p.companyKey, org: p.org, name: p.name, pending: p.pending, workspaces: [], section: p.section });
    companies.get(p.companyKey)!.workspaces.push({ ws: w, header: !w.isOrgHome, groups });
  }
  const list = [...companies.values()];
  for (const c of list) {
    c.workspaces.sort((a, b) => Number(!!b.ws.isOrgHome) - Number(!!a.ws.isOrgHome) || byRank(rankOf(convsOfWs(a)), rankOf(convsOfWs(b))) || a.ws.id.localeCompare(b.ws.id));
    // En Relaciones, una empresa con un solo espacio no repite la cabecera del espacio.
    if (c.section !== 'org' && c.workspaces.length === 1) c.workspaces[0]!.header = false;
  }
  const sorted = (xs: typeof list) => xs.sort((a, b) => byRank(rankOf(convsOfCompany(a)), rankOf(convsOfCompany(b))) || a.key.localeCompare(b.key));
  const myOrgs = d.organizations.filter((o) => o.myRole);
  const sections: GroupSection[] = myOrgs.map((o) => ({ key: `org:${o.id}`, kind: 'org', org: o, companies: list.filter((c) => c.section === 'org' && c.key === `org:${o.id}`) }));
  sections.push({ key: 'relations', kind: 'relations', org: null, companies: sorted(list.filter((c) => c.section === 'relations')) });
  const guest = sorted(list.filter((c) => c.section === 'guest'));
  if (guest.length) sections.push({ key: 'guest', kind: 'guest', org: null, companies: guest });
  return sections;
}

/** DMs: directos y chats grupales, incluidos los sidechats (con su burbuja). */
export function dmConversations(d: BootstrapDTO, tab: HomeTab = 'all') {
  return d.conversations.filter((c) => (c.kind === 'direct' || c.kind === 'multi') && matchesTab(c, tab)).sort(compareConversations);
}

// ---------- Plegado (por dispositivo) ----------
const FOLD_KEY = 'tiecoms:folded';
function readFolded(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]')); } catch { return new Set(); } }
function useFolded() {
  const [folded, setFolded] = useState(readFolded);
  const save = (next: Set<string>) => { setFolded(next); try { localStorage.setItem(FOLD_KEY, JSON.stringify([...next])); } catch {} };
  return {
    folded,
    toggle: (k: string) => { const n = new Set(folded); if (n.has(k)) n.delete(k); else n.add(k); save(n); },
    foldAll: (keys: string[]) => save(new Set([...folded, ...keys])),
  };
}

// ---------- Vista del árbol ----------
export function GroupsTree({ tab = 'all', activeConv = null, activeWs = null }: { tab?: HomeTab; activeConv?: string | null; activeWs?: string | null }) {
  const d = useClient((s) => s.data)!;
  const issues = useClient((s) => s.issues);
  const sections = useMemo(() => buildGroupTree(d, issues, tab), [d, issues, tab]);
  const { folded, toggle, foldAll } = useFolded();
  const allKeys = sections.flatMap((s) => s.companies.flatMap((c) => [c.key, ...c.workspaces.map((w) => `ws:${w.ws.id}`)]));

  return (
    <div className="groups-tree">
      {sections.map((s) => {
        const title = s.kind === 'org' ? t('groups.yourOrg', { org: s.org?.name ?? '' }) : s.kind === 'relations' ? t('groups.relations') : t('groups.guestIn');
        const plus = s.kind === 'org' ? () => openCreateGroup({ kind: 'org', orgId: s.org?.id }) : s.kind === 'relations' ? () => openCreateGroup({ kind: 'company' }) : null;
        const empty = s.companies.every((c) => c.workspaces.every((w) => !w.groups.length));
        return (
          <section key={s.key} className="groups-section">
            <div className="row groups-section-head">
              <span className="eyebrow grow">{title}</span>
              {plus && <button className="btn ghost small" onClick={plus} title={t('groups.new')} aria-label={`${t('groups.new')} · ${title}`}>＋</button>}
            </div>
            {empty && tab === 'all' && <div className="hint" style={{ padding: '2px 10px 8px' }}>{s.kind === 'org' ? t('groups.emptyOrg') : t('groups.emptyRelations')}</div>}
            {s.companies.map((c) => {
              const cKey = c.key;
              const fold = folded.has(cKey);
              const unread = convsOfCompany(c).reduce((n, x) => n + (isMuted(x) ? 0 : x.unread), 0);
              const body = c.workspaces.map((w) => <WsBlock key={w.ws.id} w={w} folded={folded} toggle={toggle} activeConv={activeConv} activeWs={activeWs} />);
              // Tu organización: los grupos van directo, sin cabecera de empresa.
              if (s.kind === 'org') return <div key={cKey}>{body}</div>;
              return (
                <div key={cKey} className="groups-company">
                  <button className="side-org groups-company-head" aria-expanded={!fold} onClick={() => toggle(cKey)}
                    {...menuProps(() => companyMenu(c, () => foldAll(allKeys)))}>
                    <OrgMark org={c.org} /><span className="grow ellipsis">{c.name}</span>
                    {c.pending && <span className="tag">{t('groups.pending')}</span>}
                    {fold && unread > 0 && <span className="pill">{unread}</span>}
                    <span className="muted small" aria-hidden>{fold ? '›' : '⌄'}</span>
                  </button>
                  {!fold && <div className="side-ws">{body}</div>}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function WsBlock({ w, folded, toggle, activeConv, activeWs }: { w: WsNode; folded: Set<string>; toggle: (k: string) => void; activeConv: string | null; activeWs: string | null }) {
  const key = `ws:${w.ws.id}`;
  const fold = w.header && folded.has(key);
  const unread = convsOfWs(w).reduce((n, x) => n + (isMuted(x) ? 0 : x.unread), 0);
  return (
    <div>
      {w.header && (
        <button className="side-ws-title" style={{ width: '100%', background: activeWs === w.ws.id ? 'var(--card)' : undefined }} aria-expanded={!fold} onClick={() => toggle(key)}
          {...menuProps(() => workspaceMenu(w.ws, {
            onNewGroup: () => openCreateGroup({ kind: 'workspace', workspaceId: w.ws.id }),
            onInvite: () => openDialog((close) => <InviteDialog workspaceId={w.ws.id} onClose={close} />),
          }))}>
          <span className="grow ellipsis">{w.ws.pinnedAt ? '📌 ' : ''}{w.ws.name}</span>
          {fold && unread > 0 && <span className="pill">{unread}</span>}
          <span className="muted small" aria-hidden>{fold ? '›' : '⌄'}</span>
        </button>
      )}
      {!fold && w.groups.map((g) => (
        <div key={g.conv.id}>
          <GroupRow c={g.conv} ws={w.ws} active={activeConv === g.conv.id} />
          {g.issues.length > 0 && <IssueLines g={g} />}
          {g.derived.length > 0 && <div className="side-sides">{g.derived.map((x) => <ConvItem key={x.id} c={x} active={activeConv === x.id} />)}</div>}
        </div>
      ))}
    </div>
  );
}

/** Asuntos abiertos bajo el grupo: hasta 3 y «+N asuntos». */
function IssueLines({ g }: { g: GroupNode }) {
  const today = new Date().toISOString().slice(0, 10);
  const shown = g.issues.slice(0, 3);
  return (
    <div className="group-issues">
      {shown.map((i) => (
        <button key={i.id} className="group-issue" onClick={() => navigate(`/c/${g.conv.id}?issue=${i.id}`)}>
          <span className="diamond" aria-hidden>◆</span>
          <span className="grow ellipsis">{i.title}</span>
          {(i.status === 'in_progress' || i.status === 'waiting') && <span className="tag">{t(`issue.st.${i.status}`)}</span>}
          {i.dueDate && <span className={`small ${i.dueDate < today ? 'overdue' : 'muted'}`}>{new Date(`${i.dueDate}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}</span>}
        </button>
      ))}
      {g.issues.length > 3 && (
        <button className="group-issue more" onClick={() => navigate(`/c/${g.conv.id}`)}>{t('groups.moreIssues', { n: g.issues.length - 3 })}</button>
      )}
    </div>
  );
}

function GroupRow({ c, ws, active }: { c: ConversationDTO; ws: WorkspaceDTO; active: boolean }) {
  return <ConvItem c={c} active={active} extraMenu={groupMenuExtra(c, ws)} />;
}

function groupMenuExtra(c: ConversationDTO, ws: WorkspaceDTO): MenuItem[] {
  return [
    { divider: true },
    ...(ws.myRole !== 'guest' && c.canPost ? [{ label: t('issue.new'), icon: '◆', onSelect: () => openDialog((close) => <NewIssueDialog conversationId={c.id} onClose={close} onCreated={(i) => navigate(`/c/${c.id}?issue=${i.id}`)} />) }] : []),
    ...(ws.myRole !== 'guest' && c.kind === 'group' ? [{ label: t('groups.inviteToGroup'), icon: '＋', onSelect: () => openDialog((close) => <InviteToGroupDialog conversationId={c.id} onClose={close} />) }] : []),
  ];
}

function companyMenu(c: CompanyNode, foldAll: () => void): MenuItem[] {
  const first = c.workspaces[0]?.ws;
  const canCreate = first && first.myRole !== 'guest';
  return [
    ...(canCreate ? [{ label: t('groups.newWith', { name: c.name }), icon: '#', onSelect: () => openCreateGroup({ kind: 'workspace', workspaceId: first.id }) }] : []),
    ...(canCreate ? [{ label: t('groups.inviteCompany', { name: c.name }), icon: '＋', onSelect: () => openDialog((close) => <InviteDialog workspaceId={first.id} onClose={close} />) }] : []),
    { divider: true },
    { label: t('groups.foldAll'), icon: '⌃', onSelect: foldAll },
  ];
}

/** La burbuja ya dice «Sidechat»: el título no lo repite. */
const sideTitle = (title: string) => title.replace(/^(Sidechat|Consulta)\s*·\s*/i, '');

/** Fila de conversación de la barra lateral (grupos y DMs). */
export function ConvItem({ c, active, showWs = false, extraMenu = [] }: { c: ConversationDTO; active: boolean; showWs?: boolean; extraMenu?: MenuItem[] }) {
  const d = useClient((s) => s.data)!;
  const muted = isMuted(c);
  const other = c.kind === 'direct' ? personById(d, c.memberIds.find((m) => m !== d.me.id)) : null;
  const ws = showWs ? d.workspaces.find((w) => w.id === c.workspaceId) : null;
  const side = c.deriveKind === 'side';
  const origin = side && c.parentId ? d.conversations.find((x) => x.id === c.parentId) : null;
  const orgOfWs = c.workspaceId ? (() => { const w = d.workspaces.find((x) => x.id === c.workspaceId); return w ? placeWorkspace(d, w).org : null; })() : null;
  return (
    <button className={`side-conv ${active ? 'active' : ''} ${c.unread && !muted ? 'unread' : ''} ${muted ? 'is-muted' : ''}`} onClick={() => navigate(`/c/${c.id}`)}
      {...menuProps(() => [...conversationMenu(c, { onNewMeeting: () => newEvent({ conversationId: c.id }) }), ...extraMenu])}>
      {other ? <Avatar person={other} org={orgById(d, other.orgId)} size={22} />
        : c.kind === 'internal' ? <span className="hash" aria-hidden>🔒</span>
        : <ConvAvatar c={c} size={22} fallback={c.kind === 'multi' && !side ? <StackedAvatars c={c} size={20} /> : undefined} />}
      {side && <span className="chip-side">{t('groups.sidechat')}</span>}
      <span className="grow ellipsis">
        {origin && <span className="muted small">{t('groups.fromOrigin', { name: conversationTitle(d, origin) })} · </span>}
        {side ? sideTitle(conversationTitle(d, c)) : conversationTitle(d, c)}
        {ws ? <span className="muted small"> · {ws.name}</span> : null}
      </span>
      {muted && <span className="small" title={t('side.muted')}>🔕</span>}
      {(c.unreadMentions ?? 0) > 0 && <span className="pill mention-pill" title={t('mention.youMentioned')}>@</span>}
      {c.unread > 0 && <span className={`pill ${muted ? 'is-muted' : ''}`} style={{ background: badgeColor(orgOfWs) }}>{c.unread}</span>}
    </button>
  );
}

export function DmsList({ tab = 'all', activeConv = null }: { tab?: HomeTab; activeConv?: string | null }) {
  const d = useClient((s) => s.data)!;
  const list = dmConversations(d, tab);
  return <>{list.map((c) => <ConvItem key={c.id} c={c} active={activeConv === c.id} />)}</>;
}

// ---------- Pantallas móviles: Grupos y DMs ----------
export function GroupsScreen() {
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <div className="row"><h1 className="grow">{t('nav.groups')}</h1>
        <button className="btn small" onClick={() => openDialog((close) => <JoinWithCodeDialog onClose={close} />)}>{t('join.title')}</button>
        <button className="btn primary small" onClick={() => openCreateGroup()}>＋ {t('groups.new')}</button>
      </div>
      <div className="card" style={{ padding: 6, marginTop: 14 }}><GroupsTree /></div>
    </div></div>
  );
}

export function DmsScreen() {
  const d = useClient((s) => s.data)!;
  const n = dmConversations(d).length;
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <div className="row"><h1 className="grow">{t('nav.dms')}</h1>
        <button className="btn primary small" onClick={() => openDialog((close) => <NewChatDialog onClose={close} />)}>＋ {t('dms.new')}</button>
      </div>
      <div className="card" style={{ padding: 6, marginTop: 14 }}>
        {n ? <DmsList /> : <div className="empty">{t('dms.empty')}</div>}
      </div>
    </div></div>
  );
}

// ---------- Nuevo grupo ----------
type Preset = { kind: 'org'; orgId?: string } | { kind: 'company' } | { kind: 'workspace'; workspaceId: string };
export function openCreateGroup(preset?: Preset) { openDialog((close) => <CreateGroupDialog preset={preset} onClose={close} />); }

/** Relaciones donde puedo crear grupos: espacios que no son casa, donde no soy tercero. */
function relationOptions(d: BootstrapDTO) {
  return d.workspaces.filter((w) => !w.isOrgHome && w.myRole !== 'guest')
    .map((w) => ({ w, p: placeWorkspace(d, w) }))
    .filter((x) => x.p.section === 'relations')
    .map(({ w, p }) => ({ id: w.id, label: w.name.toLowerCase() === p.name.toLowerCase() ? p.name : `${p.name} · ${w.name}`, pending: p.pending }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
const splitEmails = (s: string) => [...new Set(s.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
const looksEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

export function CreateGroupDialog({ preset, onClose }: { preset?: Preset; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const myOrgs = d.organizations.filter((o) => o.myRole);
  const relations = relationOptions(d);
  const [forWhom, setForWhom] = useState<'org' | 'other'>(preset && preset.kind !== 'org' ? 'other' : 'org');
  const [orgId, setOrgId] = useState((preset?.kind === 'org' && preset.orgId) || d.me.primaryOrgId || myOrgs[0]?.id || '');
  const [relation, setRelation] = useState<string>(preset?.kind === 'workspace' ? preset.workspaceId : preset?.kind === 'company' || !relations[0] ? 'new' : relations[0].id);
  const [company, setCompany] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<'member' | 'guest'>('member');
  const [share, setShare] = useState(preset ? preset.kind !== 'org' : false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ conversationId: string; url: string; code: string | null } | null>(null);

  const orgName = orgById(d, orgId)?.name ?? '';
  const target: CreateGroupRequest['target'] = forWhom === 'org' ? { kind: 'org', orgId }
    : relation === 'new' ? { kind: 'company', companyName: company.trim(), orgId } : { kind: 'workspace', workspaceId: relation };
  const wsMembers = target.kind === 'workspace' ? new Set(d.workspaces.find((w) => w.id === target.workspaceId)?.memberIds ?? []) : null;
  const candidates = d.people.filter((p) => p.id !== d.me.id && p.kind === 'human' && (wsMembers ? wsMembers.has(p.id) : p.orgId === orgId));
  const list = splitEmails(emails);
  const bad = list.filter((e) => !looksEmail(e));
  const inviteRole = forWhom === 'org' ? 'guest' : role;
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    client.createGroup({ name: name.trim(), target, memberIds: picked.filter((p) => candidates.some((c) => c.id === p)), inviteEmails: list, inviteRole, shareLink: share, lang: getLang() })
      .then((r) => { if (r.inviteUrl) setDone({ conversationId: r.conversationId, url: r.inviteUrl, code: r.inviteCode ?? null }); else { onClose(); navigate(`/c/${r.conversationId}`); } })
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  if (done) {
    return (
      <Modal title={t('share.inviteTitle', { name: name.trim() })} onClose={() => { onClose(); navigate(`/c/${done.conversationId}`); }}>
        <ShareInvite url={done.url} code={done.code} groupName={name.trim()} />
        <div className="modal-actions"><button className="btn primary" onClick={() => { onClose(); navigate(`/c/${done.conversationId}`); }}>{t('share.openGroup')}</button></div>
      </Modal>
    );
  }
  return (
    <Modal title={t('groups.new')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="field"><span>{t('groups.forWhom')}</span>
          <div className="seg">
            <button type="button" className={forWhom === 'org' ? 'on' : ''} onClick={() => { setForWhom('org'); setShare(false); }}>{t('groups.onlyOrg', { org: orgName })}</button>
            <button type="button" className={forWhom === 'other' ? 'on' : ''} onClick={() => { setForWhom('other'); setShare(true); }}>{t('groups.withCompany')}</button>
          </div>
          <span className="hint">{forWhom === 'org' ? t('groups.onlyOrgHint') : t('groups.withCompanyHint')}</span>
        </div>
        {myOrgs.length > 1 && (
          <label className="field"><span>{t('groups.asOrg')}</span>
            <select className="input" value={orgId} onChange={(e) => setOrgId(e.target.value)}>{myOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          </label>
        )}
        {forWhom === 'other' && (
          <>
            <label className="field"><span>{t('groups.company')}</span>
              <select className="input" value={relation} onChange={(e) => setRelation(e.target.value)}>
                {relations.map((r) => <option key={r.id} value={r.id}>{r.label}{r.pending ? ` (${t('groups.pending')})` : ''}</option>)}
                <option value="new">{t('groups.newCompany')}</option>
              </select>
            </label>
            {relation === 'new' && (
              <label className="field"><span>{t('groups.companyName')}</span>
                <input className="input" required minLength={2} value={company} onChange={(e) => setCompany(e.target.value)} placeholder={t('groups.companyNamePh')} />
              </label>
            )}
          </>
        )}
        <label className="field"><span>{t('groups.name')}</span>
          <input className="input" required minLength={2} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('groups.namePh')} />
        </label>
        <div className="field"><span>{target.kind === 'workspace' ? t('groups.peopleHere') : t('groups.peopleOf', { org: orgName })}</span>
          {candidates.length === 0 && <span className="hint">{t('dlg.noCandidates')}</span>}
          <div className="list" style={{ maxHeight: 200, overflow: 'auto' }}>
            {candidates.map((p) => (
              <label key={p.id} className="check">
                <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
                <Avatar person={p} org={orgById(d, p.orgId)} size={26} />
                <span className="grow"><b>{p.name}</b><span className="small muted"> · {[p.title, orgById(d, p.orgId)?.name ?? t('common.guest')].filter(Boolean).join(' · ')}</span></span>
              </label>
            ))}
          </div>
        </div>
        <label className="field"><span>{t('groups.inviteOutside')}</span>
          <textarea className="input" rows={2} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder={t('groups.emailsPh')} />
          {bad.length > 0 && <span className="error">{t('groups.badEmails', { list: bad.join(', ') })}</span>}
        </label>
        {forWhom === 'other'
          ? <RolePicker role={role} setRole={setRole} company={relation === 'new' ? company.trim() : relations.find((r) => r.id === relation)?.label ?? ''} />
          : <span className="hint">{t('groups.guestOnlyHint')}</span>}
        <label className="check"><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /><span className="grow">{t('groups.shareLink')}<span className="small muted" style={{ display: 'block' }}>{t('groups.shareLinkHint')}</span></span></label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || bad.length > 0}>{busy ? t('common.wait') : t('groups.create')}</button></div>
      </form>
    </Modal>
  );
}

function RolePicker({ role, setRole, company }: { role: 'member' | 'guest'; setRole: (r: 'member' | 'guest') => void; company: string }) {
  return (
    <div className="field"><span>{t('invite.roleQ')}</span>
      <div className="seg">
        <button type="button" className={role === 'member' ? 'on' : ''} onClick={() => setRole('member')}>{company ? t('invite.fromCompanyNamed', { name: company }) : t('invite.fromCompany')}</button>
        <button type="button" className={role === 'guest' ? 'on' : ''} onClick={() => setRole('guest')}>{t('invite.thirdParty')}</button>
      </div>
      <span className="hint">{role === 'member' ? t('invite.memberHint') : t('invite.guestHint')}</span>
    </div>
  );
}

// ---------- Invitar a un grupo: correo, enlace o código ----------
export function InviteToGroupDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const conv = d.conversations.find((c) => c.id === conversationId);
  const ws = d.workspaces.find((w) => w.id === conv?.workspaceId);
  const home = !!ws?.isOrgHome;
  const [role, setRole] = useState<'member' | 'guest'>(home ? 'guest' : 'member');
  const [mode, setMode] = useState<'link' | 'email'>('link');
  const [emails, setEmails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; code: string | null; expiresAt: string } | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  if (!conv || !ws) return null;
  const groupName = conversationTitle(d, conv);
  const company = placeWorkspace(d, ws).name;
  const list = splitEmails(emails);
  const bad = list.filter((e) => !looksEmail(e));
  const base = { role, conversationIds: [conv.id], history: 'all' as const, lang: getLang() };

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const makeLink = () => run(async () => {
    const r = await client.createInvitation(ws.id, { ...base, multiUse: true, expiresInDays: 14 });
    setLink({ url: r.url, code: r.code, expiresAt: r.expiresAt });
  });
  const sendEmails = () => run(async () => {
    let n = 0;
    for (const email of list) { await client.createInvitation(ws.id, { ...base, email }); n++; }
    setSent(n);
  });

  return (
    <Modal title={t('groups.inviteTo', { name: groupName })} onClose={onClose}>
      {home ? <span className="hint">{t('groups.guestOnlyHint')}</span> : <RolePicker role={role} setRole={(r) => { setRole(r); setLink(null); }} company={company} />}
      <div className="seg">
        <button type="button" className={mode === 'link' ? 'on' : ''} onClick={() => setMode('link')}>{t('invite.byLink')}</button>
        <button type="button" className={mode === 'email' ? 'on' : ''} onClick={() => setMode('email')}>{t('invite.byEmail')}</button>
      </div>
      {mode === 'link' && (link
        ? <ShareInvite url={link.url} code={link.code} groupName={groupName} expiresAt={link.expiresAt} />
        : <button className="btn primary" disabled={busy} onClick={makeLink}>{busy ? t('common.wait') : t('invite.makeLink')}</button>)}
      {mode === 'email' && (
        <>
          <label className="field"><span>{t('invite.emails')}</span>
            <textarea className="input" rows={3} value={emails} onChange={(e) => { setEmails(e.target.value); setSent(null); }} placeholder={t('groups.emailsPh')} />
            {bad.length > 0 && <span className="error">{t('groups.badEmails', { list: bad.join(', ') })}</span>}
          </label>
          {sent !== null && <div className="hint">{t('invite.sentN', { n: sent })}</div>}
          <button className="btn primary" disabled={busy || !list.length || bad.length > 0} onClick={sendEmails}>{busy ? t('common.wait') : t('dlg.sendInvite')}</button>
        </>
      )}
      {error && <div className="error">{error}</div>}
      <div className="modal-actions"><button className="btn" onClick={onClose}>{t('common.done')}</button></div>
    </Modal>
  );
}

/** El código en grande, el enlace y compartir. */
export function ShareInvite({ url, code, groupName, expiresAt }: { url: string; code: string | null; groupName: string; expiresAt?: string }) {
  const text = code ? t('share.text', { name: groupName, url, code }) : t('share.textNoCode', { name: groupName, url });
  return (
    <div className="share-invite">
      {code && (
        <div className="code-box">
          <span className="eyebrow">{t('share.code')}</span>
          <span className="code-big" aria-label={code.split('').join(' ')}>{code}</span>
          <button className="btn small" onClick={async () => { await copyText(code); toast(t('share.codeCopied')); }}>{t('share.copyCode')}</button>
        </div>
      )}
      <div className="linkbox"><input className="input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button className="btn small" onClick={async () => { await copyText(url); toast(t('toast.linkCopied')); }}>{t('common.copy')}</button>
      </div>
      {'share' in navigator && <button className="btn" onClick={() => navigator.share({ title: 'TieComs', text }).catch(() => {})}>{t('share.share')}</button>}
      <span className="hint">{expiresAt ? t('share.expires', { date: new Date(expiresAt).toLocaleDateString(locale(), { day: 'numeric', month: 'long' }) }) : t('share.expires14')}</span>
    </div>
  );
}

// ---------- Unirme con código ----------
export function JoinWithCodeDialog({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('');
  const [inv, setInv] = useState<InvitationPreviewDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = code.trim();
  const look = (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(null); client.previewInvitation(clean).then(setInv).catch((err) => setError(errorText(err))).finally(() => setBusy(false)); };
  const accept = () => {
    setBusy(true); setError(null);
    client.acceptInvitation(clean).then((r) => { onClose(); navigate(r.conversationIds[0] ? `/c/${r.conversationIds[0]}` : `/w/${r.workspaceId}`); })
      .catch((err) => setError(errorText(err))).finally(() => setBusy(false));
  };
  return (
    <Modal title={t('join.title')} onClose={onClose}>
      {!inv && (
        <form onSubmit={look} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="field"><span>{t('join.label')}</span>
            <input className="input code-input" autoFocus autoCapitalize="characters" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder="K7QM-4XPA" />
          </label>
          <span className="hint">{t('join.hint')}</span>
          {error && <div className="error">{error}</div>}
          <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || clean.replace(/[^a-z0-9]/gi, '').length < 8}>{busy ? t('common.wait') : t('join.look')}</button></div>
        </form>
      )}
      {inv && (
        <>
          <InvitePreviewText inv={inv} />
          {!inv.valid && <div className="error">{t('invite.invalid')}</div>}
          {error && <div className="error">{error}</div>}
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => { setInv(null); setError(null); }}>{t('common.back')}</button>
            {inv.valid && <button className="btn primary" disabled={busy} onClick={accept}>{busy ? t('invite.accepting') : t('join.accept')}</button>}
          </div>
        </>
      )}
    </Modal>
  );
}

/** «Ana de Xertify te invita a Pagos en Nestlé» (también en /invite/:token). */
export function InvitePreviewText({ inv }: { inv: InvitationPreviewDTO }) {
  const groups = inv.groupNames?.length ? inv.groupNames.join(', ') : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="serif" style={{ fontSize: 26, lineHeight: 1.15 }}>{groups ?? inv.workspaceName}</div>
      <div className="muted">{groups
        ? t('join.byGroups', { name: inv.invitedByName, org: inv.invitedByOrg ? ` · ${inv.invitedByOrg}` : '', where: inv.workspaceName })
        : t('invite.by', { name: inv.invitedByName, org: inv.invitedByOrg ? ` · ${inv.invitedByOrg}` : '', role: t(`role.${inv.role}` as 'role.member') })}</div>
      {inv.role === 'guest' && <span className="tag" style={{ alignSelf: 'flex-start' }}>{t('join.asGuest')}</span>}
      {inv.multiUse && <span className="hint">{t('join.multi')}</span>}
    </div>
  );
}

// ---------- Supervisión ----------
export function OversightScreen({ orgId }: { orgId: string }) {
  const d = useClient((s) => s.data)!;
  const org = orgById(d, orgId);
  const [data, setData] = useState<OversightDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { client.loadOversight(orgId).then(setData).catch((e) => setError(errorText(e))); }, [orgId]);
  const byWs = new Map<string, OversightDTO['groups']>();
  for (const g of data?.groups ?? []) { if (!byWs.has(g.workspaceId)) byWs.set(g.workspaceId, []); byWs.get(g.workspaceId)!.push(g); }
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <h1>{t('over.title', { org: org?.name ?? '' })}</h1>
      <p className="muted">{t('over.body')}</p>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="muted">{t('common.loading')}</div>}
      {data && !data.groups.length && <div className="empty">{t('over.empty')}</div>}
      {[...byWs.values()].map((gs) => {
        const head = gs[0]!;
        const other = head.organizationIds.filter((o) => o !== orgId).map((o) => orgById(d, o)?.name).filter(Boolean).join(', ');
        return (
          <section key={head.workspaceId} style={{ marginTop: 18 }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>{head.workspaceName}{other && other.toLowerCase() !== head.workspaceName.toLowerCase() ? ` · ${other}` : ''}</div>
            <div className="list">
              {gs.map((g) => (
                <button key={g.conversationId} className="card conv-card" onClick={() => navigate(g.iAmMember ? `/c/${g.conversationId}` : `/ver/${g.conversationId}?n=${encodeURIComponent(g.name ?? '')}`)}>
                  <span className="hash" aria-hidden>{g.kind === 'internal' ? '🔒' : '#'}</span>
                  <span className="grow"><b>{g.name ?? t('chat.aConversation')}</b>
                    <span className="small muted" style={{ display: 'block' }}>{[g.myOrgMemberIds.map((id) => personById(d, id)?.name.split(' ')[0]).filter(Boolean).join(', '), tn(g.memberCount, 'over.member', 'over.members'), g.lastMessageAt ? timeLabel(g.lastMessageAt) : null].filter(Boolean).join(' · ')}</span>
                  </span>
                  {!g.iAmMember && <span className="tag">{t('over.readOnly')}</span>}
                  <span className="muted">›</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div></div>
  );
}

/** Visor de solo lectura (supervisión): mensajes sin compositor. */
export function ReadOnlyConversationScreen({ id }: { id: string }) {
  const d = useClient((s) => s.data)!;
  const [msgs, setMsgs] = useState<MessageDTO[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = (before?: number) => client.readOnlyMessages(id, before)
    .then((r) => { setMsgs((m) => [...r.messages, ...m]); setHasMore(r.hasMore); })
    .catch((e) => setError(errorText(e)));
  useEffect(() => { setMsgs([]); void load(); }, [id]);
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 820 }}>
      <div className="row"><button className="btn ghost small" onClick={() => history.back()}>‹ {t('common.back')}</button></div>
      {queryParam('n') && <h1 style={{ marginTop: 8 }}>{queryParam('n')}</h1>}
      <div className="readonly-banner" role="note">{t('over.banner')}</div>
      {!error && msgs.length > 0 && msgs.every((m) => m.kind === 'system') && <div className="empty">{t('over.noMessages')}</div>}
      {error && <div className="error">{error}</div>}
      {hasMore && <button className="btn small" onClick={() => load(msgs[0]?.seq)}>{t('over.older')}</button>}
      <div className="list" style={{ gap: 8, marginTop: 10 }}>
        {msgs.map((m) => {
          const p = personById(d, m.authorId);
          if (m.kind === 'system') return null;
          return (
            <div key={m.id} className="card" style={{ padding: '8px 12px' }}>
              <div className="small muted">{p?.name ?? t('common.participant')} · {new Date(m.createdAt).toLocaleString(locale())}</div>
              {m.deletedAt ? <i className="muted">{t('chat.deleted')}</i> : <MessageText d={d} body={m.body} mentions={m.mentions} />}
              {!!m.attachments?.length && <div className="small muted">📎 {m.attachments.map((a) => a.name).join(', ')}</div>}
            </div>
          );
        })}
      </div>
    </div></div>
  );
}
