import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BootstrapDTO, IssueDTO, IssueEventDTO, IssueStatus } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { navigate } from '../router.ts';
import { Avatar, Modal, conversationTitle, orgById, personById } from '../ui.tsx';
import { menuProps, toast, type MenuItem } from '../menu.tsx';
import { destinationLabel, issueDestinations } from '../quick-search.ts';
import { QuickActions } from './Quick.tsx';

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

function membersOf(d: BootstrapDTO, conversationId: string) {
  const c = d.conversations.find((x) => x.id === conversationId);
  return (c?.memberIds ?? []).map((id) => personById(d, id)).filter((p): p is NonNullable<typeof p> => !!p && p.kind === 'human');
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
    { label: t('issue.open'), icon: '◆', onSelect: () => navigate(`/c/${i.conversationId}?issue=${i.id}`) },
  ];
  return [
    { label: t('issue.complete'), icon: '✓', onSelect: () => void toggleDone(i) },
    ...(i.status !== 'in_progress' ? [{ label: t('issue.markInProgress'), icon: '▶', onSelect: () => void set('in_progress') }] : []),
    ...(i.status !== 'waiting' ? [{ label: t('issue.markWaiting'), icon: '⏸', onSelect: () => void set('waiting') }] : []),
    ...(i.status !== 'open' ? [{ label: t('issue.markOpen'), icon: '○', onSelect: () => void set('open') }] : []),
    { divider: true },
    { label: t('issue.open'), icon: '◆', onSelect: () => navigate(`/c/${i.conversationId}?issue=${i.id}`) },
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

export function IssueRow({ i, showWhere = true, showOwner = true, onOpen }: { i: IssueDTO; showWhere?: boolean; showOwner?: boolean; onOpen: (id: string) => void }) {
  const d = useClient((s) => s.data)!;
  const owner = personById(d, i.ownerId);
  const conv = d.conversations.find((c) => c.id === i.conversationId);
  const f = issueFlags(i);
  const done = isClosed(i);
  return (
    <div role="button" tabIndex={0} className={`card issue-row ${f.stalledDays || f.overdue ? 'is-jam' : ''} ${done ? 'is-done' : ''}`}
      onClick={() => onOpen(i.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(i.id); }} {...menuProps(() => issueQuickMenu(i))}>
      <IssueCheck i={i} />
      <span className="grow" style={{ minWidth: 0 }}>
        <b className="ellipsis issue-title" style={{ display: 'block' }}>{i.title}</b>
        {(showOwner || (showWhere && conv) || i.commentCount > 0) && (
          <span className="small muted ellipsis" style={{ display: 'block' }}>
            {[showOwner ? owner?.name ?? t('issue.noOwner') : null, showWhere && conv ? t('issue.in', { name: conversationTitle(d, conv) }) : null, i.commentCount > 0 ? `💬 ${i.commentCount}` : null].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
      {f.stalledDays > 0 && <span className="jam-badge" title={t('issue.bottleneck')}>⏱ {f.stalledDays === 1 ? t('issue.stalledOne') : t('issue.stalled', { n: f.stalledDays })}</span>}
      {i.dueDate && <span className={`small ${f.overdue ? 'error' : 'muted'}`} style={{ whiteSpace: 'nowrap' }}>{f.overdue ? t('issue.overdue') : f.dueToday ? t('issue.today') : dueLabel(i)}</span>}
      {(i.status === 'in_progress' || i.status === 'waiting' || i.status === 'cancelled') && <StatusPill status={i.status} />}
      {showOwner && <Avatar person={owner} org={orgById(d, owner?.orgId)} size={24} />}
    </div>
  );
}

/**
 * Alta rápida: se escribe y Enter. Responsable (yo por defecto) y fecha opcionales al lado;
 * el campo queda listo para el siguiente, como una lista de tareas.
 */
export function QuickAddIssue({ conversationId }: { conversationId?: string }) {
  const d = useClient((s) => s.data)!;
  const destinations = useMemo(() => (conversationId ? [] : issueDestinations(d)), [d, conversationId]);
  const [conv, setConv] = useState(conversationId ?? destinations[0]?.id ?? '');
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
      await client.createIssue(conv, { title: text, ownerId: members.some((p) => p.id === ownerId) ? ownerId : d.me.id, dueDate: due || null });
      setTitle(''); setDue('');
    } catch (err) { toast(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <form className="issue-quick" onSubmit={submit}>
      <span className="issue-check ghost" aria-hidden>＋</span>
      <input className="grow" placeholder={t('issue.quickPh')} onKeyDown={(e) => { if (e.key === 'Escape') setTitle(''); }} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('issue.title')} />
      {typing && !conversationId && (
        <select value={conv} onChange={(e) => { setConv(e.target.value); setOwnerId(d.me.id); }} aria-label={t('issue.where')}>
          {destinations.map((c) => <option key={c.id} value={c.id}>{destinationLabel(d, c, conversationTitle(d, c))}</option>)}
        </select>
      )}
      {typing && (
        <span className="issue-quick-opts">
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label={t('issue.owner')} title={t('issue.owner')}>
            {members.map((p) => <option key={p.id} value={p.id}>{p.id === d.me.id ? t('issue.me') : p.name}</option>)}
          </select>
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
  const mine = Object.values(all).filter((i) => i.conversationId === conversationId);
  const open = mine.filter((i) => !isClosed(i)).sort(byUrgency);
  const done = mine.filter(isClosed).sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  return (
    <div className="issue-list">
      {canCreate && <QuickAddIssue conversationId={conversationId} />}
      {open.length === 0 && <div className="hint">{t('issue.noIssues')}</div>}
      <div className="list" style={{ gap: 6 }}>{open.map((i) => <IssueRow key={i.id} i={i} showWhere={false} onOpen={onOpen} />)}</div>
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
export function NewIssueDialog({ conversationId, originMessageId, defaultTitle = '', onClose, onCreated }: {
  conversationId?: string; originMessageId?: string; defaultTitle?: string; onClose: () => void; onCreated?: (i: IssueDTO) => void;
}) {
  const d = useClient((s) => s.data)!;
  const destinations = useMemo(() => (conversationId ? [] : issueDestinations(d)), [d, conversationId]);
  const [conv, setConv] = useState(conversationId ?? destinations[0]?.id ?? '');
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
      const i = await client.createIssue(conv, { title, ownerId, dueDate: due || null, originMessageId: originMessageId ?? null });
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
              {destinations.map((c) => <option key={c.id} value={c.id}>{destinationLabel(d, c, conversationTitle(d, c))}</option>)}
            </select>
          </label>
        )}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="field grow"><span>{t('issue.owner')}</span>
            <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              {members.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === d.me.id ? ` ${t('common.you')}` : ''} · {orgById(d, p.orgId)?.name ?? t('common.guest')}</option>)}
            </select>
          </label>
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
    default: return '';
  }
}

/** Detalle de un asunto: estado, responsable, fecha, a quién se espera, origen, historial y comentarios. */
export function IssueDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const live = useClient((s) => s.issues[id]);
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
  const members = membersOf(d, i.conversationId);
  const orgIds = [...new Set(members.map((p) => p.orgId).filter(Boolean))] as string[];
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
    <Modal title={conv ? conversationTitle(d, conv) : t('nav.issues')} onClose={onClose}>
      <label className="issue-title-wrap">
        <input key={i.title} className={`issue-title-edit ${done ? 'is-done' : ''}`} defaultValue={i.title} maxLength={200} aria-label={t('issue.title')}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = i.title; e.currentTarget.blur(); } }}
          onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v.length >= 2 && v !== i.title) void update({ title: v }); else e.currentTarget.value = i.title; }} />
        <span className="issue-title-pen" aria-hidden>✎</span>
      </label>
      <div className="small muted">{requester ? t('issue.requestedBy', { name: requester.name }) : t('issue.manual')}</div>

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

      <div className="issue-q">
        <div className="issue-q-label">{t('issue.qWho')}</div>
        <div className="chips">
          {members.map((p) => (
            <button key={p.id} className={`chip-person ${i.ownerId === p.id ? 'on' : ''}`} aria-pressed={i.ownerId === p.id} onClick={() => update({ ownerId: p.id })}>
              <Avatar person={p} org={orgById(d, p.orgId)} size={22} /> {p.id === d.me.id ? t('issue.me') : p.name.split(' ')[0]}
            </button>
          ))}
          {i.ownerId && <button className="chip-person ghost" onClick={() => update({ ownerId: null })}>{t('issue.noOwner')}</button>}
        </div>
      </div>

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
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { client.loadIssues({}).catch((e) => setError(errorText(e))); }, []);
  const remember = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };
  const visibleConvs = useMemo(() => new Set(d.conversations.map((c) => c.id)), [d]);
  const list = Object.values(all)
    .filter((i) => visibleConvs.has(i.conversationId))
    .filter((i) => (filter === 'closed' ? isClosed(i) : !isClosed(i) && (filter === 'open' || i.ownerId === d.me.id)))
    .sort(filter === 'closed' ? (a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '') : byUrgency);
  // Por grupo: la conversación con su espacio. Por persona: el responsable, yo primero y «Sin responsable» al final.
  const NONE = '__none';
  const buckets = new Map<string, IssueDTO[]>();
  for (const i of list) { const k = groupBy === 'person' ? i.ownerId ?? NONE : i.conversationId; buckets.set(k, [...(buckets.get(k) ?? []), i]); }
  const sectionTitle = (k: string) => {
    if (groupBy === 'person') return k === NONE ? t('issue.noOwner') : `${personById(d, k)?.name ?? t('common.participant')}${k === d.me.id ? ` ${t('common.you')}` : ''}`;
    const c = d.conversations.find((x) => x.id === k);
    const ws = c?.workspaceId ? d.workspaces.find((w) => w.id === c.workspaceId) : null;
    return c ? [ws?.name, conversationTitle(d, c)].filter(Boolean).join(' · ') : '';
  };
  const sections = [...buckets.entries()].sort(([a, ai], [b, bi]) => groupBy === 'person'
    ? (Number(b === d.me.id) - Number(a === d.me.id)) || (Number(a === NONE) - Number(b === NONE)) || sectionTitle(a).localeCompare(sectionTitle(b))
    : bi.length - ai.length || sectionTitle(a).localeCompare(sectionTitle(b)));
  const label = { mine: t('issue.mine'), open: t('issue.allOpen'), closed: t('issue.closed') };
  const count = (f: 'mine' | 'open' | 'closed') => Object.values(all).filter((i) => visibleConvs.has(i.conversationId) && (f === 'closed' ? isClosed(i) : !isClosed(i) && (f === 'open' || i.ownerId === d.me.id))).length;
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 900 }}>
      <div className="row page-head"><h1 className="grow">{t('nav.issues')}</h1><QuickActions /></div>
      <div className="muted" style={{ maxWidth: 680 }}>{t('issue.pageSub')}</div>
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
          <div className="list" style={{ gap: 6 }}>{items.map((i) => <IssueRow key={i.id} i={i} showWhere={groupBy === 'person'} showOwner={groupBy === 'group'} onOpen={setOpen} />)}</div>
        </section>
      ))}
      {open && <IssueDrawer id={open} onClose={() => setOpen(null)} />}
    </div></div>
  );
}
