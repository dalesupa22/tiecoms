import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BootstrapDTO, IssueDTO, IssueEventDTO, IssueStatus } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { navigate } from '../router.ts';
import { Avatar, Modal, conversationTitle, orgById, personById } from '../ui.tsx';

export const ISSUE_STATUSES: IssueStatus[] = ['open', 'in_progress', 'waiting', 'done', 'cancelled'];
const CLOSED = new Set<IssueStatus>(['done', 'cancelled']);
const STALL_DAYS = 2;

export const isClosed = (i: IssueDTO) => CLOSED.has(i.status);
const daysSince = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
const todayIso = () => new Date().toISOString().slice(0, 10);

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

export function IssueRow({ i, showWhere = true, onOpen }: { i: IssueDTO; showWhere?: boolean; onOpen: (id: string) => void }) {
  const d = useClient((s) => s.data)!;
  const owner = personById(d, i.ownerId);
  const conv = d.conversations.find((c) => c.id === i.conversationId);
  const f = issueFlags(i);
  return (
    <button className={`card issue-row ${f.stalledDays || f.overdue ? 'is-jam' : ''}`} onClick={() => onOpen(i.id)}>
      <Avatar person={owner} org={orgById(d, owner?.orgId)} size={30} />
      <span className="grow" style={{ minWidth: 0 }}>
        <b className="ellipsis" style={{ display: 'block' }}>{i.title}</b>
        <span className="small muted ellipsis" style={{ display: 'block' }}>
          {[owner?.name ?? t('common.none'), showWhere && conv ? t('issue.in', { name: conversationTitle(d, conv) }) : null].filter(Boolean).join(' · ')}
        </span>
      </span>
      {f.stalledDays > 0 && <span className="jam-badge" title={t('issue.bottleneck')}>⏱ {f.stalledDays === 1 ? t('issue.stalledOne') : t('issue.stalled', { n: f.stalledDays })}</span>}
      <span className={`small ${f.overdue ? 'error' : 'muted'}`} style={{ whiteSpace: 'nowrap' }}>{f.overdue ? t('issue.overdue') : f.dueToday ? t('issue.today') : dueLabel(i)}</span>
      <StatusPill status={i.status} />
    </button>
  );
}

export function NewIssueDialog({ conversationId, originMessageId, defaultTitle = '', onClose, onCreated }: {
  conversationId: string; originMessageId?: string; defaultTitle?: string; onClose: () => void; onCreated?: (i: IssueDTO) => void;
}) {
  const d = useClient((s) => s.data)!;
  const members = membersOf(d, conversationId);
  const [title, setTitle] = useState(defaultTitle);
  const [ownerId, setOwnerId] = useState(d.me.id);
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const i = await client.createIssue(conversationId, { title, ownerId, dueDate: due || null, originMessageId: originMessageId ?? null });
      onCreated?.(i);
      onClose();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('issue.newTitle')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field"><span>{t('issue.title')}</span><input className="input" required minLength={2} maxLength={200} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="field grow"><span>{t('issue.owner')}</span>
            <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              {members.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === d.me.id ? ` ${t('common.you')}` : ''} · {orgById(d, p.orgId)?.name ?? t('common.guest')}</option>)}
            </select>
          </label>
          <label className="field"><span>{t('issue.due')}</span><input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy}>{t('issue.create')}</button></div>
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
  const [error, setError] = useState<string | null>(null);
  const load = () => client.issueDetail(id).then((r) => setEvents(r.events)).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); }, [id, live?.updatedAt]);
  if (!live) return <Modal title={t('nav.issues')} onClose={onClose}><div className="muted">{error ?? t('common.loading')}</div></Modal>;
  const i = live;
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

  return (
    <Modal title={i.title} onClose={onClose}>
      <div className="small muted">{conv ? conversationTitle(d, conv) : ''} · {requester ? t('issue.requestedBy', { name: requester.name }) : t('issue.manual')}</div>
      {(f.stalledDays > 0 || f.overdue) && (
        <div className="jam-alert">⏱ <b>{t('issue.bottleneck')}</b> · {[f.overdue ? t('issue.overdue') : null, f.stalledDays ? (f.stalledDays === 1 ? t('issue.stalledOne') : t('issue.stalled', { n: f.stalledDays })) : null].filter(Boolean).join(' · ')}</div>
      )}
      <div className="seg issue-seg" role="radiogroup" aria-label={t('issue.status')}>
        {ISSUE_STATUSES.map((st) => (
          <button key={st} role="radio" aria-checked={i.status === st} className={i.status === st ? 'on' : ''} onClick={() => update({ status: st })}>{t(`issue.st.${st}`)}</button>
        ))}
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <label className="field grow"><span>{t('issue.owner')}</span>
          <select className="input" value={i.ownerId ?? ''} onChange={(e) => update({ ownerId: e.target.value || null })}>
            <option value="">{t('common.none')}</option>
            {members.map((p) => <option key={p.id} value={p.id}>{p.name} · {orgById(d, p.orgId)?.name ?? t('common.guest')}</option>)}
          </select>
        </label>
        <label className="field"><span>{t('issue.due')}</span><input className="input" type="date" value={i.dueDate ?? ''} onChange={(e) => update({ dueDate: e.target.value || null })} /></label>
      </div>
      {i.status === 'waiting' && (
        <label className="field"><span>{t('issue.waitingOn')}</span>
          <select className="input" value={i.waitingOnOrgId ?? ''} onChange={(e) => update({ waitingOnOrgId: e.target.value || null })}>
            <option value="">{t('issue.waitingOnPh')}</option>
            {orgIds.map((o) => <option key={o} value={o}>{orgById(d, o)?.name}</option>)}
          </select>
        </label>
      )}
      {i.originMessageId && (
        canSeeOrigin
          ? <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => { onClose(); navigate(`/c/${i.conversationId}?m=${i.originMessageSeq}`); }}>↗ {t('issue.origin')}</button>
          : <div className="hint">{t('issue.originOut')}</div>
      )}
      <div className="eyebrow">{t('issue.history')}</div>
      <div className="issue-timeline">
        {events.map((e) => {
          const who = personById(d, e.actorId);
          return (
            <div key={e.id} className={`issue-ev ${e.kind === 'comment' ? 'is-comment' : ''}`}>
              <Avatar person={who} org={orgById(d, who?.orgId)} size={24} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="small"><b>{who?.name ?? t('common.participant')}</b> {e.kind === 'comment' ? '' : eventText(d, e)} <span className="muted">· {new Date(e.createdAt).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>
                {e.kind === 'comment' && <div className="issue-comment">{String((e.payload as any).body)}</div>}
              </div>
            </div>
          );
        })}
      </div>
      <form onSubmit={send} className="linkbox">
        <input className="input" placeholder={t('issue.commentPh')} value={comment} onChange={(e) => setComment(e.target.value)} />
        <button className="btn primary" disabled={!comment.trim()}>{t('issue.comment')}</button>
      </form>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}

