import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { BootstrapDTO, IssueDTO, IssueEventDTO, IssueFieldValue, IssueReview, IssueStatus, IssueVisibility, TaskInboxReason } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { updateIssuePreferences, usePersonalPreferences } from '../personal-prefs.ts';
import { PinToGrid } from './Tray.tsx';
import { setDrag } from '../grid-actions.ts';
import { errorText, locale, t } from '../i18n.ts';
import { navigate, queryParam } from '../router.ts';
import { Avatar, Modal, conversationTitle, orgById, personById } from '../ui.tsx';
import { menuProps, toast, type MenuItem } from '../menu.tsx';
import { destinationLabel, issueDestinations } from '../quick-search.ts';
import { QuickActions } from './Quick.tsx';
import { openDialog } from '../actions.tsx';
import { IssueTopicTag, issueTopicMenu } from './Topics.tsx';
import { assignedTo, taskAssignees } from '../task-report.ts';
import { TaskReportButton, taskText } from './TaskReports.tsx';
import { TaskAttachments } from './TaskAttachments.tsx';
import { FieldControl, TaskColumnsDialog, columnsOf, useTaskColumns } from './TaskColumns.tsx';

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

/** Revisión humana (llamada con Lorena 7-oct): la IA resuelve, una persona aprueba, pide corrección o la toma. */
export const REVIEWS: IssueReview[] = ['pending', 'changes', 'human', 'approved'];
export function reviewLabel(r: IssueReview) {
  return ({ pending: taskText('Por revisar', 'To review'), approved: taskText('Aprobada', 'Approved'), changes: taskText('Corregir', 'Changes requested'), human: taskText('Intervención humana', 'Needs a person') })[r];
}
const REVIEW_ICON: Record<IssueReview, string> = { pending: '👀', approved: '✅', changes: '✎', human: '🙋' };
export function ReviewPill({ review }: { review: IssueReview }) {
  return <span className={`review-pill review-${review}`}>{REVIEW_ICON[review]} {reviewLabel(review)}</span>;
}
export function inboxReasonLabel(r: TaskInboxReason) {
  return ({ assigned: taskText('Te la asignaron', 'Assigned to you'), review: taskText('Te piden revisarla', 'Review requested'), reviewed: taskText('Ya la revisaron', 'Reviewed') })[r];
}

/** Revisar: aprobar, pedir corrección (con comentario para quien la resolvió) o marcar que necesita a una persona. */
function ReviewBar({ i, onError }: { i: IssueDTO; onError: (e: string) => void }) {
  const d = useClient((s) => s.data)!;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const set = async (r: IssueReview | null) => {
    if (busy) return;
    if (r === 'changes' && !note.trim()) { onError(taskText('Escribe qué hay que corregir.', 'Write what needs to change.')); return; }
    setBusy(true);
    try { await client.reviewIssue(i.id, r, note.trim() || undefined); setNote(''); } catch (e) { onError(errorText(e)); } finally { setBusy(false); }
  };
  const by = i.reviewBy ? personById(d, i.reviewBy)?.name : null;
  return (
    <div className={`issue-q review-bar ${i.review ? `is-${i.review}` : ''}`}>
      <div className="issue-q-label">{taskText('Revisión', 'Review')}{i.review ? <> · <ReviewPill review={i.review} />{by ? <span className="small muted"> {by}</span> : null}</> : null}</div>
      <div className="chips">
        {i.review !== 'approved' && <button className="chip" disabled={busy} onClick={() => void set('approved')}>✅ {taskText('Aprobar', 'Approve')}</button>}
        <button className="chip" disabled={busy} onClick={() => void set('changes')}>✎ {taskText('Pedir corrección', 'Request changes')}</button>
        {i.review !== 'human' && <button className="chip" disabled={busy} onClick={() => void set('human')}>🙋 {taskText('Necesita intervención humana', 'Needs a person')}</button>}
        {!i.review && <button className="chip ghost" disabled={busy} onClick={() => void set('pending')}>👀 {taskText('Dejar por revisar', 'Mark for review')}</button>}
        {i.review && <button className="chip ghost" disabled={busy} onClick={() => void set(null)}>{taskText('Quitar revisión', 'Clear review')}</button>}
      </div>
      <textarea className="input" rows={2} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)}
        placeholder={taskText('Comentario para quien la resolvió (obligatorio para pedir corrección)', 'Note for whoever solved it (required to request changes)')} />
    </div>
  );
}

export function StatusPill({ status }: { status: IssueStatus }) {
  return <span className={`ist ist-${status}`}>{t(`issue.st.${status}`)}</span>;
}

/** Valor de un campo dinámico para mostrar: sí/no en los booleanos. */
export function fieldText(v: IssueFieldValue | undefined) {
  if (v === undefined) return '';
  if (typeof v === 'boolean') return v ? taskText('Sí', 'Yes') : taskText('No', 'No');
  return String(v);
}

