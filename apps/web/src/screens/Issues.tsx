import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BootstrapDTO, IssueDTO, IssueEventDTO, IssueStatus, IssueVisibility } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { navigate, queryParam } from '../router.ts';
import { Avatar, Modal, conversationTitle, orgById, personById } from '../ui.tsx';
import { menuProps, toast, type MenuItem } from '../menu.tsx';
import { destinationLabel, issueDestinations } from '../quick-search.ts';
import { QuickActions } from './Quick.tsx';
import { openDialog } from '../actions.tsx';
import { IssueTopicTag, issueTopicMenu } from './Topics.tsx';

/** Destino «Personal · solo tú» en los selectores de «¿Dónde?». */
export const PERSONAL_DEST = '__personal';
export const isPersonal = (i: Pick<IssueDTO, 'conversationId'>) => !i.conversationId;
export const ISSUE_STATUSES: IssueStatus[] = ['open', 'in_progress', 'waiting', 'done', 'cancelled'];
const CLOSED = new Set<IssueStatus>(['done', 'cancelled']);
const STALL_DAYS = 2;

export const isClosed = (i: IssueDTO) => CLOSED.has(i.status);
const daysSince = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
/** Fecha local (no UTC): en Colombia, de noche, UTC ya es mañana y todo saldría vencido. */
export const localIso = (x = new Date()) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const todayIso = () => localIso();

/** Señal de cuello de botella: lleva días sin moverse, o se venció. */
export function issueFlags(i: IssueDTO) {
  if (isClosed(i)) return { stalledDays: 0, overdue: false, dueToday: false };
  const stalledDays = daysSince(i.statusSince);
  const overdue = !!i.dueDate && i.dueDate < todayIso();
  return { stalledDays: stalledDays >= STALL_DAYS ? stalledDays : 0, overdue, dueToday: i.dueDate === todayIso() };
}