export function IssuesScreen() {
  const d = useClient((s) => s.data)!;
  const all = useClient((s) => s.issues);
  const [filter, setFilter] = useState<'mine' | 'open' | 'closed'>('mine');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { client.loadIssues({}).catch((e) => setError(errorText(e))); }, []);
  const visibleConvs = useMemo(() => new Set(d.conversations.map((c) => c.id)), [d]);
  const list = Object.values(all)
    .filter((i) => visibleConvs.has(i.conversationId))
    .filter((i) => (filter === 'closed' ? isClosed(i) : !isClosed(i) && (filter === 'open' || i.ownerId === d.me.id)))
    .sort((a, b) => (issueFlags(b).stalledDays - issueFlags(a).stalledDays) || (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'));
  // Primero los espacios; los de directos y chats grupales van al final en «Chats».
  const byWs = new Map<string, IssueDTO[]>();
  const CHATS = '__chats';
  for (const i of list) { const k = i.workspaceId ?? CHATS; byWs.set(k, [...(byWs.get(k) ?? []), i]); }
  const sections = [...byWs.entries()].sort(([a], [b]) => (a === CHATS ? 1 : 0) - (b === CHATS ? 1 : 0));
  const label = { mine: t('issue.mine'), open: t('issue.allOpen'), closed: t('issue.closed') };
  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 900 }}>
      <h1>{t('nav.issues')}</h1>
      <div className="muted" style={{ maxWidth: 680 }}>{t('issue.pageSub')}</div>
      <div className="seg" style={{ margin: '16px 0', maxWidth: 420 }}>
        {(['mine', 'open', 'closed'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{label[f]}</button>)}
      </div>
      {error && <div className="error">{error}</div>}
      {list.length === 0 && <div className="empty">{t('issue.empty')}</div>}
      {sections.map(([wsId, items]) => (
        <section key={wsId} style={{ marginBottom: 18 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>{wsId === CHATS ? t('issue.chatsSection') : d.workspaces.find((w) => w.id === wsId)?.name}</div>
          <div className="list">{items.map((i) => <IssueRow key={i.id} i={i} onOpen={setOpen} />)}</div>
        </section>
      ))}
      {open && <IssueDrawer id={open} onClose={() => setOpen(null)} />}
    </div></div>
  );
}
