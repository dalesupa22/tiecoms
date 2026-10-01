import { usePersonalPreferences } from '../personal-prefs.ts';
import { CallDot } from './Call.tsx';
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { BootstrapDTO, ConversationDTO, CreateGroupRequest, InvitationPreviewDTO, IssueDTO, MessageDTO, OrganizationDTO, OversightDTO, WorkspaceDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, getLang, locale, t, tn } from '../i18n.ts';
import { navigate, queryParam } from '../router.ts';
import { DRAG_TYPE } from '../split.ts';
import { directOtherId, Avatar, ConvAvatar, Modal, OrgMark, SideIcon, badgeColor, conversationPreview, conversationTitle, orgById, personById, timeLabel, isGgChat, isSelfChat } from '../ui.tsx';
import { openGgChat, openSelfChat } from './Assistant.tsx';
import { asset } from '../router.ts';
import { conversationMenu, mutedText, openDialog } from '../actions.tsx';
import { DndStrip } from './Silence.tsx';
import { copyText, menuProps, openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { newEvent } from './Calendar.tsx';
import { InviteDialog } from './Dialogs.tsx';
import { IssueCheck, NewIssueDialog, isClosed, issueQuickMenu, localIso } from './Issues.tsx';
import { MessageText } from './Mentions.tsx';
import { StackedAvatars } from './Chats.tsx';
import { companyLine } from '../quick-search.ts';
import { QuickActions, QuickSearchField, QuickSearchSections, openNewMessage } from './Quick.tsx';
import { matchesTab, type HomeTab } from './Shell.tsx';
import { activityOf, compareConversations, pendingOf, treeOnlyPending, withSeparators, withTree } from '../home-order.ts';

// ---------- Árbol de Grupos (mismas reglas en web, iOS y Android: docs/GRUPOS.md) ----------
/** label: el nombre a mostrar; si dos grupos de la misma empresa se llaman igual, lleva delante el espacio de donde viene. */
export interface GroupNode { conv: ConversationDTO; derived: ConversationDTO[]; issues: IssueDTO[]; label?: string }
export interface WsNode { ws: WorkspaceDTO; header: boolean; groups: GroupNode[] }
export interface CompanyNode { key: string; org: OrganizationDTO | null; name: string; pending: boolean; workspaces: WsNode[] }
export interface GroupSection { key: string; kind: 'org' | 'relations' | 'guest'; org: OrganizationDTO | null; companies: CompanyNode[] }

const isMuted = (c: ConversationDTO) => !!c.mutedUntil && Date.parse(c.mutedUntil) > Date.now();
const openIssuesOf = (issues: Record<string, IssueDTO>, conversationId: string) =>
  Object.values(issues).filter((i) => i.conversationId === conversationId && !isClosed(i) && !i.parentIssueId)
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.updatedAt.localeCompare(a.updatedAt));

// Empresas y espacios siguen el orden de la bandeja: con algo fijado arriba, luego menciones, no leídos y actividad.
type Rank = { pinned: boolean; mention: boolean; unread: number; activity: string };
function rankOf(convs: ConversationDTO[]): Rank {
  return {
    pinned: convs.some((c) => !!c.pinnedAt), mention: convs.some((c) => (c.unreadMentions ?? 0) > 0),
    unread: convs.reduce((n, c) => n + pendingOf(c), 0), activity: convs.reduce((m, c) => (activityOf(c) > m ? activityOf(c) : m), ''),
  };
}
function byRank(a: Rank, b: Rank) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.mention !== b.mention) return a.mention ? -1 : 1;
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
      // El grupo se ordena con los pendientes de sus derivadas (un hilo sin leer sube el grupo).
      .sort((a, b) => compareConversations(withTree(a.conv, a.derived), withTree(b.conv, b.derived)));
    // Solo hay grupos y asuntos: un espacio sin grupos (archivado o vacío) no aparece.
    if (!groups.length && !(tab === 'all' && w.counterpartName)) continue;
    const p = placeWorkspace(d, w);
    if (!companies.has(p.companyKey)) companies.set(p.companyKey, { key: p.companyKey, org: p.org, name: p.name, pending: p.pending, workspaces: [], section: p.section });
    companies.get(p.companyKey)!.workspaces.push({ ws: w, header: !w.isOrgHome, groups });
  }
  const list = [...companies.values()];
  for (const c of list) {
    c.workspaces.sort((a, b) => Number(!!b.ws.isOrgHome) - Number(!!a.ws.isOrgHome) || byRank(rankOf(convsOfWs(a)), rankOf(convsOfWs(b))) || a.ws.id.localeCompare(b.ws.id));
    // Solo grupos y asuntos: nunca cabecera de espacio. Si dos grupos de la empresa se llaman igual
    // (p. ej. dos «General»), el nombre lleva delante el espacio de donde viene.
    const count = new Map<string, number>();
    for (const w of c.workspaces) { w.header = false; for (const g of w.groups) { const k = conversationTitle(d, g.conv).toLowerCase(); count.set(k, (count.get(k) ?? 0) + 1); } }
    for (const w of c.workspaces) for (const g of w.groups) {
      const title = conversationTitle(d, g.conv);
      g.label = (count.get(title.toLowerCase()) ?? 0) > 1 && !w.ws.isOrgHome ? `${w.ws.name} · ${title}` : title;
    }
  }
  const sorted = (xs: typeof list) => xs.sort((a, b) => byRank(rankOf(convsOfCompany(a)), rankOf(convsOfCompany(b))) || a.key.localeCompare(b.key));
  const myOrgs = d.organizations.filter((o) => o.myRole);
  const sections: GroupSection[] = myOrgs.map((o) => ({ key: `org:${o.id}`, kind: 'org', org: o, companies: list.filter((c) => c.section === 'org' && c.key === `org:${o.id}`) }));
  sections.push({ key: 'relations', kind: 'relations', org: null, companies: sorted(list.filter((c) => c.section === 'relations')) });
  const guest = sorted(list.filter((c) => c.section === 'guest'));
  if (guest.length) sections.push({ key: 'guest', kind: 'guest', org: null, companies: guest });
  return sections;
}