export function dueLabel(i: IssueDTO) {
  if (!i.dueDate) return t('issue.noDue');
  return new Date(`${i.dueDate}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

export function StatusPill({ status }: { status: IssueStatus }) {
  return <span className={`ist ist-${status}`}>{t(`issue.st.${status}`)}</span>;
}

function membersOf(d: BootstrapDTO, conversationId: string | null) {
  if (!conversationId) return [];
  const c = d.conversations.find((x) => x.id === conversationId);
  return (c?.memberIds ?? []).map((id) => personById(d, id)).filter((p): p is NonNullable<typeof p> => !!p && p.kind === 'human');
}

/** Tareas hijas visibles de un asunto (el servidor solo manda las que puedo ver). */
export function childrenOf(all: Record<string, IssueDTO>, parentId: string) {
  return Object.values(all).filter((x) => x.parentIssueId === parentId)
    .sort((a, b) => Number(isClosed(a)) - Number(isClosed(b)) || a.createdAt.localeCompare(b.createdAt));
}
const isRestricted = (i: IssueDTO) => !!i.visibility && i.visibility !== 'all';
/** «Solo Xertify» / «Privada»: quién la ve, en palabras. */
export function visibilityLabel(d: BootstrapDTO, i: Pick<IssueDTO, 'visibility' | 'visibleOrgId'>) {
  if (i.visibility === 'org') return t('task.visOrg', { org: orgById(d, i.visibleOrgId)?.name ?? '' });
  if (i.visibility === 'private') return t('task.visPrivate');
  return t('task.visAll');
}

/** Completar o reabrir con un toque, y «Deshacer» en el aviso: los asuntos se manejan como tareas. */
export function toggleDone(i: IssueDTO) {
  const prev = i.status;
  const next: IssueStatus = isClosed(i) ? 'open' : 'done';
  return client.updateIssue(i.id, { status: next })
    .then(() => toast(next === 'done' ? t('issue.completed') : t('issue.reopenedToast'), { label: t('issue.undo'), run: () => void client.updateIssue(i.id, { status: prev }).catch((e) => toast(errorText(e))) }))
    .catch((e) => toast(errorText(e)));
}

/** Completar o cambiar el estado de un asunto sin abrirlo. */
export function issueQuickMenu(i: IssueDTO): MenuItem[] {
  const set = (status: IssueDTO['status']) => client.updateIssue(i.id, { status }).catch((e) => toast(errorText(e)));
  if (isClosed(i)) return [
    { label: t('issue.reopen'), icon: '↺', onSelect: () => void toggleDone(i) },
    { divider: true },
    { label: t('issue.open'), icon: '◆', onSelect: () => navigate(i.conversationId ? `/c/${i.conversationId}?issue=${i.id}` : `/asuntos?issue=${i.id}`) },
  ];
  const top = !i.parentIssueId && !isPersonal(i);
  return [
    { label: t('issue.complete'), icon: '✓', onSelect: () => void toggleDone(i) },
    ...(top ? [
      { label: t('task.add'), icon: '＋', onSelect: () => openDialog((close) => <TasksDialog parentId={i.id} onClose={close} />) },
      ...(i.visibility !== 'org' && i.visibility !== 'private' ? [{ label: t('task.sidechat'), icon: '💬', onSelect: () => openDialog((close) => <SideFromIssueDialog issue={i} onClose={close} />) }] : []),
      { divider: true },
    ] : []),
    ...(i.status !== 'in_progress' ? [{ label: t('issue.markInProgress'), icon: '▶', onSelect: () => void set('in_progress') }] : []),
    ...(i.status !== 'waiting' ? [{ label: t('issue.markWaiting'), icon: '⏸', onSelect: () => void set('waiting') }] : []),
    ...(i.status !== 'open' ? [{ label: t('issue.markOpen'), icon: '○', onSelect: () => void set('open') }] : []),
    ...(i.conversationId ? [issueTopicMenu(i.id, i.topicId, client.getState().topics[i.conversationId] ?? [])].filter((x): x is MenuItem => !!x) : []),
    { divider: true },
    { label: t('issue.open'), icon: '◆', onSelect: () => navigate(i.conversationId ? `/c/${i.conversationId}?issue=${i.id}` : `/asuntos?issue=${i.id}`) },
  ];
}

/** Casilla redonda: completa o reabre sin abrir el asunto. */
export function IssueCheck({ i, size = 20 }: { i: IssueDTO; size?: number }) {
  const done = isClosed(i);
  return (
    <span role="checkbox" tabIndex={0} aria-checked={done} aria-label={done ? t('issue.reopen') : t('issue.complete')} title={done ? t('issue.reopen') : t('issue.complete')}
      className={`issue-check ${done ? 'on' : ''} ${i.status === 'in_progress' ? 'is-doing' : ''}`} style={{ width: size, height: size }}
      onClick={(e) => { e.stopPropagation(); void toggleDone(i); }}
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void toggleDone(i); } }}>
      {done ? '✓' : ''}
    </span>
  );
}

export function IssueRow({ i, showWhere = true, showOwner = true, child = false, onOpen }: { i: IssueDTO; showWhere?: boolean; showOwner?: boolean; child?: boolean; onOpen: (id: string) => void }) {
  const d = useClient((s) => s.data)!;
  const all = useClient((s) => s.issues);
  const owner = personById(d, i.ownerId);
  const conv = d.conversations.find((c) => c.id === i.conversationId);
  const f = issueFlags(i);
  const done = isClosed(i);
  const kids = i.parentIssueId ? [] : childrenOf(all, i.id);
  const kidsDone = kids.filter(isClosed).length;
  const parent = i.parentIssueId ? all[i.parentIssueId] : null;
  // Una tarea en un sidechat se marca para que se sepa dónde se habla de ella.
  const inSide = !!parent && parent.conversationId !== i.conversationId;
  const meta = [
    isPersonal(i) ? t('issue.personalShort') : showOwner ? owner?.name ?? t('issue.noOwner') : null,
    !child && parent ? `↳ ${parent.title}` : null,
    !child && !parent && i.parentIssueId ? t('task.ofHidden') : null,
    showWhere && conv && !child ? t('issue.in', { name: conversationTitle(d, conv) }) : null,
    inSide ? `💬 ${t('task.inSide')}` : null,
    i.commentCount > 0 ? `💬 ${i.commentCount}` : null,
  ].filter(Boolean);
  return (
    <div role="button" tabIndex={0} className={`card issue-row ${child ? 'is-child' : ''} ${f.stalledDays || f.overdue ? 'is-jam' : ''} ${done ? 'is-done' : ''}`}
      onClick={() => onOpen(i.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(i.id); }} {...menuProps(() => issueQuickMenu(i))}>
      {child && <span className="child-elbow" aria-hidden>↳</span>}
      <IssueCheck i={i} size={child ? 18 : 20} />
      <span className="grow" style={{ minWidth: 0 }}>
        <b className="ellipsis issue-title" style={{ display: 'block' }}>
          {(isRestricted(i) || isPersonal(i)) && <span className="lock" title={isPersonal(i) ? t('issue.personalOption') : visibilityLabel(d, i)} aria-label={isPersonal(i) ? t('issue.personalOption') : visibilityLabel(d, i)}>🔒 </span>}{i.title}
        </b>
        {(meta.length > 0 || i.topicId) && <span className="small muted ellipsis issue-meta" style={{ display: 'block' }}>
          <IssueTopicTag issueId={i.id} conversationId={i.conversationId} topicId={i.topicId} canEdit={!!conv?.canPost} />{meta.join(' · ')}
        </span>}
      </span>
      {kids.length > 0 && <span className={`kids-badge ${kidsDone === kids.length ? 'all-done' : ''}`} title={t('task.progress', { done: kidsDone, n: kids.length })}>☑ {kidsDone}/{kids.length}</span>}
      {f.stalledDays > 0 && <span className="jam-badge" title={t('issue.bottleneck')}>⏱ {f.stalledDays === 1 ? t('issue.stalledOne') : t('issue.stalled', { n: f.stalledDays })}</span>}
      {i.dueDate && <span className={`small ${f.overdue ? 'error' : 'muted'}`} style={{ whiteSpace: 'nowrap' }}>{f.overdue ? t('issue.overdue') : f.dueToday ? t('issue.today') : dueLabel(i)}</span>}
      {(i.status === 'in_progress' || i.status === 'waiting' || i.status === 'cancelled') && <StatusPill status={i.status} />}
      {!i.parentIssueId && !done && !isPersonal(i) && (
        <button className="row-add" title={t('task.add')} aria-label={t('task.add')}
          onClick={(e) => { e.stopPropagation(); openDialog((close) => <TasksDialog parentId={i.id} onClose={close} />); }}>＋</button>
      )}
      {showOwner && <Avatar person={owner} org={orgById(d, owner?.orgId)} size={child ? 20 : 24} />}
    </div>
  );
}

/** Un asunto con sus tareas debajo, sangradas. */
export function IssueWithTasks({ i, showWhere, showOwner, onOpen }: { i: IssueDTO; showWhere?: boolean; showOwner?: boolean; onOpen: (id: string) => void }) {
  const all = useClient((s) => s.issues);
  const kids = childrenOf(all, i.id);
  return (
    <div className="issue-group">
      <IssueRow i={i} showWhere={showWhere} showOwner={showOwner} onOpen={onOpen} />
      {kids.length > 0 && <div className="issue-kids">{kids.map((k) => <IssueRow key={k.id} i={k} child showWhere={false} onOpen={onOpen} />)}</div>}
    </div>
  );
}

/** Principales de una lista: los que no son hijos, o hijos cuyo asunto no está en la lista (o no lo veo). */
function tops(list: IssueDTO[], all: Record<string, IssueDTO>) {
  const ids = new Set(list.map((x) => x.id));
  return list.filter((x) => !x.parentIssueId || !all[x.parentIssueId] || !ids.has(x.parentIssueId));
}

/**
 * Alta rápida: se escribe y Enter. Responsable (yo por defecto) y fecha opcionales al lado;
 * el campo queda listo para el siguiente, como una lista de tareas.
 */
export function QuickAddIssue({ conversationId }: { conversationId?: string }) {
  const d = useClient((s) => s.data)!;
  const destinations = useMemo(() => (conversationId ? [] : issueDestinations(d)), [d, conversationId]);
  const [conv, setConv] = useState(conversationId ?? PERSONAL_DEST);
  const members = membersOf(d, conv);
  const [title, setTitle] = useState('');
  const [ownerId, setOwnerId] = useState(d.me.id);
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (conversationId) setConv(conversationId); }, [conversationId]);
  if (!conv) return null;
  // Responsable y fecha aparecen al escribir: el campo vacío es una sola línea.
  const typing = title.length > 0;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (text.length < 2 || busy) return;
    setBusy(true);
    try {
      if (conv === PERSONAL_DEST) await client.createPersonalIssue({ title: text, dueDate: due || null });
      else await client.createIssue(conv, { title: text, ownerId: members.some((p) => p.id === ownerId) ? ownerId : d.me.id, dueDate: due || null });
      setTitle(''); setDue('');
    } catch (err) { toast(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <form className="issue-quick" onSubmit={submit}>
      <span className="issue-check ghost" aria-hidden>＋</span>
      <input className="grow" placeholder={t('issue.quickPh')} onKeyDown={(e) => { if (e.key === 'Escape') setTitle(''); }} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('issue.title')} />
      {typing && !conversationId && (
        <select value={conv} onChange={(e) => { setConv(e.target.value); setOwnerId(d.me.id); }} aria-label={t('issue.where')}>
          <option value={PERSONAL_DEST}>🔒 {t('issue.personalOption')}</option>
          {destinations.map((c) => <option key={c.id} value={c.id}>{destinationLabel(d, c, conversationTitle(d, c))}</option>)}
        </select>
      )}
      {typing && (
        <span className="issue-quick-opts">
          {conv !== PERSONAL_DEST && (
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label={t('issue.owner')} title={t('issue.owner')}>
              {members.map((p) => <option key={p.id} value={p.id}>{p.id === d.me.id ? t('issue.me') : p.name}</option>)}
            </select>
          )}
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label={t('issue.due')} title={t('issue.due')} />
          <button className="btn primary small" disabled={busy || title.trim().length < 2}>{t('issue.add')}</button>
        </span>
      )}
    </form>
  );
}

/** Asuntos de una conversación: alta rápida, activos y «Completados» plegable. */
export function ConversationIssues({ conversationId, canCreate, onOpen }: { conversationId: string; canCreate: boolean; onOpen: (id: string) => void }) {
  const all = useClient((s) => s.issues);
  const [showDone, setShowDone] = useState(false);
  useEffect(() => { void client.loadIssues({ conversationId }).catch(() => {}); }, [conversationId]);
  const here = Object.values(all).filter((i) => i.conversationId === conversationId);
  // Las tareas de un asunto de este chat van debajo de él (aunque vivan en un sidechat).
  const mine = tops(here, all).filter((i) => !i.parentIssueId || all[i.parentIssueId]?.conversationId !== conversationId);
  const open = mine.filter((i) => !isClosed(i)).sort(byUrgency);
  const done = mine.filter(isClosed).sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  return (
    <div className="issue-list">
      {canCreate && <QuickAddIssue conversationId={conversationId} />}
      {open.length === 0 && <div className="hint">{t('issue.noIssues')}</div>}
      <div className="list" style={{ gap: 6 }}>{open.map((i) => <IssueWithTasks key={i.id} i={i} showWhere={false} onOpen={onOpen} />)}</div>
      {done.length > 0 && (
        <>
          <button className="link-btn issue-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
            {showDone ? '⌄' : '›'} {t('issue.doneCount', { n: done.length })}
          </button>
          {showDone && <div className="list" style={{ gap: 6 }}>{done.map((i) => <IssueRow key={i.id} i={i} showWhere={false} onOpen={onOpen} />)}</div>}
        </>
      )}
    </div>
  );
}

/** Lo más urgente arriba: vencidos, estancados, con fecha más cercana, en curso. */
export function byUrgency(a: IssueDTO, b: IssueDTO) {
  const fa = issueFlags(a), fb = issueFlags(b);
  return (Number(fb.overdue) - Number(fa.overdue)) || (fb.stalledDays - fa.stalledDays)
    || (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9')
    || (Number(b.status === 'in_progress') - Number(a.status === 'in_progress'))
    || b.createdAt.localeCompare(a.createdAt);
}

/** Sin conversationId (desde «＋ Crear») se elige el grupo o chat: donde escribo y no soy tercero, el más reciente primero. */
export function NewIssueDialog({ conversationId, originMessageId, defaultTitle = '', topicId, onClose, onCreated }: {
  conversationId?: string; originMessageId?: string; defaultTitle?: string; topicId?: string | null; onClose: () => void; onCreated?: (i: IssueDTO) => void;
}) {
  const d = useClient((s) => s.data)!;
  const destinations = useMemo(() => (conversationId ? [] : issueDestinations(d)), [d, conversationId]);
  const [conv, setConv] = useState(conversationId ?? PERSONAL_DEST);
  const members = membersOf(d, conv);
  const [title, setTitle] = useState(defaultTitle);
  const [ownerId, setOwnerId] = useState(d.me.id);
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!conv) return;
    setBusy(true); setError(null);
    try {
      const i = conv === PERSONAL_DEST
        ? await client.createPersonalIssue({ title, dueDate: due || null })
        : await client.createIssue(conv, { title, ownerId, dueDate: due || null, originMessageId: originMessageId ?? null, ...(topicId && !originMessageId ? { topicId } : {}) });
      onCreated?.(i);
      onClose();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('issue.newTitle')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field"><span>{t('issue.title')}</span><input className="input" required minLength={2} maxLength={200} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        {!conversationId && (
          <label className="field"><span>{t('issue.where')}</span>
            <select className="input" value={conv} onChange={(e) => { setConv(e.target.value); setOwnerId(d.me.id); }}>
              <option value={PERSONAL_DEST}>🔒 {t('issue.personalOption')}</option>
              {destinations.map((c) => <option key={c.id} value={c.id}>{destinationLabel(d, c, conversationTitle(d, c))}</option>)}
            </select>
          </label>
        )}
        {conv === PERSONAL_DEST && <div className="hint">🔒 {t('issue.personalHint')}</div>}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {conv !== PERSONAL_DEST && <label className="field grow"><span>{t('issue.owner')}</span>
            <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              {members.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === d.me.id ? ` ${t('common.you')}` : ''} · {orgById(d, p.orgId)?.name ?? t('common.guest')}</option>)}
            </select>
          </label>}
          <label className="field"><span>{t('issue.due')}</span><input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || !conv}>{t('issue.create')}</button></div>
      </form>
    </Modal>
  );
}

function eventText(d: BootstrapDTO, e: IssueEventDTO) {
  const p = e.payload as any;
  switch (e.kind) {
    case 'created': return t('issue.ev.created');
    case 'status': return t('issue.ev.status', { to: t(`issue.st.${p.to}` as 'issue.st.open') });
    case 'owner': return `${t('issue.ev.owner')} → ${personById(d, p.to)?.name ?? t('common.none')}`;
    case 'due': return t('issue.ev.due', { to: p.to ? new Date(`${p.to}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) : t('issue.noDue') });
    case 'title': return `${t('issue.ev.title')} → «${p.to}»`;
    case 'waiting': return `${t('issue.ev.waiting')}${p.to ? `: ${orgById(d, p.to)?.name ?? ''}` : ''}`;
    case 'visibility': return `${t('task.evVis')} → ${p.to === 'all' ? t('task.visAll') : p.to === 'org' ? t('task.visOrgShort') : t('task.visPrivate')}`;
    default: return '';
  }
}