/** Columnas dinámicas de una lista: la unión de los campos de sus tareas, en el orden en que aparecen. */
export function fieldColumns(list: IssueDTO[]) {
  const cols: string[] = [];
  for (const i of list) for (const k of Object.keys(i.fields ?? {})) if (!cols.includes(k)) cols.push(k);
  return cols;
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

export function IssueRow({ i, showWhere = true, showOwner = true, child = false, hideFields = false, onOpen }: { i: IssueDTO; showWhere?: boolean; showOwner?: boolean; child?: boolean; hideFields?: boolean; onOpen: (id: string) => void }) {
  const d = useClient((s) => s.data)!;
  const all = useClient((s) => s.issues);
  const owner = personById(d, i.ownerId);
  const responsible = taskAssignees(i).map((uid) => personById(d, uid)?.name ?? t('common.participant')).join(', ');
  const conv = d.conversations.find((c) => c.id === i.conversationId);
  const f = issueFlags(i);
  const done = isClosed(i);
  const kids = i.parentIssueId ? [] : childrenOf(all, i.id);
  const kidsDone = kids.filter(isClosed).length;
  const parent = i.parentIssueId ? all[i.parentIssueId] : null;
  // Una tarea en un sidechat se marca para que se sepa dónde se habla de ella.
  const inSide = !!parent && parent.conversationId !== i.conversationId;
  const isNew = useClient((s) => s.taskInbox.some((x) => x.issueId === i.id));
  const meta = [
    isPersonal(i) ? t('issue.personalShort') : showOwner ? responsible || t('issue.noOwner') : null,
    !child && parent ? `↳ ${parent.title}` : null,
    !child && !parent && i.parentIssueId ? t('task.ofHidden') : null,
    showWhere && conv && !child ? t('issue.in', { name: conversationTitle(d, conv) }) : null,
    inSide ? `💬 ${t('task.inSide')}` : null,
    i.commentCount > 0 ? `💬 ${i.commentCount}` : null,
  ].filter(Boolean);
  return (
    <div role="button" tabIndex={0} draggable title={t('grid.dragTask')} onDragStart={(e) => { setDrag(e, 'task', { id: i.id, title: i.title }, i.title); e.dataTransfer.setData('application/x-chaggu-issue-id', i.id); }} className={`card issue-row ${child ? 'is-child' : ''} ${f.stalledDays || f.overdue ? 'is-jam' : ''} ${done ? 'is-done' : ''} ${isNew ? 'is-new' : ''}`}
      onClick={() => onOpen(i.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(i.id); }} {...menuProps(() => issueQuickMenu(i))}>
      {child && <span className="child-elbow" aria-hidden>↳</span>}
      <IssueCheck i={i} size={child ? 18 : 20} />
      <span className="grow" style={{ minWidth: 0 }}>
        <b className="ellipsis issue-title" style={{ display: 'block' }}>
          {isNew && <span className="new-dot" title={taskText('Nueva', 'New')} aria-label={taskText('Nueva', 'New')} />}
          {(isRestricted(i) || isPersonal(i)) && <span className="lock" title={isPersonal(i) ? t('issue.personalOption') : visibilityLabel(d, i)} aria-label={isPersonal(i) ? t('issue.personalOption') : visibilityLabel(d, i)}>🔒 </span>}{i.title}
        </b>
        {(meta.length > 0 || i.topicId) && <span className="small muted ellipsis issue-meta" style={{ display: 'block' }}>
          <IssueTopicTag issueId={i.id} conversationId={i.conversationId} topicId={i.topicId} canEdit={!!conv?.canPost} />{meta.join(' · ')}
        </span>}
        {!hideFields && i.fields && <span className="issue-fields-inline ellipsis">{Object.entries(i.fields).slice(0, 4).map(([k, v]) => <span key={k} className="issue-field-chip"><span className="muted">{k}</span> {fieldText(v)}</span>)}</span>}
      </span>
      {kids.length > 0 && <span className={`kids-badge ${kidsDone === kids.length ? 'all-done' : ''}`} title={t('task.progress', { done: kidsDone, n: kids.length })}>☑ {kidsDone}/{kids.length}</span>}
      {f.stalledDays > 0 && <span className="jam-badge" title={t('issue.bottleneck')}>⏱ {f.stalledDays === 1 ? t('issue.stalledOne') : t('issue.stalled', { n: f.stalledDays })}</span>}
      {i.dueDate && <span className={`small ${f.overdue ? 'error' : 'muted'}`} style={{ whiteSpace: 'nowrap' }}>{f.overdue ? t('issue.overdue') : f.dueToday ? t('issue.today') : dueLabel(i)}</span>}
      {i.review && <ReviewPill review={i.review} />}
      {(i.status === 'in_progress' || i.status === 'waiting' || i.status === 'cancelled') && <StatusPill status={i.status} />}
      {!i.parentIssueId && !done && !isPersonal(i) && (
        <button className="row-add" title={t('task.add')} aria-label={t('task.add')}
          onClick={(e) => { e.stopPropagation(); openDialog((close) => <TasksDialog parentId={i.id} onClose={close} />); }}>＋</button>
      )}
      {showOwner && <span className="row" title={responsible} style={{ gap: 3 }}><Avatar person={owner} org={orgById(d, owner?.orgId)} size={child ? 20 : 24} />{taskAssignees(i).length > 1 && <span className="small muted">+{taskAssignees(i).length - 1}</span>}</span>}
    </div>
  );
}

/** Un asunto con sus tareas debajo, sangradas. */
export function IssueWithTasks({ i, showWhere, showOwner, onOpen, allowedIds }: { allowedIds?: Set<string>; i: IssueDTO; showWhere?: boolean; showOwner?: boolean; onOpen: (id: string) => void }) {
  const all = useClient((s) => s.issues);
  const kids = childrenOf(all, i.id).filter((child) => !allowedIds || allowedIds.has(child.id));
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
export function NewIssueDialog({ conversationId, originMessageId, defaultTitle = '', defaultAssigneeName, defaultDue, topicId, onClose, onCreated }: {
  conversationId?: string; originMessageId?: string; defaultTitle?: string; topicId?: string | null; onClose: () => void; onCreated?: (i: IssueDTO) => void;
  /** Lo que propuso «gg de este chat»: el responsable por nombre (si está en el chat) y la fecha YYYY-MM-DD. */
  defaultAssigneeName?: string | null; defaultDue?: string | null;
}) {
  const d = useClient((s) => s.data)!;
  const destinations = useMemo(() => (conversationId ? [] : issueDestinations(d)), [d, conversationId]);
  const [conv, setConv] = useState(conversationId ?? PERSONAL_DEST);
  const members = membersOf(d, conv);
  const [title, setTitle] = useState(defaultTitle);
  const [assigneeIds, setAssigneeIds] = useState<string[]>(() => {
    const fold = (x: string) => x.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
    const want = defaultAssigneeName ? fold(defaultAssigneeName) : '';
    const hit = want ? members.find((p) => fold(p.name) === want || fold(p.name).split(' ')[0] === want.split(' ')[0]) : null;
    return [hit?.id ?? d.me.id];
  });
  const [due, setDue] = useState(defaultDue && /^\d{4}-\d{2}-\d{2}$/.test(defaultDue) ? defaultDue : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!conv) return;
    setBusy(true); setError(null);
    try {
      const i = conv === PERSONAL_DEST
        ? await client.createPersonalIssue({ title, dueDate: due || null })
        : await client.createIssue(conv, { title, assigneeIds: assigneeIds.filter((uid) => members.some((p) => p.id === uid)), dueDate: due || null, originMessageId: originMessageId ?? null, ...(topicId && !originMessageId ? { topicId } : {}) });
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
            <select className="input" value={conv} onChange={(e) => { setConv(e.target.value); setAssigneeIds([d.me.id]); }}>
              <option value={PERSONAL_DEST}>🔒 {t('issue.personalOption')}</option>
              {destinations.map((c) => <option key={c.id} value={c.id}>{destinationLabel(d, c, conversationTitle(d, c))}</option>)}
            </select>
          </label>
        )}
        {conv === PERSONAL_DEST && <div className="hint">🔒 {t('issue.personalHint')}</div>}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {conv !== PERSONAL_DEST && <label className="field grow"><span>{t('issue.owner')}</span>
            <div className="chips">{members.map((p) => <button key={p.id} type="button" className={`chip-person ${assigneeIds.includes(p.id) ? 'on' : ''}`} aria-pressed={assigneeIds.includes(p.id)} onClick={() => setAssigneeIds((ids) => ids.includes(p.id) ? ids.filter((uid) => uid !== p.id) : [...ids, p.id])}>{p.name}{p.id === d.me.id ? ` ${t('common.you')}` : ''}</button>)}</div>
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
    case 'assignees': return `${taskText('Responsables', 'Responsible')} → ${(p.to as string[]).map((id) => personById(d, id)?.name ?? t('common.participant')).join(', ') || t('issue.noOwner')}`;
    case 'attachments': return `${taskText('Archivos de la tarea', 'Task files')}: ${p.count}`;
    case 'moved': return taskText('Tarea movida de chat', 'Task moved to another chat');
    case 'owner': return `${t('issue.ev.owner')} → ${personById(d, p.to)?.name ?? t('common.none')}`;
    case 'due': return t('issue.ev.due', { to: p.to ? new Date(`${p.to}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) : t('issue.noDue') });
    case 'title': return `${t('issue.ev.title')} → «${p.to}»`;
    case 'waiting': return `${t('issue.ev.waiting')}${p.to ? `: ${orgById(d, p.to)?.name ?? ''}` : ''}`;
    case 'review': return `${taskText('Revisión', 'Review')} → ${p.to ? reviewLabel(p.to) : taskText('sin revisión', 'none')}`;
    case 'fields': return `${taskText('Campos', 'Fields')}: ${[...(p.changed ?? []), ...(p.removed ?? []).map((k: string) => `−${k}`)].join(', ')}`;
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
  const [uploading, setUploading] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const uploadInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const load = () => client.issueDetail(id).then((r) => setEvents(r.events)).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); }, [id, live?.updatedAt]);
  // Abrirla la saca de «Nuevas».
  useEffect(() => { void client.markTaskInboxSeen([id]); }, [id]);
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
  const update = async (patch: Parameters<typeof client.updateIssue>[1]) => { if (saveLock.current) return; saveLock.current = true; setSaving(true); try { await client.updateIssue(i.id, patch); } catch (e) { setError(errorText(e)); } finally { saveLock.current = false; setSaving(false); } };
  const upload = async (files: FileList | null) => {
    if (!files?.length || uploading) return;
    if ((i.attachments?.length ?? 0) + files.length > 20) { setError(taskText('Máximo 20 archivos por tarea.', 'Maximum 20 files per task.')); return; }
    setUploading(true); setError(null);
    try {
      const added: string[] = [];
      for (const file of Array.from(files)) { const a = await client.uploadIssueAttachment(i.id, file, file.name); added.push(a.id); }
      await client.updateIssue(i.id, { attachmentIds: [...(i.attachments ?? []).map((a) => a.id), ...added] });
    } catch (e) { setError(errorText(e)); } finally { setUploading(false); if (uploadInput.current) uploadInput.current.value = ''; }
  };

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
      {!isPersonal(i) && <ReviewBar i={i} onError={setError} />}

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
            <button key={p.id} className={`chip-person ${assignedTo(i, p.id) ? 'on' : ''}`} aria-pressed={assignedTo(i, p.id)} disabled={saving} onClick={() => update({ assigneeIds: assignedTo(i, p.id) ? taskAssignees(i).filter((uid) => uid !== p.id) : [...taskAssignees(i), p.id] })}>
              <Avatar person={p} org={orgById(d, p.orgId)} size={22} /> {p.id === d.me.id ? t('issue.me') : p.name.split(' ')[0]}
            </button>
          ))}
          {taskAssignees(i).length > 0 && <button className="chip-person ghost" disabled={saving} onClick={() => update({ assigneeIds: [] })}>{t('issue.noOwner')}</button>}
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

      <IssueFields issue={i} disabled={saving} onSave={(fields) => update({ fields })} />

      <div className="issue-q">
        <div className="issue-q-label">{taskText('Imágenes y documentos', 'Images and documents')} · {i.attachments?.length ?? 0}</div>
        <TaskAttachments files={i.attachments ?? []} disabled={uploading} onRemove={(fileId) => void update({ attachmentIds: (i.attachments ?? []).filter((a) => a.id !== fileId).map((a) => a.id) })} />
        <div className="task-attachment-actions"><button className="btn small" disabled={uploading} onClick={() => uploadInput.current?.click()}>📎 {uploading ? taskText('Subiendo…', 'Uploading…') : taskText('Agregar archivo', 'Add file')}</button><span className="small muted">{taskText('Cada archivo comparte la privacidad de esta tarea · 25 MB por archivo.', 'Files share this task’s privacy · 25 MB per file.')}</span></div>
        <input ref={uploadInput} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
      </div>
      {!isPersonal(i) && i.createdBy === d.me.id && <div className="issue-q">
        <div className="issue-q-label">{taskText('Mover a otro chat', 'Move to another chat')}</div>
        <div className="task-move-form"><select className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label={taskText('Chat de destino', 'Destination chat')}><option value="">{taskText('Elegir chat…', 'Choose chat…')}</option>{issueDestinations(d).filter((c) => c.id !== i.conversationId).map((c) => <option key={c.id} value={c.id}>{destinationLabel(d, c, conversationTitle(d, c))}</option>)}</select><button className="btn small" disabled={!moveTo || childrenOf(client.getState().issues, i.id).length > 0} onClick={() => void update({ conversationId: moveTo }).then(() => setMoveTo(''))}>{taskText('Mover', 'Move')}</button></div>
        <p className="hint">{childrenOf(client.getState().issues, i.id).length ? taskText('Mueve primero las subtareas. Cada responsable debe participar en el chat de destino para tareas visibles a todo el chat.', 'Move subtasks first. Every responsible person must belong to the destination for tasks visible to the whole chat.') : taskText('La tarea se verá en el destino según su privacidad. Si sales del chat de la tarea principal, se independiza.', 'The task appears at the destination with its visibility. Moving outside the parent task chat detaches it.')}</p>
      </div>}

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

/**
 * Campos dinámicos de la tarea (columnas propias): los trae un webhook, el MCP o se agregan a mano.
 * Editar un valor guarda al salir del campo; vaciarlo o tocar × lo borra.
 */
function IssueFields({ issue, disabled, onSave }: { issue: IssueDTO; disabled: boolean; onSave: (fields: Record<string, IssueFieldValue | null>) => Promise<void> }) {
  const defined = useTaskColumns([issue.conversationId]);
  const canEditColumns = !!columnsOf(issue.conversationId)?.canEdit;
  const isDefined = (k: string) => defined.some((c) => c.name.toLowerCase() === k.toLowerCase());
  const entries = Object.entries(issue.fields ?? {}).filter(([k]) => !isDefined(k));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !value.trim()) return;
    await onSave({ [name.trim()]: value.trim() });
    setName(''); setValue(''); setAdding(false);
  };
  return (
    <div className="issue-q">
      <div className="issue-q-label">{taskText('Campos', 'Fields')}{entries.length ? ` · ${entries.length}` : ''}
        {canEditColumns && <button className="link-btn small" style={{ marginLeft: 8 }} onClick={() => openDialog((close) => <TaskColumnsDialog conversationId={issue.conversationId} onClose={close} />)}>⚙ {taskText('Columnas del grupo', 'Group columns')}</button>}
      </div>
      {defined.length > 0 && <dl className="issue-fields">
        {defined.map((col) => (
          <div key={col.name} className="issue-field">
            <dt>{col.name}</dt>
            <dd><FieldControl column={col} value={Object.entries(issue.fields ?? {}).find(([k]) => k.toLowerCase() === col.name.toLowerCase())?.[1]} disabled={disabled} onChange={(v) => void onSave({ [col.name]: v })} /></dd>
            <span />
          </div>
        ))}
      </dl>}
      {entries.length > 0 && <dl className="issue-fields">
        {entries.map(([k, v]) => (
          <div key={k} className="issue-field">
            <dt>{k}</dt>
            <dd>{typeof v === 'boolean'
              ? <button className={`chip ${v ? 'on' : ''}`} disabled={disabled} aria-pressed={v} onClick={() => void onSave({ [k]: !v })}>{fieldText(v)}</button>
              : <textarea key={String(v)} className="input issue-field-input" rows={String(v).length > 60 || String(v).includes('\n') ? 3 : 1} defaultValue={String(v)} disabled={disabled} aria-label={k}
                  onBlur={(e) => { const next = e.currentTarget.value.trim(); if (next === String(v)) return; void onSave({ [k]: next === '' ? null : typeof v === 'number' && next !== '' && !Number.isNaN(Number(next)) ? Number(next) : next }); }} />}
            </dd>
            <button className="link-btn muted issue-field-x" disabled={disabled} title={taskText('Quitar campo', 'Remove field')} aria-label={taskText(`Quitar ${k}`, `Remove ${k}`)} onClick={() => void onSave({ [k]: null })}>×</button>
          </div>
        ))}
      </dl>}
      {adding
        ? <form className="issue-field-add" onSubmit={add}>
            <input className="input" autoFocus placeholder={taskText('Nombre (p. ej. Servicios)', 'Name (e.g. Services)')} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input grow" placeholder={taskText('Valor', 'Value')} maxLength={2000} value={value} onChange={(e) => setValue(e.target.value)} />
            <button className="btn small primary" disabled={disabled || !name.trim() || !value.trim()}>{taskText('Agregar', 'Add')}</button>
            <button type="button" className="btn small ghost" onClick={() => setAdding(false)}>{taskText('Cancelar', 'Cancel')}</button>
          </form>
        : <button className="btn small" disabled={disabled || entries.length >= 30} onClick={() => setAdding(true)}>＋ {taskText('Agregar campo', 'Add field')}</button>}
    </div>
  );
}

/** Tabla de tareas: columnas fijas + una por cada campo dinámico que traen las tareas de la lista. */
function IssueTable({ list, onOpen }: { list: IssueDTO[]; onOpen: (id: string) => void }) {
  const d = useClient((s) => s.data)!;
  const defined = useTaskColumns(list.map((i) => i.conversationId));
  const cols = [...defined.map((c) => c.name), ...fieldColumns(list).filter((k) => !defined.some((c) => c.name.toLowerCase() === k.toLowerCase()))];
  const [error, setError] = useState<string | null>(null);
  const valueOf = (i: IssueDTO, c: string) => Object.entries(i.fields ?? {}).find(([k]) => k.toLowerCase() === c.toLowerCase())?.[1];
  // Una lista desplegable o casilla se cambia en la misma celda si la columna es del grupo de esa tarea.
  const cell = (i: IssueDTO, c: string) => {
    const col = columnsOf(i.conversationId)?.columns.find((x) => x.name.toLowerCase() === c.toLowerCase());
    const v = valueOf(i, c);
    if (col && (col.type === 'select' || col.type === 'checkbox') && !isClosed(i)) {
      return <FieldControl column={col} value={v} onChange={(next) => { setError(null); client.updateIssue(i.id, { fields: { [col.name]: next } }).catch((e) => setError(errorText(e))); }} />;
    }
    return v !== undefined ? fieldText(v) : <span className="muted">—</span>;
  };
  return (
    <div className="issue-table-wrap">
      <table className="issue-table">
        <thead><tr>
          <th>{t('issue.title')}</th><th>{taskText('Estado', 'Status')}</th><th>{taskText('Responsables', 'Assignees')}</th><th>{taskText('Fecha', 'Due')}</th>
          {cols.map((c) => <th key={c}>{c}</th>)}
          <th>{taskText('Chat', 'Chat')}</th>
        </tr></thead>
        <tbody>{list.map((i) => {
          const conv = d.conversations.find((c) => c.id === i.conversationId);
          return (
            <tr key={i.id} tabIndex={0} className={isClosed(i) ? 'is-done' : ''} onClick={() => onOpen(i.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(i.id); }} {...menuProps(() => issueQuickMenu(i))}>
              <td className="issue-table-title"><IssueCheck i={i} size={18} /> <span>{i.title}</span></td>
              <td><StatusPill status={i.status} /></td>
              <td>{taskAssignees(i).map((uid) => personById(d, uid)?.name.split(' ')[0] ?? t('common.participant')).join(', ') || <span className="muted">—</span>}</td>
              <td className={issueFlags(i).overdue ? 'error' : ''}>{i.dueDate ? dueLabel(i) : <span className="muted">—</span>}</td>
              {cols.map((c) => <td key={c} title={fieldText(valueOf(i, c))} onClick={(e) => { if ((e.target as HTMLElement).closest('select, input')) e.stopPropagation(); }}>{cell(i, c)}</td>)}
              <td className="muted">{conv ? conversationTitle(d, conv) : isPersonal(i) ? '🔒' : ''}</td>
            </tr>
          );
        })}</tbody>
      </table>
      {error && <div className="error" style={{ padding: 8 }}>{error}</div>}
    </div>
  );
}

const TABLE_KEY = 'chaggu.issues.table';
function readTablePref() { try { return localStorage.getItem(TABLE_KEY) === '1'; } catch { return false; } }

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

/** La lista de asuntos con sus filtros: la página Tareas y el panel de la cuadrícula comparten esto. */
export function IssuesBody() {
  const d = useClient((s) => s.data)!;
  const all = useClient((s) => s.issues);
  const preferences = usePersonalPreferences();
  const [scope, setScope] = useState<'mine' | 'byMe' | 'all'>('mine');
  const [stateFilter, setStateFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [table, setTableState] = useState(readTablePref);
  const setTable = (on: boolean) => { setTableState(on); try { localStorage.setItem(TABLE_KEY, on ? '1' : '0'); } catch { /* sin almacenamiento */ } };
  const view = table ? 'table' : preferences.issues?.view ?? 'list';
  const groupBy = preferences.issues?.grouping === 'assignee' ? 'person' : 'group';
  const [pendingMoves, setPendingMoves] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  // «Asignadas por mí»: las que creé o pedí para otras personas.
  const byMe = (i: IssueDTO) => (i.createdBy === d.me.id || i.requestedBy === d.me.id) && taskAssignees(i).some((u) => u !== d.me.id);
  const [reviewFilter, setReviewFilter] = useState<'all' | IssueReview>('all');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const inbox = useClient((s) => s.taskInbox);
  // ?issue=<id>: abre el asunto (enlaces de gg, del push o de un asunto personal).
  const [open, setOpen] = useState<string | null>(() => queryParam('issue'));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { client.loadIssues({}).catch((e) => setError(errorText(e))); }, []);
  const visibleConvs = useMemo(() => new Set(d.conversations.map((c) => c.id)), [d]);
  // Los restringidos pueden ser de un chat que no leo (me asignaron una tarea): el servidor ya filtró.
  const list = Object.values(all)
    .filter((i) => !i.conversationId || visibleConvs.has(i.conversationId) || isRestricted(i))
    .filter((i) => scope === 'all' || (scope === 'byMe' ? byMe(i) : assignedTo(i, d.me.id)))
    .filter((i) => stateFilter === 'all' || (stateFilter === 'closed' ? isClosed(i) : !isClosed(i)))
    .filter((i) => reviewFilter === 'all' || i.review === reviewFilter)
    .filter((i) => groupFilter === 'all' || (i.parentIssueId && all[i.parentIssueId] ? all[i.parentIssueId]!.conversationId : i.conversationId) === groupFilter)
    .filter((i) => !query.trim() || `${i.title} ${Object.entries(i.fields ?? {}).map(([k, v]) => `${k} ${fieldText(v)}`).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort(stateFilter === 'closed' ? (a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '') : byUrgency);
  // Por grupo: la conversación con su espacio. Por persona: el responsable, yo primero y «Sin responsable» al final.
  const NONE = '__none';
  const buckets = new Map<string, IssueDTO[]>();
  // Por grupo, las tareas van debajo de su asunto (en la sección del asunto); por responsable, sueltas.
  const shown = groupBy === 'group' ? tops(list, all) : list;
  const PERSONAL = '__personal';
  const convOf = (i: IssueDTO) => (i.parentIssueId && all[i.parentIssueId] ? all[i.parentIssueId]!.conversationId ?? PERSONAL : i.conversationId ?? PERSONAL);
  for (const i of shown) { const keys = groupBy === 'person' ? taskAssignees(i).length ? taskAssignees(i) : [NONE] : [convOf(i)]; for (const k of keys) buckets.set(k, [...(buckets.get(k) ?? []), i]); }
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
  const eligible = Object.values(all).filter((i) => !i.conversationId || visibleConvs.has(i.conversationId) || isRestricted(i));
  // Grupos y chats que tienen tareas (para ver solo los tickets de un grupo).
  const convTitle = (k: string) => {
    const c = d.conversations.find((x) => x.id === k);
    const ws = c?.workspaceId ? d.workspaces.find((w) => w.id === c.workspaceId) : null;
    return c ? [ws?.name, conversationTitle(d, c)].filter(Boolean).join(' · ') : t('task.sharedWithMe');
  };
  const groupCounts = new Map<string, number>();
  for (const i of eligible) { const k = i.parentIssueId && all[i.parentIssueId] ? all[i.parentIssueId]!.conversationId : i.conversationId; if (k) groupCounts.set(k, (groupCounts.get(k) ?? 0) + 1); }
  const groupOptions = [...groupCounts.entries()].map(([k, n]) => [k, convTitle(k), n] as [string, string, number]).sort((a, b) => a[1].localeCompare(b[1]));
  const fresh = inbox.map((x) => ({ x, i: all[x.issueId] })).filter((r): r is { x: typeof r.x; i: IssueDTO } => !!r.i);
  const move = async (taskId: string, status: IssueStatus) => {
    if (!all[taskId] || pendingMoves.has(taskId) || all[taskId]!.status === status) return;
    setPendingMoves((ids) => new Set([...ids, taskId])); setError(null);
    try { await client.updateIssue(taskId, { status }); }
    catch (err) { setError(errorText(err)); }
    finally { setPendingMoves((ids) => { const next = new Set(ids); next.delete(taskId); return next; }); }
  };
  return (
    <>
      <div className="row issue-toolbar">
        <div className="seg" role="radiogroup" aria-label={taskText('Responsables', 'Assignees')}>
          <button role="radio" aria-checked={scope === 'mine'} className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>{taskText('Mis tareas', 'My tasks')} <span className="muted">{eligible.filter((i) => assignedTo(i, d.me.id)).length}</span></button>
          <button role="radio" aria-checked={scope === 'byMe'} className={scope === 'byMe' ? 'on' : ''} title={taskText('Las que creé o pedí, asignadas a otras personas', 'Tasks I created or requested')} onClick={() => setScope('byMe')}>{taskText('Asignadas por mí', 'Assigned by me')} <span className="muted">{eligible.filter(byMe).length}</span></button>
          <button role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>{taskText('Todas', 'All')} <span className="muted">{eligible.length}</span></button>
        </div>
        <select className="input" aria-label={taskText('Estado', 'Status')} value={stateFilter} onChange={(e) => setStateFilter(e.target.value as typeof stateFilter)}>
          <option value="all">{taskText('Todos los estados', 'All statuses')}</option><option value="open">{t('issue.allOpen')}</option><option value="closed">{t('issue.closed')}</option>
        </select>
        <select className="input" aria-label={taskText('Revisión', 'Review')} value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value as typeof reviewFilter)}>
          <option value="all">{taskText('Toda revisión', 'Any review')}</option>
          {REVIEWS.map((r) => <option key={r} value={r}>{reviewLabel(r)} · {eligible.filter((i) => i.review === r).length}</option>)}
        </select>
        <select className="input" aria-label={taskText('Grupo', 'Group')} value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
          <option value="all">{taskText('Todos los grupos y chats', 'All groups and chats')}</option>
          {groupOptions.map(([k, label, n]) => <option key={k} value={k}>{label} · {n}</option>)}
        </select>
        <input className="input" type="search" aria-label={taskText('Buscar tareas', 'Search tasks')} placeholder={taskText('Buscar tareas', 'Search tasks')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="seg" role="radiogroup" aria-label={t('issue.groupBy')}>
          {(['group', 'person'] as const).map((g) => <button key={g} role="radio" aria-checked={groupBy === g} className={groupBy === g ? 'on' : ''} onClick={() => { void updateIssuePreferences({ grouping: g === 'person' ? 'assignee' : 'group' }).catch(() => {}); }}>{g === 'group' ? t('issue.byGroup') : t('issue.byPerson')}</button>)}
        </div>
        <div className="seg" role="radiogroup" aria-label={taskText('Vista de tareas', 'Task view')}>{(['list', 'cards', 'board'] as const).map((v) => <button key={v} role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => { setTable(false); void updateIssuePreferences({ view: v }).catch(() => {}); }}>{v === 'list' ? taskText('Lista', 'List') : v === 'cards' ? taskText('Tarjetas', 'Cards') : taskText('Tablero', 'Board')}</button>)}<button role="radio" aria-checked={view === 'table'} className={view === 'table' ? 'on' : ''} title={taskText('Una columna por cada campo de las tareas', 'One column per task field')} onClick={() => setTable(true)}>{taskText('Tabla', 'Table')}</button></div>
        {view === 'table' && d.conversations.some((c) => c.canManage && c.kind !== 'direct') && <button className="btn small" onClick={() => openDialog((close) => <TaskColumnsDialog onClose={close} />)}>⚙ {taskText('Columnas', 'Columns')}</button>}
        <TaskReportButton />
      </div>
      {fresh.length > 0 && (
        <section className="task-inbox" aria-label={taskText('Nuevas', 'New')}>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="eyebrow grow">🔔 {taskText('Nuevas', 'New')} · {fresh.length}</span>
            <button className="btn ghost small" onClick={() => void client.markTaskInboxSeen()}>{taskText('Marcar todas como vistas', 'Mark all as seen')}</button>
          </div>
          <div className="list" style={{ gap: 6 }}>{fresh.map(({ x, i }) => (
            <div key={x.issueId} className="task-inbox-item">
              <span className="small muted">{inboxReasonLabel(x.reason)}{x.actorId ? ` · ${personById(d, x.actorId)?.name ?? t('common.participant')}` : ''}</span>
              <IssueRow i={i} showWhere onOpen={setOpen} />
            </div>
          ))}</div>
        </section>
      )}
      {stateFilter !== 'closed' && <QuickAddIssue />}
      {error && <div className="error">{error}</div>}
      {list.length === 0 && <div className="empty">{t('issue.empty')}</div>}
      {view === 'board' && <div className="task-board">{ISSUE_STATUSES.map((status) => <section key={status} className="task-board-column" aria-busy={pendingMoves.size > 0} onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-chaggu-issue-id')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; } }} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const taskId = e.dataTransfer.getData('application/x-chaggu-issue-id'); void move(taskId, status); }}><h3>{t(`issue.st.${status}`)} · {list.filter((i) => i.status === status).length}</h3>{list.filter((i) => i.status === status).map((i) => <IssueRow key={i.id} i={i} showWhere onOpen={setOpen} />)}</section>)}</div>}
      {view === 'table' && list.length > 0 && <IssueTable list={list} onOpen={setOpen} />}
      {view !== 'board' && view !== 'table' && sections.map(([k, items]) => (
        <section key={k} style={{ marginBottom: 18 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>{sectionTitle(k)} · {items.length}</div>
          <div className={view === 'cards' ? 'task-cards' : 'list'} style={{ gap: 6 }}>{items.map((i) => groupBy === 'group'
            ? <IssueWithTasks key={i.id} i={i} allowedIds={new Set(list.map((task) => task.id))} showWhere={false} onOpen={setOpen} />
            : <IssueRow key={i.id} i={i} showWhere showOwner={false} onOpen={setOpen} />)}</div>
        </section>
      ))}
      {open && <IssueDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function IssuesScreen() {
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 900 }}>
      <div className="row page-head"><h1 className="grow">{t('nav.issues')}</h1><PinToGrid payload={{ kind: 'section', section: 'tasks' }} name={t('nav.issues')} /><QuickActions /></div>
      <IssuesBody />
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
  const [assigneeIds, setAssigneeIds] = useState<string[]>([d.me.id]);
  const ownerId = assigneeIds[0] ?? d.me.id;
  const toggleAssignee = (uid: string) => setAssigneeIds((ids) => ids.includes(uid) ? ids.filter((x) => x !== uid) : [...ids, uid]);
  const [vis, setVis] = useState<IssueVisibility>(() => (inSide ? 'all' : defaultVisibility(d, parent.conversationId)));
  const [busy, setBusy] = useState(false);
  const [pickOther, setPickOther] = useState(false);
  const outsider = assigneeIds.some((uid) => !members.some((p) => p.id === uid));
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
      await client.createChildIssue(parent.id, { title: text, assigneeIds, visibility: effective, ...(inSide ? { conversationId: where } : {}) });
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
              <button type="button" key={p.id} className={`chip-person ${assigneeIds.includes(p.id) ? 'on' : ''}`} aria-pressed={assigneeIds.includes(p.id)} onClick={() => toggleAssignee(p.id)}>
                <Avatar person={p} org={orgById(d, p.orgId)} size={20} /> {p.id === d.me.id ? t('issue.me') : p.name.split(' ')[0]}
              </button>
            ))}
            {assigneeIds.filter((uid) => !members.some((p) => p.id === uid)).map((uid) => <button key={uid} type="button" className="chip-person on" onClick={() => toggleAssignee(uid)}>{personById(d, uid)?.name ?? t('common.participant')} ×</button>)}
            {contacts.length > 0 && (pickOther
              ? <select className="input" autoFocus style={{ maxWidth: 220 }} value="" onChange={(e) => { if (e.target.value) { toggleAssignee(e.target.value); setPickOther(false); } }}>
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

/**
 * Tarjeta de la tarea dentro del chat (reemplaza el aviso «Abrió la tarea…»): se ve completa, se marca hecha,
 * muestra los últimos comentarios y se comenta ahí mismo sin abrirla.
 */
export function IssueChatCard({ issueId, creatorId, canPost, onOpen, banner, tone, footer, hideReply }: {
  issueId: string; creatorId: string; canPost: boolean; onOpen: (id: string) => void;
  /** Tanda 1.7: franja de arriba («✅ Ana completó la tarea», «No cumplimos…», «💬 3 comentarios nuevos»). */
  banner?: React.ReactNode; tone?: 'done' | 'overdue' | 'comments'; footer?: React.ReactNode; hideReply?: boolean;
}) {
  const d = useClient((s) => s.data)!;
  const i = useClient((s) => s.issues[issueId]);
  const [comments, setComments] = useState<IssueEventDTO[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  // Detalle solo si hace falta: la tarea no está en memoria o tiene comentarios que mostrar.
  useEffect(() => {
    if (i && !i.commentCount) { setComments([]); return; }
    let live = true;
    client.issueDetail(issueId)
      .then((r) => { if (live) setComments(r.events.filter((e) => e.kind === 'comment').slice(-2)); })
      .catch(() => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [issueId, i?.commentCount ?? -1]);
  if (!i) return missing ? null : <div className="card task-card is-loading" aria-busy>…</div>;
  const owner = personById(d, i.ownerId);
  const creator = personById(d, creatorId);
  const f = issueFlags(i);
  const done = isClosed(i);
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try { await client.commentIssue(i.id, body); setText(''); } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className={`card task-card ${done ? 'is-done' : ''} ${f.overdue ? 'is-overdue' : ''} ${tone ? `tone-${tone}` : ''}`} {...menuProps(() => issueQuickMenu(i))}>
      {banner && <div className={`task-card-banner ${tone ? `is-${tone}` : ''}`}>{banner}</div>}
      <div className="task-card-top">
        <span className="task-card-kind">☑ {t('task.card', { name: creator?.name.split(' ')[0] ?? '' })}</span>
        <IssueTopicTag issueId={i.id} conversationId={i.conversationId} topicId={i.topicId} canEdit={canPost} />
      </div>
      <div className="task-card-main">
        <IssueCheck i={i} size={22} />
        <button className="task-card-title" onClick={() => onOpen(i.id)}>{i.title}</button>
      </div>
      <div className="task-card-meta">
        <span className="task-card-owner"><Avatar person={owner} org={orgById(d, owner?.orgId)} size={20} />{owner?.name ?? t('issue.noOwner')}</span>
        <span className={f.overdue ? 'error' : ''}>📅 {f.overdue ? t('issue.overdue') : f.dueToday ? t('issue.today') : dueLabel(i)}</span>
        <StatusPill status={i.status} />
        {i.commentCount > 0 && <span>💬 {i.commentCount}</span>}
      </div>
      {comments.length > 0 && (
        <div className="task-card-comments">
          {comments.map((c) => (
            <div key={c.id} className="task-card-comment">
              <b>{c.actorId === d.me.id ? t('common.youShort') : personById(d, c.actorId)?.name.split(' ')[0]}</b> {String((c.payload as any)?.body ?? '')}
            </div>
          ))}
          {i.commentCount > comments.length && <button className="link-btn small" onClick={() => onOpen(i.id)}>{t('task.cardAll', { n: i.commentCount })}</button>}
        </div>
      )}
      {footer}
      {canPost && !done && !hideReply && (
        <div className="task-card-reply">
          <input className="input" value={text} placeholder={t('task.cardComment')} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          <button className="btn small" disabled={!text.trim() || busy} onClick={() => void send()}>{t('issue.comment')}</button>
        </div>
      )}
    </div>
  );
}