/** DMs: directos y chats grupales, incluidos los sidechats (con su burbuja). Los hilos de un chat viven en su barra. */
export function dmConversations(d: BootstrapDTO, tab: HomeTab = 'all') {
  return d.conversations.filter((c) => (c.kind === 'direct' || c.kind === 'multi') && !(c.parentId && c.deriveKind !== 'side') && matchesTab(c, tab)).sort(compareConversations);
}

// ---------- Plegado (por dispositivo) ----------
// Un solo estado para la barra lateral, la pantalla Grupos y su botón de vista (se guardan en este dispositivo).
function persisted(key: string) {
  let value: Set<string> = (() => { try { return new Set<string>(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { return new Set<string>(); } })();
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: Set<string>) => { value = next; try { localStorage.setItem(key, JSON.stringify([...next])); } catch {} listeners.forEach((l) => l()); },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}
const foldStore = persisted('tiecoms:folded');
// Asuntos bajo cada grupo: contraídos por defecto; se recuerdan los que la persona abre (por dispositivo).
const issuesStore = persisted('tiecoms:issuesOpen');
const useStore = (st: ReturnType<typeof persisted>) => useSyncExternalStore(st.subscribe, st.get);

function useFolded() {
  const folded = useStore(foldStore);
  return {
    folded,
    toggle: (k: string) => { const n = new Set(folded); if (n.has(k)) n.delete(k); else n.add(k); foldStore.set(n); },
  };
}
type IssuesOpen = { open: Set<string>; toggle: (id: string) => void };
function useIssuesOpen(): IssuesOpen {
  const open = useStore(issuesStore);
  return { open, toggle: (id) => { const n = new Set(open); if (n.has(id)) n.delete(id); else n.add(id); issuesStore.set(n); } };
}

/** Plegar y desplegar todo el árbol (botón de vista, cabeceras de sección y empresas). */
function treeControls(sections: GroupSection[]): TreeMenu {
  const allKeys = sections.flatMap((s) => s.companies.flatMap((c) => [c.key, ...c.workspaces.map((w) => `ws:${w.ws.id}`)]));
  const withIssues = sections.flatMap((s) => s.companies.flatMap((c) => c.workspaces.flatMap((w) => w.groups.filter((g) => g.issues.length).map((g) => g.conv.id))));
  return {
    // Contraer todo deja visibles las secciones (solo pliega empresas y espacios).
    foldAll: () => { foldStore.set(new Set([...foldStore.get(), ...allKeys])); issuesStore.set(new Set()); },
    unfoldAll: () => { foldStore.set(new Set()); issuesStore.set(new Set(withIssues)); },
    showIssues: () => issuesStore.set(new Set(withIssues)),
    hideIssues: () => issuesStore.set(new Set()),
  };
}

/** Botón de vista (plegar y desplegar), aparte de ✎ y «＋», que son para escribir y crear. */
export function GroupsViewButton({ tab = 'all', withView = false }: { tab?: HomeTab; withView?: boolean }) {
  const label = withView ? t('inbox.view') : t('grp.foldMenu');
  return (
    <button className="icon-btn view-btn" title={label} aria-label={label} aria-haspopup="menu"
      onClick={(e) => {
        const s = client.getState();
        const r = e.currentTarget.getBoundingClientRect();
        const tree = viewStore.get() === 'tree';
        // En la barra de la web: Lista | Árbol arriba y, en Árbol, plegar y desplegar debajo.
        const view: MenuItem[] = withView ? [
          ...(['list', 'tree'] as const).map((v) => ({ label: t(v === 'list' ? 'inbox.list' : 'inbox.tree'), icon: viewStore.get() === v ? '✓' : '', onSelect: () => viewStore.set(v) })),
          ...(tree ? [{ divider: true } as MenuItem] : []),
        ] : [];
        openMenuAt(r.left, r.bottom + 4, [...view, ...(tree || !withView ? treeMenuItems(treeControls(buildGroupTree(s.data!, s.issues, tab))) : [])]);
      }}>☰</button>
  );
}

// ---------- Vista del árbol ----------
export function GroupsTree({ tab = 'all', activeConv = null }: { tab?: HomeTab; activeConv?: string | null }) {
  const raw = useClient((s) => s.data)!;
  const personal = usePersonalPreferences();
  const d = useMemo(() => ({ ...raw, conversations: raw.conversations.filter((c) => !personal.conversations[c.id]?.archived) }), [raw, personal]);
  const issues = useClient((s) => s.issues);
  const sections = useMemo(() => buildGroupTree(d, issues, tab), [d, issues, tab]);
  const { folded, toggle } = useFolded();
  const issuesOpen = useIssuesOpen();
  const treeMenu = treeControls(sections);

  return (
    <div className="groups-tree">
      {sections.map((s) => {
        const title = s.kind === 'org' ? t('groups.yourOrg', { org: s.org?.name ?? '' }) : s.kind === 'relations' ? t('groups.relations') : t('groups.guestIn');
        const plus = s.kind === 'org' ? () => openCreateGroup({ kind: 'org', orgId: s.org?.id }) : s.kind === 'relations' ? () => openCreateGroup({ kind: 'company' }) : null;
        const empty = s.companies.every((c) => c.workspaces.every((w) => !w.groups.length));
        const sKey = `sec:${s.key}`;
        const sFold = folded.has(sKey);
        const sUnread = s.companies.reduce((n, c) => n + convsOfCompany(c).reduce((m, x) => m + (isMuted(x) ? 0 : x.unread), 0), 0);
        return (
          <section key={s.key} className="groups-section">
            <div className="row groups-section-head">
              <button className="groups-section-toggle grow" aria-expanded={!sFold} onClick={() => toggle(sKey)} {...menuProps(() => treeMenuItems(treeMenu))}>
                <span className="eyebrow">{title}</span>
                <span className="muted small" aria-hidden>{sFold ? '›' : '⌄'}</span>
                {sFold && sUnread > 0 && <span className="pill">{sUnread}</span>}
              </button>
              {plus && <button className="btn ghost small" onClick={plus} title={t('groups.new')} aria-label={`${t('groups.new')} · ${title}`}>＋</button>}
            </div>
            {!sFold && empty && tab === 'all' && <div className="hint" style={{ padding: '2px 10px 8px' }}>{s.kind === 'org' ? t('groups.emptyOrg') : t('groups.emptyRelations')}</div>}
            {!sFold && s.companies.map((c) => {
              const cKey = c.key;
              const fold = folded.has(cKey);
              const unread = convsOfCompany(c).reduce((n, x) => n + (isMuted(x) ? 0 : x.unread), 0);
              // Nunca hay cabecera de espacio: los grupos de todos los espacios de la empresa van juntos, en el orden de la bandeja.
              const body = companyGroups(c).map(({ g, ws }) => <GroupEntry key={g.conv.id} g={g} ws={ws} issuesOpen={issuesOpen} active={activeConv === g.conv.id} />);
              // Tu organización: los grupos van directo, sin cabecera de empresa.
              if (s.kind === 'org') return <div key={cKey}>{body}</div>;
              return (
                <div key={cKey} className="groups-company">
                  <button className="side-org groups-company-head" aria-expanded={!fold} onClick={() => toggle(cKey)}
                    {...menuProps(() => companyMenu(c, treeMenu))}>
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

/** Los grupos de una empresa (de todos sus espacios) en el orden de la bandeja: fijados, menciones, no leídos, actividad. */
function companyGroups(c: CompanyNode) {
  return c.workspaces.flatMap((w) => w.groups.map((g) => ({ g, ws: w.ws }))).sort((a, b) => compareConversations(a.g.conv, b.g.conv));
}

/** Fila de grupo y, si la persona los abrió con el chip ◆, sus asuntos activos debajo. */
function GroupEntry({ g, ws, issuesOpen, active, label, preview, showOrg }: { g: GroupNode; ws: WorkspaceDTO; issuesOpen: IssuesOpen; active: boolean; label?: string; preview?: boolean; showOrg?: boolean }) {
  return (
    <div>
      <ConvItem c={g.conv} active={active} label={label ?? g.label} preview={preview} showOrg={showOrg} threadUnread={treeOnlyPending(g.conv, g.derived)} treeMentions={g.derived.reduce((n, x) => n + (x.unreadMentions ?? 0), 0)} extraMenu={groupMenuExtra(g.conv, ws)}
        issues={{ count: g.issues.length, overdue: overdueCount(g.issues), open: issuesOpen.open.has(g.conv.id), onToggle: () => issuesOpen.toggle(g.conv.id) }} />
      {g.issues.length > 0 && issuesOpen.open.has(g.conv.id) && <IssueLines g={g} />}
    </div>
  );
}

const overdueCount = (list: IssueDTO[]) => { const today = localIso(); return list.filter((i) => i.dueDate && i.dueDate < today).length; };

/**
 * Asuntos activos bajo el grupo, cuando la persona los abre con el chip ◆ de la fila: hasta 3 y «+N asuntos».
 * Clic derecho o pulsación larga en un asunto: completarlo o cambiar su estado.
 */
function IssueLines({ g }: { g: GroupNode }) {
  const d = useClient((s) => s.data)!;
  const today = localIso();
  const shown = g.issues.slice(0, 3);
  return (
    <div className="group-issues">
      {shown.map((i) => (
        <div role="button" tabIndex={0} key={i.id} className="group-issue" onClick={() => navigate(`/c/${g.conv.id}?issue=${i.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/c/${g.conv.id}?issue=${i.id}`); }} {...menuProps(() => issueQuickMenu(i))}>
          <IssueCheck i={i} size={16} />
          <span className="grow ellipsis">{i.title}</span>
          {(i.status === 'in_progress' || i.status === 'waiting') && <span className="tag">{t(`issue.st.${i.status}`)}</span>}
          {i.ownerId && i.ownerId !== d.me.id && <span className="small muted issue-owner-mini">{personById(d, i.ownerId)?.name.split(' ')[0]}</span>}
          {i.dueDate && <span className={`small ${i.dueDate < today ? 'overdue' : 'muted'}`}>{new Date(`${i.dueDate}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}</span>}
        </div>
      ))}
      {g.issues.length > 3 && (
        <button className="group-issue more" onClick={() => navigate(`/c/${g.conv.id}`)}>{t('groups.moreIssues', { n: g.issues.length - 3 })}</button>
      )}
    </div>
  );
}

function groupMenuExtra(c: ConversationDTO, ws: WorkspaceDTO): MenuItem[] {
  return [
    { divider: true },
    ...(ws.myRole !== 'guest' && c.canPost ? [{ label: t('issue.new'), icon: '◆', onSelect: () => openDialog((close) => <NewIssueDialog conversationId={c.id} onClose={close} onCreated={(i) => navigate(`/c/${c.id}?issue=${i.id}`)} />) }] : []),
    ...(ws.myRole !== 'guest' && c.kind === 'group' ? [{ label: t('groups.inviteToGroup'), icon: '＋', onSelect: () => openDialog((close) => <InviteToGroupDialog conversationId={c.id} onClose={close} />) }] : []),
    ...(c.canManage ? [{ divider: true }, { label: t('groups.archive'), icon: '🗄', danger: true, onSelect: () => {
      if (!confirm(t('groups.archiveConfirm', { name: conversationTitle(client.getState().data!, c) }))) return;
      client.archiveGroup(c.id).then(() => toast(t('groups.archived'))).catch((e) => toast(errorText(e)));
    } }] : []),
  ];
}

interface TreeMenu { foldAll: () => void; unfoldAll: () => void; showIssues: () => void; hideIssues: () => void }
function treeMenuItems(m: TreeMenu): MenuItem[] {
  return [
    { label: t('groups.showAllIssues'), icon: '◆', onSelect: m.showIssues },
    { label: t('groups.hideAllIssues'), icon: '◇', onSelect: m.hideIssues },
    { divider: true },
    { label: t('groups.foldAll'), icon: '⌃', onSelect: m.foldAll },
    { label: t('groups.unfoldAll'), icon: '⌄', onSelect: m.unfoldAll },
  ];
}

function companyMenu(c: CompanyNode, m: TreeMenu): MenuItem[] {
  const first = c.workspaces[0]?.ws;
  const canCreate = first && first.myRole !== 'guest';
  return [
    ...(canCreate ? [{ label: t('groups.newWith', { name: c.name }), icon: '#', onSelect: () => openCreateGroup({ kind: 'workspace', workspaceId: first.id }) }] : []),
    ...(canCreate ? [{ label: t('groups.inviteCompany', { name: c.name }), icon: '＋', onSelect: () => openDialog((close) => <InviteDialog workspaceId={first.id} onClose={close} />) }] : []),
    { divider: true },
    ...treeMenuItems(m),
  ];
}

/** La burbuja ya dice «Sidechat»: el título no lo repite. */
const sideTitle = (title: string) => title.replace(/^(Sidechat|Consulta)\s*·\s*/i, '');

/** Fila de conversación de la barra lateral (grupos y DMs). */
/** Chip de asuntos en la fila del grupo: contraídos cada grupo ocupa una sola línea; el chip los muestra u oculta. */
export interface IssuesChip { count: number; overdue: number; open: boolean; onToggle: () => void }

/**
 * Fila de conversación (barra lateral, Grupos y DMs). Con `preview` ocupa dos líneas: título y hora arriba;
 * «Nombre: texto» del último mensaje, chips y globos abajo (vista Lista y «Todo»).
 */
export function ConvItem({ c, active, showWs = false, label, threadUnread = 0, treeMentions = 0, extraMenu = [], issues, preview = false, showOrg = false }: { c: ConversationDTO; active: boolean; showWs?: boolean; label?: string; threadUnread?: number; treeMentions?: number; extraMenu?: MenuItem[]; issues?: IssuesChip; preview?: boolean; showOrg?: boolean }) {
  const d = useClient((s) => s.data)!;
  const muted = isMuted(c);
  const other = c.kind === 'direct' ? personById(d, directOtherId(d, c)) : null;
  const ws = showWs ? d.workspaces.find((w) => w.id === c.workspaceId) : null;
  const side = c.deriveKind === 'side';
  const origin = side && c.parentId ? d.conversations.find((x) => x.id === c.parentId) : null;
  const orgOfWs = c.workspaceId ? (() => { const w = d.workspaces.find((x) => x.id === c.workspaceId); return w ? placeWorkspace(d, w).org : null; })() : null;
  const title = label ?? (side ? sideTitle(conversationTitle(d, c)) : conversationTitle(d, c));
  // Línea pequeña y gris bajo el nombre: la empresa (no en el Árbol, que ya agrupa por empresa). En la búsqueda
  // de grupos también el espacio, si no es el de la casa de la empresa.
  const company = showOrg ? companyLine(d, c, title) : null;
  const orgLine = [company, ws && !ws.isOrgHome && ws.name.trim().toLowerCase() !== (company ?? '').trim().toLowerCase() ? ws.name : null].filter(Boolean).join(' · ');
  const avatar = other ? <Avatar person={other} org={orgById(d, other.orgId)} size={preview ? 32 : 22} />
    : c.kind === 'internal' ? <span className={`hash ${preview ? 'is-big' : ''}`} aria-hidden title={t('inbox.internal')}>🔒</span>
    : side && !c.avatarUrl ? <SideIcon size={preview ? 32 : 22} />
    : <ConvAvatar c={c} size={preview ? 32 : 22} fallback={c.kind === 'multi' && !side ? <StackedAvatars c={c} size={preview ? 28 : 20} /> : undefined} />;
  const chips = <>
    {threadUnread > 0 && <span className="chip-side" title={t('tree.chipHelp', { n: threadUnread })}>⑂ {threadUnread}{treeMentions > 0 ? ' @' : ''}</span>}
    {issues && issues.count > 0 && (
      // Va dentro del botón de la fila: un span con rol de botón (no se anidan botones).
      <span role="button" tabIndex={0} aria-expanded={issues.open} className={`chip-issues ${issues.open ? 'on' : ''} ${issues.overdue ? 'is-late' : ''}`}
        title={`${issues.open ? t('groups.hideIssues') : t('groups.showIssues')} · ${issues.count === 1 ? t('groups.issuesCountOne') : t('groups.issuesCount', { n: issues.count })}${issues.overdue ? ` · ${t('groups.issuesOverdue', { n: issues.overdue })}` : ''}`}
        onClick={(e) => { e.stopPropagation(); issues.onToggle(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); issues.onToggle(); } }}>
        ◆ {issues.count}{issues.overdue > 0 && <b> · {issues.overdue}!</b>} <span aria-hidden>{issues.open ? '⌄' : '›'}</span>
      </span>
    )}
    {muted && <span className="mute-ico" title={mutedText(c) ?? t('side.muted')} aria-label={t('side.muted')}>🔕</span>}
    {(c.unreadMentions ?? 0) > 0 && <span className="pill mention-pill" title={t('mention.youMentioned')}>@</span>}
    {c.unread > 0 && <span className={`pill ${muted ? 'is-muted' : ''}`} style={{ background: badgeColor(orgOfWs) }}>{c.unread}</span>}
  </>;
  const pin = <><CallDot conversationId={c.id} />{c.pinnedAt ? <span className="conv-pin" title={t('side.pinned')} aria-label={t('side.pinned')}>📌</span> : null}</>;
  return (
    <button className={`side-conv ${preview ? 'has-preview' : ''} ${active ? 'active' : ''} ${c.unread && !muted ? 'unread' : ''} ${muted ? 'is-muted' : ''}`} onClick={() => navigate(`/c/${c.id}`)}
      // Se arrastra al área del chat para abrirla en paralelo (hasta 4, split.ts).
      draggable onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, c.id); e.dataTransfer.setData('text/uri-list', `${location.origin}/c/${c.id}`); e.dataTransfer.effectAllowed = 'copyMove'; }}
      {...menuProps(() => [...conversationMenu(c, { onNewMeeting: () => newEvent({ conversationId: c.id }) }), ...extraMenu])}>
      {avatar}
      {preview ? (
        <span className="conv-lines">
          <span className="conv-line">
            {side && <span className="chip-side is-sidechat">{t('groups.sidechat')}</span>}
            <span className="grow ellipsis conv-title">{title}</span>
            {pin}
            <span className="conv-time">{timeLabel(activityOf(c) || null)}</span>
          </span>
          {orgLine && <span className="conv-org ellipsis">{orgLine}</span>}
          <span className="conv-line">
            <span className="grow ellipsis conv-sub">{conversationPreview(d, c) ?? ''}</span>
            {chips}
          </span>
        </span>
      ) : <>
        {side && <span className="chip-side is-sidechat">{t('groups.sidechat')}</span>}
        {orgLine ? (
          <span className="grow conv-lines">
            <span className="ellipsis">{title}</span>
            <span className="conv-org ellipsis">{orgLine}</span>
          </span>
        ) : (
          <span className="grow ellipsis">
            {origin && <span className="muted small">{t('groups.fromOrigin', { name: conversationTitle(d, origin) })} · </span>}
            {title}
          </span>
        )}
        {pin}
        {chips}
      </>}
    </button>
  );
}

/** Separadores discretos «Fijados · Sin leer · Recientes» (un bloque vacío no sale). */
function Separated<T>({ items, convOf, render, sepMenu }: { items: T[]; convOf: (x: T) => ConversationDTO; render: (x: T) => ReactNode; sepMenu?: () => MenuItem[] }) {
  return <>{withSeparators(items, convOf).map((b) => (
    <div key={b.bucket} className="inbox-block">
      <div className="inbox-sep" role="separator" {...(sepMenu ? menuProps(sepMenu) : {})}>{t(`inbox.${b.bucket}`)}</div>
      {b.items.map(render)}
    </div>
  ))}</>;
}

export function DmsList({ tab = 'all', activeConv = null }: { tab?: HomeTab; activeConv?: string | null }) {
  const raw = useClient((s) => s.data)!;
  const personal = usePersonalPreferences();
  const d = useMemo(() => ({ ...raw, conversations: raw.conversations.filter((c) => !personal.conversations[c.id]?.archived) }), [raw, personal]);
  // gg y «Tú» van fijos arriba (docs/GG-CHAT.md), no en la lista.
  const list = dmConversations(d, tab).filter((c) => !isGgChat(c) && !isSelfChat(d, c));
  return (
    <>
      {tab === 'all' && <AssistantRows activeConv={activeConv} />}
      <Separated items={list} convOf={(c) => c} render={(c) => <ConvItem key={c.id} c={c} showOrg active={activeConv === c.id} />} />
    </>
  );
}

/** Siempre a mano: tu chat con gg y «Tú» (notas para ti). Se crean al tocarlos. */
export function AssistantRows({ activeConv = null }: { activeConv?: string | null }) {
  const d = useClient((s) => s.data)!;
  const ggConv = d.conversations.find((c) => isGgChat(c));
  const selfConv = d.conversations.find((c) => isSelfChat(d, c));
  const me = personById(d, d.me.id);
  return (
    <div className="assistant-rows">
      <button className={`nav-item conv-row ${ggConv && activeConv === ggConv.id ? 'active' : ''}`} onClick={() => void openGgChat()}>
        <img src={asset('/gg-mark.svg')} alt="" width={22} height={22} />
        <span className="grow ellipsis"><b>gg</b> <span className="muted small">{t('gg.rowHint')}</span></span>
        {!!ggConv?.unread && <span className="pill">{ggConv.unread}</span>}
      </button>
      <button className={`nav-item conv-row ${selfConv && activeConv === selfConv.id ? 'active' : ''}`} onClick={() => void openSelfChat()}>
        <Avatar person={me} org={null} size={22} />
        <span className="grow ellipsis"><b>{t('self.title')}</b> <span className="muted small">{t('self.rowHint')}</span></span>
      </button>
    </div>
  );
}

// ---------- Vista Lista: todos los grupos en una sola lista ----------
export interface GroupListItem { g: GroupNode; ws: WorkspaceDTO; company: string; label: string }
/** Las mismas filas de grupo que el árbol (sin hilos), en una sola lista con el orden de la bandeja; la empresa va debajo del nombre. */
export function groupListItems(sections: GroupSection[]): GroupListItem[] {
  const out: GroupListItem[] = [];
  for (const s of sections) for (const c of s.companies) {
    const company = s.kind === 'org' ? s.org?.name ?? c.name : c.name;
    for (const w of c.workspaces) for (const g of w.groups) out.push({ g, ws: w.ws, company, label: g.label ?? g.conv.name ?? '' });
  }
  return out.sort((a, b) => compareConversations(withTree(a.g.conv, a.g.derived), withTree(b.g.conv, b.g.derived)));
}

export function GroupsList({ tab = 'all', activeConv = null }: { tab?: HomeTab; activeConv?: string | null }) {
  const raw = useClient((s) => s.data)!;
  const personal = usePersonalPreferences();
  const d = useMemo(() => ({ ...raw, conversations: raw.conversations.filter((c) => !personal.conversations[c.id]?.archived) }), [raw, personal]);
  const issues = useClient((s) => s.issues);
  const items = useMemo(() => groupListItems(buildGroupTree(d, issues, tab)), [d, issues, tab]);
  const issuesOpen = useIssuesOpen();
  if (!items.length) return <div className="hint" style={{ padding: '8px 10px' }}>{tab === 'all' ? t('groups.emptyOrg') : t('inbox.nothing')}</div>;
  return (
    <div className="groups-list">
      {/* Menú de sección (clic derecho o pulsación larga en un separador): mostrar o contraer todos los asuntos. */}
      <Separated items={items} convOf={(x) => withTree(x.g.conv, x.g.derived)} sepMenu={() => treeMenuItems(treeControls(buildGroupTree(d, issues, tab))).slice(0, 2)}
        render={(x) => <GroupEntry key={x.g.conv.id} g={x.g} ws={x.ws} label={x.label} preview showOrg issuesOpen={issuesOpen} active={activeConv === x.g.conv.id} />} />
    </div>
  );
}

/** «Todo» de la barra lateral: grupos (como en Lista) y DMs juntos, con el orden de la bandeja. */
export function AllList({ tab = 'all', activeConv = null }: { tab?: HomeTab; activeConv?: string | null }) {
  const raw = useClient((s) => s.data)!;
  const personal = usePersonalPreferences();
  const d = useMemo(() => ({ ...raw, conversations: raw.conversations.filter((c) => !personal.conversations[c.id]?.archived) }), [raw, personal]);
  const issues = useClient((s) => s.issues);
  const issuesOpen = useIssuesOpen();
  type Item = { c: ConversationDTO; group?: GroupListItem };
  const items = useMemo<Item[]>(() => [
    ...groupListItems(buildGroupTree(d, issues, tab)).map((group) => ({ c: group.g.conv, group })),
    ...dmConversations(d, tab).map((c) => ({ c })),
  ].sort((a, b) => compareConversations(a.c, b.c)), [d, issues, tab]);
  if (!items.length) return <div className="hint" style={{ padding: '8px 10px' }}>{t('inbox.nothing')}</div>;
  return <Separated items={items} convOf={(x) => x.c}
    render={(x) => x.group
      ? <GroupEntry key={x.c.id} g={x.group.g} ws={x.group.ws} label={x.group.label} preview showOrg issuesOpen={issuesOpen} active={activeConv === x.c.id} />
      : <ConvItem key={x.c.id} c={x.c} preview showOrg active={activeConv === x.c.id} />} />;
}

// ---------- Selector de vista «Lista | Árbol» (por dispositivo) ----------
export type GroupsView = 'list' | 'tree';
const VIEW_KEY = 'chaggu:groupsView';
const viewStore = (() => {
  let value: GroupsView = (() => { try { return localStorage.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'list'; } catch { return 'list'; } })();
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (v: GroupsView) => { value = v; try { localStorage.setItem(VIEW_KEY, v); } catch {} listeners.forEach((l) => l()); },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
})();
export const useGroupsView = () => useSyncExternalStore(viewStore.subscribe, viewStore.get);

export function GroupsViewToggle() {
  const view = useGroupsView();
  return (
    <div className="seg" role="tablist" aria-label={t('inbox.view')}>
      {(['list', 'tree'] as const).map((v) => (
        <button key={v} role="tab" aria-selected={view === v} className={`seg-btn ${view === v ? 'on' : ''}`} onClick={() => viewStore.set(v)}>
          {v === 'list' ? t('inbox.list') : t('inbox.tree')}
        </button>
      ))}
    </div>
  );
}

/** Grupos en la vista elegida. */
export function GroupsBody({ tab = 'all', activeConv = null }: { tab?: HomeTab; activeConv?: string | null }) {
  const view = useGroupsView();
  return view === 'tree' ? <GroupsTree tab={tab} activeConv={activeConv} /> : <GroupsList tab={tab} activeConv={activeConv} />;
}

// ---------- Pantallas Grupos y DMs (pestañas en móvil) ----------
// Arriba siempre ✎ Mensaje nuevo y «＋ Crear»; al buscar también salen personas, grupos y chats (docs/GRUPOS.md).
export function GroupsScreen() {
  const [q, setQ] = useState('');
  const view = useGroupsView();
  const searching = !!q.trim();
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <div className="row page-head">{view === 'tree' && <GroupsViewButton />}<h1 className="grow">{t('nav.groups')}</h1><QuickActions /></div>
      <DndStrip />
      <QuickSearchField value={q} onChange={setQ} placeholder={t('grp.search')} order={['groups', 'people', 'chats']} />
      {!searching && <div className="row groups-view-row"><GroupsViewToggle /></div>}
      <div className="card" style={{ padding: 6, marginTop: 10 }}>
        {searching ? <QuickSearchSections query={q} order={['groups', 'people', 'chats']} /> : <GroupsBody />}
      </div>
    </div></div>
  );
}

export function DmsScreen() {
  const d = useClient((s) => s.data)!;
  const [q, setQ] = useState('');
  const n = dmConversations(d).length;
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 760 }}>
      <div className="row page-head"><h1 className="grow">{t('nav.dms')}</h1><QuickActions /></div>
      <DndStrip />
      <QuickSearchField value={q} onChange={setQ} placeholder={t('dm.search')} order={['chats', 'people', 'groups']} />
      <div className="card" style={{ padding: 6, marginTop: 10 }}>
        {q.trim() ? <QuickSearchSections query={q} order={['chats', 'people', 'groups']} />
          : n ? <DmsList /> : (
            <div className="empty">{t('dms.empty')}
              <div style={{ marginTop: 10 }}><button className="btn primary small" onClick={openNewMessage}>✎ {t('dms.new')}</button></div>
            </div>
          )}
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
  // Canal propio: un grupo solo de mi empresa dentro de la relación (la otra empresa no lo ve).
  const [ownOnly, setOwnOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ conversationId: string; url: string; code: string | null } | null>(null);

  const orgName = orgById(d, orgId)?.name ?? '';
  const target: CreateGroupRequest['target'] = forWhom === 'org' ? { kind: 'org', orgId }
    : relation === 'new' ? { kind: 'company', companyName: company.trim(), orgId } : { kind: 'workspace', workspaceId: relation };
  const internal = forWhom === 'other' && ownOnly;
  const wsMembers = target.kind === 'workspace' ? new Set(d.workspaces.find((w) => w.id === target.workspaceId)?.memberIds ?? []) : null;
  // En una relación existente: su gente; si es canal propio, solo mis colegas que ya están en ella. Si no, mis colegas.
  const candidates = d.people.filter((p) => p.id !== d.me.id && p.kind === 'human'
    && (wsMembers ? wsMembers.has(p.id) && (!internal || p.orgId === orgId) : p.orgId === orgId));
  const list = splitEmails(emails);
  const bad = list.filter((e) => !looksEmail(e));
  const inviteRole = forWhom === 'org' ? 'guest' : role;
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    client.createGroup({ name: name.trim(), target, internal, memberIds: picked.filter((p) => candidates.some((c) => c.id === p)), inviteEmails: internal ? [] : list, inviteRole, shareLink: share && !internal, lang: getLang() })
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
        {forWhom === 'other' && (
          <label className="check"><input type="checkbox" checked={ownOnly} onChange={(e) => setOwnOnly(e.target.checked)} />
            <span className="grow">{t('groups.ownOnly', { org: orgName })}<span className="small muted" style={{ display: 'block' }}>{t('groups.ownOnlyHint')}</span></span>
          </label>
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
        {!internal && <>
        <label className="field"><span>{t('groups.inviteOutside')}</span>
          <textarea className="input" rows={2} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder={t('groups.emailsPh')} />
          {bad.length > 0 && <span className="error">{t('groups.badEmails', { list: bad.join(', ') })}</span>}
        </label>
        {forWhom === 'other'
          ? <RolePicker role={role} setRole={setRole} company={relation === 'new' ? company.trim() : relations.find((r) => r.id === relation)?.label ?? ''} />
          : <span className="hint">{t('groups.guestOnlyHint')}</span>}
        <label className="check"><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /><span className="grow">{t('groups.shareLink')}<span className="small muted" style={{ display: 'block' }}>{t('groups.shareLinkHint')}</span></span></label>
        </>}
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
      {'share' in navigator && <button className="btn" onClick={() => navigator.share({ title: 'chaggu', text }).catch(() => {})}>{t('share.share')}</button>}
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
    client.acceptInvitation(clean).then((r) => { onClose(); navigate(r.conversationIds[0] ? `/c/${r.conversationIds[0]}` : r.workspaceId ? `/w/${r.workspaceId}` : '/'); })
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
      <div className="muted">{inv.kind === 'org'
        ? t('join.org', { name: inv.invitedByName, org: inv.orgName ?? inv.invitedByOrg })
        : groups
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