/** Detalle de un asunto: estado, responsable, fecha, a quién se espera, origen, historial y comentarios. */
export function IssueDrawer({ id: startId, onClose }: { id: string; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  // Se navega dentro del mismo diálogo: del asunto a una tarea y de vuelta.
  const [id, setId] = useState(startId);
  useEffect(() => setId(startId), [startId]);
  const live = useClient((s) => s.issues[id]);
  const parent = useClient((s) => (live?.parentIssueId ? s.issues[live.parentIssueId] : undefined));
  const [events, setEvents] = useState<IssueEventDTO[]>([]);
  const [comment, setComment] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [pickDate, setPickDate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => client.issueDetail(id).then((r) => setEvents(r.events)).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); }, [id, live?.updatedAt]);
  if (!live) return <Modal title={t('nav.issues')} onClose={onClose}><div className="muted">{error ?? t('common.loading')}</div></Modal>;
  const i = live;
  const done = isClosed(i);
  const conv = d.conversations.find((c) => c.id === i.conversationId);
  const chatMembers = membersOf(d, i.conversationId);
  const extra = (i.viewerIds ?? []).filter((u) => !chatMembers.some((p) => p.id === u)).map((u) => personById(d, u)).filter((p): p is NonNullable<typeof p> => !!p);
  const members = [...(i.visibility === 'org' ? chatMembers.filter((p) => p.orgId === i.visibleOrgId) : i.visibility === 'private' ? [] : chatMembers), ...extra,
    ...(i.visibility === 'private' ? chatMembers.filter((p) => (i.viewerIds ?? []).includes(p.id)) : [])]
    .filter((p, k, arr) => arr.findIndex((x) => x.id === p.id) === k);
  const orgIds = [...new Set(chatMembers.map((p) => p.orgId).filter(Boolean))] as string[];
  const f = issueFlags(i);
  const canSeeOrigin = !!conv && i.originMessageSeq !== null && i.originMessageSeq > conv.historyFromSeq;
  const requester = personById(d, i.requestedBy);
  const update = (patch: Parameters<typeof client.updateIssue>[1]) => client.updateIssue(i.id, patch).catch((e) => setError(errorText(e)));
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!comment.trim()) return;
    try { await client.commentIssue(i.id, comment.trim()); setComment(''); await load(); } catch (err) { setError(errorText(err)); }
  };
  const comments = events.filter((e) => e.kind === 'comment');
  const changes = events.filter((e) => e.kind !== 'comment');
  const dates = dateShortcuts();
  const shortDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' });
  const when = (iso: string) => new Date(iso).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  // Un solo paso por pregunta: ¿quién?, ¿para cuándo?, ¿cómo va? Y un solo botón grande para terminar.
  return (
    <Modal title={isPersonal(i) ? `🔒 ${t('issue.personalOption')}` : conv ? conversationTitle(d, conv) : t('nav.issues')} onClose={onClose}>
      <label className="issue-title-wrap">
        <input key={i.title} className={`issue-title-edit ${done ? 'is-done' : ''}`} defaultValue={i.title} maxLength={200} aria-label={t('issue.title')}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = i.title; e.currentTarget.blur(); } }}
          onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v.length >= 2 && v !== i.title) void update({ title: v }); else e.currentTarget.value = i.title; }} />
        <span className="issue-title-pen" aria-hidden>✎</span>
      </label>
      {i.parentIssueId && (parent
        ? <button className="link-btn parent-link" onClick={() => setId(parent.id)}>↑ {t('task.partOf', { title: parent.title })}</button>
        : <div className="small muted">{t('task.ofHidden')}</div>)}
      <div className="small muted">{requester ? t('issue.requestedBy', { name: requester.name }) : t('issue.manual')}{isRestricted(i) ? <> · <b>🔒 {visibilityLabel(d, i)}</b></> : null}</div>

      {done ? (
        <div className={`issue-done-banner ${i.status === 'cancelled' ? 'is-dropped' : ''}`}>
          <span className="grow">{i.status === 'cancelled' ? t('issue.droppedBanner') : t('issue.doneBanner')}{i.closedAt ? ` · ${when(i.closedAt)}` : ''}</span>
          <button className="btn small" onClick={() => void toggleDone(i)}>↺ {t('issue.reopen')}</button>
        </div>
      ) : (
        <>
          {(f.overdue || f.stalledDays > 0 || f.dueToday) && (
            <div className="jam-alert">⏱ {[f.overdue && i.dueDate ? t('issue.overdueSince', { date: shortDate(i.dueDate) }) : null, f.dueToday ? t('issue.today') : null, f.stalledDays ? t('issue.stalledPlain', { n: f.stalledDays }) : null].filter(Boolean).join(' · ')}</div>
          )}
          <button className="btn issue-done-btn" onClick={() => void toggleDone(i)}>✓ {t('issue.markDone')}</button>
        </>
      )}

      {!isPersonal(i) && <div className="issue-q">
        <div className="issue-q-label">{t('issue.qWho')}</div>
        <div className="chips">
          {members.map((p) => (
            <button key={p.id} className={`chip-person ${i.ownerId === p.id ? 'on' : ''}`} aria-pressed={i.ownerId === p.id} onClick={() => update({ ownerId: p.id })}>
              <Avatar person={p} org={orgById(d, p.orgId)} size={22} /> {p.id === d.me.id ? t('issue.me') : p.name.split(' ')[0]}
            </button>
          ))}
          {i.ownerId && <button className="chip-person ghost" onClick={() => update({ ownerId: null })}>{t('issue.noOwner')}</button>}
        </div>
      </div>}

      <div className="issue-q">
        <div className="issue-q-label">{t('issue.qWhen')}{i.dueDate ? <b> · {shortDate(i.dueDate)}</b> : null}</div>
        <div className="chips">
          {dates.map(([k, iso]) => <button key={k} className={`chip ${i.dueDate === iso ? 'on' : ''}`} aria-pressed={i.dueDate === iso} onClick={() => update({ dueDate: iso })}>{t(k)}</button>)}
          <button className={`chip ${pickDate ? 'on' : ''}`} onClick={() => setPickDate(!pickDate)}>📅 {t('issue.dPick')}</button>
          {i.dueDate && <button className="chip ghost" onClick={() => update({ dueDate: null })}>{t('issue.noDue')}</button>}
        </div>
        {pickDate && <input className="input" type="date" autoFocus value={i.dueDate ?? ''} onChange={(e) => { void update({ dueDate: e.target.value || null }); setPickDate(false); }} style={{ maxWidth: 200 }} />}
      </div>

      {!done && (
        <div className="issue-q">
          <div className="issue-q-label">{t('issue.qHow')}</div>
          <div className="chips">
            {(['open', 'in_progress', 'waiting'] as const).map((st) => (
              <button key={st} className={`chip ${i.status === st ? 'on' : ''}`} aria-pressed={i.status === st} onClick={() => update({ status: st })}>{t(`issue.how.${st}`)}</button>
            ))}
          </div>
          {i.status === 'waiting' && orgIds.length > 1 && (
            <div className="chips" style={{ marginTop: 6 }}>
              <span className="small muted">{t('issue.waitingOn')}:</span>
              {orgIds.map((o) => <button key={o} className={`chip ${i.waitingOnOrgId === o ? 'on' : ''}`} onClick={() => update({ waitingOnOrgId: i.waitingOnOrgId === o ? null : o })}>{orgById(d, o)?.name}</button>)}
            </div>
          )}
        </div>
      )}

      {!i.parentIssueId && !isPersonal(i) && <TasksSection parentId={i.id} onOpen={setId} />}
      {isPersonal(i) && <div className="hint">🔒 {t('issue.personalHint')}</div>}
      {i.parentIssueId && i.createdBy === d.me.id && <VisibilityChoice issue={i} />}

      <div className="issue-q">
        <div className="issue-q-label">{t('issue.qNews')}{comments.length ? ` · ${comments.length}` : ''}</div>
        {comments.map((e) => {
          const who = personById(d, e.actorId);
          return (
            <div key={e.id} className="issue-ev is-comment">
              <Avatar person={who} org={orgById(d, who?.orgId)} size={24} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="small"><b>{who?.name ?? t('common.participant')}</b> <span className="muted">· {when(e.createdAt)}</span></div>
                <div className="issue-comment">{String((e.payload as any).body)}</div>
              </div>
            </div>
          );
        })}
        <form onSubmit={send} className="linkbox">
          <input className="input" placeholder={t('issue.commentPh')} value={comment} onChange={(e) => setComment(e.target.value)} />
          <button className="btn primary" disabled={!comment.trim()}>{t('issue.comment')}</button>
        </form>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="issue-foot">
        {i.originMessageId && (canSeeOrigin
          ? <button className="link-btn" onClick={() => { onClose(); navigate(`/c/${i.conversationId}?m=${i.originMessageSeq}`); }}>↗ {t('issue.origin')}</button>
          : <span className="small muted">{t('issue.originOut')}</span>)}
        {changes.length > 0 && <button className="link-btn" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>{showHistory ? '⌄' : '›'} {t('issue.historyCount', { n: changes.length })}</button>}
        <span className="grow" />
        {!done && <button className="link-btn muted" onClick={() => void update({ status: 'cancelled' }).then(() => toast(t('issue.droppedToast'), { label: t('issue.undo'), run: () => void client.updateIssue(i.id, { status: i.status }) }))}>{t('issue.drop')}</button>}
      </div>
      {showHistory && (
        <div className="issue-timeline">
          {changes.map((e) => {
            const who = personById(d, e.actorId);
            return <div key={e.id} className="small muted"><b>{who?.name ?? t('common.participant')}</b> {eventText(d, e)} · {when(e.createdAt)}</div>;
          })}
        </div>
      )}
    </Modal>
  );
}

/** Fechas de un toque en la hora local: hoy, mañana, el viernes y el lunes que viene. */
function dateShortcuts(): ['issue.dToday' | 'issue.dTomorrow' | 'issue.dFriday' | 'issue.dNextWeek', string][] {
  const local = localIso;
  const plus = (n: number) => { const x = new Date(); x.setDate(x.getDate() + n); return x; };
  const dow = new Date().getDay();
  const toFriday = (5 - dow + 7) % 7;
  const toMonday = ((1 - dow + 7) % 7) || 7;
  const out: ['issue.dToday' | 'issue.dTomorrow' | 'issue.dFriday' | 'issue.dNextWeek', string][] = [['issue.dToday', local(plus(0))], ['issue.dTomorrow', local(plus(1))]];
  if (toFriday > 1) out.push(['issue.dFriday', local(plus(toFriday))]);
  out.push(['issue.dNextWeek', local(plus(toMonday))]);
  return out;
}

export function IssuesScreen() {
  const d = useClient((s) => s.data)!;
  const all = useClient((s) => s.issues);
  const [filter, setFilter] = useState<'mine' | 'open' | 'closed'>(() => (localStorage.getItem('chaggu:issueFilter') as 'mine') || 'mine');
  const [groupBy, setGroupBy] = useState<'group' | 'person'>(() => (localStorage.getItem('chaggu:issueGroupBy') as 'person') || 'group');
  // ?issue=<id>: abre el asunto (enlaces de gg, del push o de un asunto personal).
  const [open, setOpen] = useState<string | null>(() => queryParam('issue'));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { client.loadIssues({}).catch((e) => setError(errorText(e))); }, []);
  const remember = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };
  const visibleConvs = useMemo(() => new Set(d.conversations.map((c) => c.id)), [d]);
  // Los restringidos pueden ser de un chat que no leo (me asignaron una tarea): el servidor ya filtró.
  const list = Object.values(all)
    .filter((i) => !i.conversationId || visibleConvs.has(i.conversationId) || isRestricted(i))
    .filter((i) => (filter === 'closed' ? isClosed(i) : !isClosed(i) && (filter === 'open' || i.ownerId === d.me.id)))
    .sort(filter === 'closed' ? (a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '') : byUrgency);
  // Por grupo: la conversación con su espacio. Por persona: el responsable, yo primero y «Sin responsable» al final.
  const NONE = '__none';
  const buckets = new Map<string, IssueDTO[]>();
  // Por grupo, las tareas van debajo de su asunto (en la sección del asunto); por responsable, sueltas.
  const shown = groupBy === 'group' ? tops(list, all) : list;
  const PERSONAL = '__personal';
  const convOf = (i: IssueDTO) => (i.parentIssueId && all[i.parentIssueId] ? all[i.parentIssueId]!.conversationId ?? PERSONAL : i.conversationId ?? PERSONAL);
  for (const i of shown) { const k = groupBy === 'person' ? i.ownerId ?? NONE : convOf(i); buckets.set(k, [...(buckets.get(k) ?? []), i]); }
  const sectionTitle = (k: string) => {
    if (groupBy === 'person') return k === NONE ? t('issue.noOwner') : `${personById(d, k)?.name ?? t('common.participant')}${k === d.me.id ? ` ${t('common.you')}` : ''}`;
    if (k === PERSONAL) return `🔒 ${t('issue.personalSection')}`;
    const c = d.conversations.find((x) => x.id === k);
    const ws = c?.workspaceId ? d.workspaces.find((w) => w.id === c.workspaceId) : null;
    return c ? [ws?.name, conversationTitle(d, c)].filter(Boolean).join(' · ') : t('task.sharedWithMe');
  };
  const sections = [...buckets.entries()].sort(([a, ai], [b, bi]) => groupBy === 'person'
    ? (Number(b === d.me.id) - Number(a === d.me.id)) || (Number(a === NONE) - Number(b === NONE)) || sectionTitle(a).localeCompare(sectionTitle(b))
    : bi.length - ai.length || sectionTitle(a).localeCompare(sectionTitle(b)));
  const label = { mine: t('issue.mine'), open: t('issue.allOpen'), closed: t('issue.closed') };
  const count = (f: 'mine' | 'open' | 'closed') => Object.values(all).filter((i) => (!i.conversationId || visibleConvs.has(i.conversationId) || isRestricted(i)) && (f === 'closed' ? isClosed(i) : !isClosed(i) && (f === 'open' || i.ownerId === d.me.id))).length;
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 900 }}>
      <div className="row page-head"><h1 className="grow">{t('nav.issues')}</h1><QuickActions /></div>
      <div className="row issue-toolbar">
        <div className="seg">
          {(['mine', 'open', 'closed'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => { setFilter(f); remember('chaggu:issueFilter', f); }}>{label[f]} <span className="muted">{count(f)}</span></button>)}
        </div>
        <div className="seg" role="radiogroup" aria-label={t('issue.groupBy')}>
          {(['group', 'person'] as const).map((g) => <button key={g} role="radio" aria-checked={groupBy === g} className={groupBy === g ? 'on' : ''} onClick={() => { setGroupBy(g); remember('chaggu:issueGroupBy', g); }}>{g === 'group' ? t('issue.byGroup') : t('issue.byPerson')}</button>)}
        </div>
      </div>
      {filter !== 'closed' && <QuickAddIssue />}
      {error && <div className="error">{error}</div>}
      {list.length === 0 && <div className="empty">{t('issue.empty')}</div>}
      {sections.map(([k, items]) => (
        <section key={k} style={{ marginBottom: 18 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>{sectionTitle(k)} · {items.length}</div>
          <div className="list" style={{ gap: 6 }}>{items.map((i) => groupBy === 'group'
            ? <IssueWithTasks key={i.id} i={i} showWhere={false} onOpen={setOpen} />
            : <IssueRow key={i.id} i={i} showWhere showOwner={false} onOpen={setOpen} />)}</div>
        </section>
      ))}
      {open && <IssueDrawer id={open} onClose={() => setOpen(null)} />}
    </div></div>
  );
}

// ---------- Tareas derivadas de un asunto ----------

/** Visibilidad por defecto de una tarea: si en el chat hay más de una empresa, «solo mi empresa». */
function defaultVisibility(d: BootstrapDTO, conversationId: string | null): IssueVisibility {
  const orgs = new Set(membersOf(d, conversationId).map((p) => p.orgId ?? 'guest'));
  return orgs.size > 1 && d.me.primaryOrgId ? 'org' : 'all';
}

/**
 * Alta de una tarea: título, ¿quién la hace? (del chat o cualquier contacto) y ¿quién la ve?
 * Si la persona no está en el chat, la tarea no puede ser «de todo el chat»: pasa a privada sola.
 * En un sidechat (conversationId), la ven solo los del sidechat.
 */
function TaskQuickAdd({ parent, conversationId, autoFocus }: { parent: IssueDTO; conversationId?: string; autoFocus?: boolean }) {
  const d = useClient((s) => s.data)!;
  const where = (conversationId ?? parent.conversationId)!;
  const inSide = where !== parent.conversationId;
  const members = membersOf(d, where);
  const [title, setTitle] = useState('');
  const [ownerId, setOwnerId] = useState(d.me.id);
  const [vis, setVis] = useState<IssueVisibility>(() => (inSide ? 'all' : defaultVisibility(d, parent.conversationId)));
  const [busy, setBusy] = useState(false);
  const [pickOther, setPickOther] = useState(false);
  const outsider = !members.some((p) => p.id === ownerId);
  const effective: IssueVisibility = outsider && vis === 'all' ? 'private' : vis;
  const myOrg = orgById(d, d.me.primaryOrgId);
  const contacts = d.people.filter((p) => p.kind === 'human' && !members.some((m) => m.id === p.id) && p.id !== d.me.id);
  const owner = personById(d, ownerId);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (text.length < 2 || busy) return;
    setBusy(true);
    try {
      await client.createChildIssue(parent.id, { title: text, ownerId, visibility: effective, ...(inSide ? { conversationId: where } : {}) });
      setTitle('');
    } catch (err) { toast(errorText(err)); } finally { setBusy(false); }
  }
  const visOptions: [IssueVisibility, string][] = inSide
    ? [['all', t('task.visSide')], ['private', t('task.visPrivate')]]
    : [['all', t('task.visAll')], ...(myOrg ? [['org', t('task.visOrg', { org: myOrg.name })] as [IssueVisibility, string]] : []), ['private', t('task.visPrivate')]];
  return (
    <form className="task-add" onSubmit={submit}>
      <div className="issue-quick" style={{ marginBottom: 0 }}>
        <span className="issue-check ghost" aria-hidden>＋</span>
        <input className="grow" autoFocus={autoFocus} placeholder={t('task.ph')} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('task.title')}
          onKeyDown={(e) => { if (e.key === 'Escape') setTitle(''); }} />
        <button className="btn primary small" disabled={busy || title.trim().length < 2}>{t('issue.add')}</button>
      </div>
      {title.length > 0 && (
        <>
          <div className="chips" aria-label={t('issue.qWho')}>
            <span className="small muted">{t('issue.qWho')}</span>
            {members.map((p) => (
              <button type="button" key={p.id} className={`chip-person ${ownerId === p.id ? 'on' : ''}`} aria-pressed={ownerId === p.id} onClick={() => setOwnerId(p.id)}>
                <Avatar person={p} org={orgById(d, p.orgId)} size={20} /> {p.id === d.me.id ? t('issue.me') : p.name.split(' ')[0]}
              </button>
            ))}
            {outsider && owner && <button type="button" className="chip-person on"><Avatar person={owner} org={orgById(d, owner.orgId)} size={20} /> {owner.name.split(' ')[0]}</button>}
            {contacts.length > 0 && (pickOther
              ? <select className="input" autoFocus style={{ maxWidth: 220 }} value="" onChange={(e) => { if (e.target.value) { setOwnerId(e.target.value); setPickOther(false); } }}>
                  <option value="">{t('task.pickPerson')}</option>
                  {contacts.map((p) => <option key={p.id} value={p.id}>{p.name} · {orgById(d, p.orgId)?.name ?? t('common.guest')}</option>)}
                </select>
              : <button type="button" className="chip-person ghost" onClick={() => setPickOther(true)}>＋ {t('task.otherPerson')}</button>)}
          </div>
          <div className="chips" aria-label={t('task.whoSees')}>
            <span className="small muted">{t('task.whoSees')}</span>
            {visOptions.map(([v, label]) => (
              <button type="button" key={v} className={`chip ${effective === v ? 'on' : ''}`} aria-pressed={effective === v}
                disabled={outsider && v === 'all'} onClick={() => setVis(v)}>{v === 'all' ? '👁' : '🔒'} {label}</button>
            ))}
          </div>
          {outsider && owner && <div className="hint">{t('task.outsiderHint', { name: owner.name.split(' ')[0]! })}</div>}
        </>
      )}
    </form>
  );
}

/** «Tareas» dentro del asunto: la lista (lo que yo puedo ver) y el alta. */
function TasksSection({ parentId, onOpen, conversationId }: { parentId: string; onOpen: (id: string) => void; conversationId?: string }) {
  const all = useClient((s) => s.issues);
  const parent = all[parentId];
  if (!parent) return null;
  const kids = childrenOf(all, parentId);
  const done = kids.filter(isClosed).length;
  const closed = isClosed(parent);
  return (
    <div className="issue-q">
      <div className="issue-q-label">{t('task.section')}{kids.length ? ` · ${done}/${kids.length}` : ''}</div>
      {kids.length > 0 && <div className="list" style={{ gap: 4 }}>{kids.map((k) => <IssueRow key={k.id} i={k} child showWhere={false} onOpen={onOpen} />)}</div>}
      {!closed && <TaskQuickAdd parent={parent} conversationId={conversationId} />}
      {!closed && !kids.length && <div className="hint">{t('task.hint')}</div>}
    </div>
  );
}

/** Diálogo rápido «＋ Tarea» (desde el menú del asunto, el botón de la fila o un sidechat). */
export function TasksDialog({ parentId, conversationId, onClose }: { parentId: string; conversationId?: string; onClose: () => void }) {
  const parent = useClient((s) => s.issues[parentId]);
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <IssueDrawer id={open} onClose={onClose} />;
  if (!parent) return null;
  return (
    <Modal title={t('task.dialogTitle', { title: parent.title })} onClose={onClose}>
      <TasksSection parentId={parentId} conversationId={conversationId} onOpen={setOpen} />
      <div className="modal-actions"><button className="btn primary" onClick={onClose}>{t('common.done')}</button></div>
    </Modal>
  );
}

/** Quién ve la tarea (solo quien la creó lo cambia). */
function VisibilityChoice({ issue }: { issue: IssueDTO }) {
  const d = useClient((s) => s.data)!;
  const myOrg = orgById(d, d.me.primaryOrgId);
  const set = (visibility: IssueVisibility) => client.updateIssue(issue.id, { visibility }).catch((e) => toast(errorText(e)));
  const opts: [IssueVisibility, string][] = [['all', t('task.visAll')], ...(myOrg ? [['org', t('task.visOrg', { org: myOrg.name })] as [IssueVisibility, string]] : []), ['private', t('task.visPrivate')]];
  return (
    <div className="issue-q">
      <div className="issue-q-label">{t('task.whoSees')}</div>
      <div className="chips">
        {opts.map(([v, label]) => <button key={v} className={`chip ${issue.visibility === v ? 'on' : ''}`} aria-pressed={issue.visibility === v} onClick={() => void set(v)}>{v === 'all' ? '👁' : '🔒'} {label}</button>)}
      </div>
    </div>
  );
}

/** «Hablar aparte»: un sidechat desde el asunto con quienes elija; sus tareas quedan colgadas del asunto. */
export function SideFromIssueDialog({ issue, onClose }: { issue: IssueDTO; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const others = membersOf(d, issue.conversationId).filter((p) => p.id !== d.me.id);
  const [picked, setPicked] = useState<string[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const go = async () => {
    setBusy(true);
    try {
      const r = await client.openSide(issue.conversationId!, { issueId: issue.id, userIds: picked, ...(question.trim() ? { question: question.trim() } : {}) });
      onClose();
      navigate(`/c/${r.id}`);
    } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('task.sidechat')} onClose={onClose}>
      <div className="muted">{t('task.sideExplain', { title: issue.title })}</div>
      <div className="chips" style={{ margin: '12px 0' }}>
        {others.map((p) => (
          <button key={p.id} className={`chip-person ${picked.includes(p.id) ? 'on' : ''}`} aria-pressed={picked.includes(p.id)} onClick={() => toggle(p.id)}>
            <Avatar person={p} org={orgById(d, p.orgId)} size={20} /> {p.name.split(' ')[0]}
          </button>
        ))}
      </div>
      <input className="input" placeholder={t('task.sideFirst')} value={question} onChange={(e) => setQuestion(e.target.value)} />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !picked.length} onClick={() => void go()}>💬 {t('task.sideGo')}</button>
      </div>
    </Modal>
  );
}

/** Franja en un sidechat que salió de un asunto: el asunto, su avance y «＋ Tarea». */
export function SideIssueStrip({ sideId, issueId, onOpen }: { sideId: string; issueId: string; onOpen: (id: string) => void }) {
  const all = useClient((s) => s.issues);
  useEffect(() => { if (!all[issueId]) void client.issueDetail(issueId).catch(() => {}); }, [issueId]);
  const parent = all[issueId];
  if (!parent) return null;
  const kids = childrenOf(all, issueId);
  const done = kids.filter(isClosed).length;
  return (
    <div className="side-issue-strip">
      <button className="grow ellipsis link-btn" onClick={() => onOpen(issueId)}>◆ {parent.title}{kids.length ? ` · ☑ ${done}/${kids.length}` : ''}</button>
      <button className="btn small" onClick={() => openDialog((close) => <TasksDialog parentId={issueId} conversationId={sideId} onClose={close} />)}>＋ {t('task.short')}</button>
    </div>
  );
}
