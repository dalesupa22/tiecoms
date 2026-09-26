import { useEffect, useState } from 'react';
import type { BootstrapDTO, ConversationDTO, IssueDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { locale, t } from '../i18n.ts';
import { Avatar, Modal, conversationTitle, personById, timeLabel } from '../ui.tsx';
import { EventRow, newEvent } from './Calendar.tsx';
import { IssueRow, isClosed } from './Issues.tsx';

/**
 * Barra de accesos del chat (mismas reglas en web, iOS y Android: docs/GRUPOS.md): Fijados, Asuntos, Hilos y
 * Agenda, siempre en el mismo lugar y con su cuenta. Cada uno abre su lista sin mover el chat.
 */
export type ChatBarPane = 'issues' | 'threads' | 'agenda';

/** Hilos de la conversación: los abiertos a los del chat (derivadas) y mis sidechats privados. */
export function threadsOf(d: BootstrapDTO, conversationId: string, messageId?: string) {
  return d.conversations
    .filter((c) => c.parentId === conversationId && (!messageId || c.parentMessageId === messageId))
    .sort((a, b) => Number(!!a.returnedAt) - Number(!!b.returnedAt) || (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
}
export const isPrivateThread = (c: ConversationDTO) => c.deriveKind === 'side';

/** Agenda del chat: reuniones, fechas límite de sus asuntos y mis recordatorios, por fecha. */
interface AgendaItem { key: string; at: string; kind: 'event' | 'due' | 'reminder'; id: string }

function useAgenda(conv: ConversationDTO, issues: IssueDTO[]) {
  const events = useClient((s) => s.events);
  const reminders = useClient((s) => s.reminders);
  useEffect(() => { client.loadEvents(new Date(Date.now() - 3600_000), new Date(Date.now() + 90 * 86400_000), conv.id).catch(() => {}); }, [conv.id]);
  const items: AgendaItem[] = [];
  for (const e of Object.values(events)) {
    if (e.conversationId !== conv.id || e.cancelledAt || Date.parse(e.endsAt) < Date.now()) continue;
    items.push({ key: `e:${e.id}`, at: e.startsAt, kind: 'event', id: e.id });
  }
  for (const i of issues) if (i.dueDate) items.push({ key: `i:${i.id}`, at: `${i.dueDate}T23:59:00`, kind: 'due', id: i.id });
  for (const r of reminders) {
    if (r.conversationId !== conv.id || r.doneAt) continue;
    items.push({ key: `r:${r.id}`, at: r.remindAt, kind: 'reminder', id: r.id });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

export function ChatBar({ conv, pinnedCount, canOpenIssues, onPins, onOpenIssue, onNewIssue, onOpenThread }: {
  conv: ConversationDTO; pinnedCount: number; canOpenIssues: boolean;
  onPins: () => void; onOpenIssue: (id: string) => void; onNewIssue: () => void; onOpenThread: (id: string) => void;
}) {
  const d = useClient((s) => s.data)!;
  const allIssues = useClient((s) => s.issues);
  const reminders = useClient((s) => s.reminders);
  const events = useClient((s) => s.events);
  const [pane, setPane] = useState<ChatBarPane | null>(null);
  const issues = Object.values(allIssues).filter((i) => i.conversationId === conv.id && !isClosed(i))
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
  const threads = threadsOf(d, conv.id);
  const agenda = useAgenda(conv, issues);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = issues.some((i) => i.dueDate && i.dueDate < today);
  const soon = agenda.some((a) => a.kind === 'event' && new Date(a.at).toDateString() === new Date().toDateString());
  const openThreads = threads.filter((c) => !c.returnedAt);
  const threadUnread = threads.reduce((n, c) => n + c.unread, 0);

  const btn = (key: string, icon: string, label: string, n: number, onClick: () => void, alert = false) => (
    <button key={key} className={`chatbar-btn ${n ? '' : 'is-zero'} ${alert ? 'is-alert' : ''}`} onClick={onClick} aria-label={`${label}: ${n}`}>
      <span aria-hidden>{icon}</span><b>{n}</b><span className="chatbar-label">{label}</span>
    </button>
  );
  return (
    <>
      <div className="chatbar" role="toolbar" aria-label={t('bar.label')}>
        {btn('pins', '📌', t('bar.pins'), pinnedCount, onPins)}
        {btn('issues', '◆', t('bar.issues'), issues.length, () => setPane('issues'), overdue)}
        {btn('threads', '💬', t('bar.threads'), openThreads.length, () => setPane('threads'), threadUnread > 0)}
        {btn('agenda', '📅', t('bar.agenda'), agenda.length, () => setPane('agenda'), soon)}
      </div>
      {pane === 'issues' && (
        <Modal title={t('bar.issuesTitle')} onClose={() => setPane(null)}>
          {!issues.length && <div className="hint">{t('issue.noIssues')}</div>}
          <div className="list" style={{ gap: 6 }}>{issues.map((i) => <IssueRow key={i.id} i={i} showWhere={false} onOpen={(id) => { setPane(null); onOpenIssue(id); }} />)}</div>
          <div className="modal-actions">{canOpenIssues && <button className="btn primary" onClick={() => { setPane(null); onNewIssue(); }}>＋ {t('bar.newIssue')}</button>}</div>
        </Modal>
      )}
      {pane === 'threads' && (
        <Modal title={t('bar.threadsTitle')} onClose={() => setPane(null)}>
          {!threads.length && <div className="hint">{t('bar.noThreads')}</div>}
          <div className="list" style={{ gap: 6 }}>
            {threads.map((c) => <ThreadRow key={c.id} d={d} c={c} onOpen={() => { setPane(null); onOpenThread(c.id); }} />)}
          </div>
        </Modal>
      )}
      {pane === 'agenda' && (
        <Modal title={t('bar.agendaTitle')} onClose={() => setPane(null)}>
          {!agenda.length && <div className="hint">{t('bar.noAgenda')}</div>}
          <div className="list" style={{ gap: 6 }}>
            {agenda.map((a) => {
              if (a.kind === 'event') return events[a.id] ? <EventRow key={a.key} ev={events[a.id]!} showConv={false} /> : null;
              if (a.kind === 'due') {
                const i = issues.find((x) => x.id === a.id);
                if (!i) return null;
                return (
                  <button key={a.key} className="card conv-card agenda-row" onClick={() => { setPane(null); onOpenIssue(i.id); }}>
                    <span aria-hidden>◆</span>
                    <span className="grow"><b>{i.title}</b><span className="small muted" style={{ display: 'block' }}>{t('bar.dueOn', { date: fmtDay(i.dueDate!) })}</span></span>
                    {i.dueDate! < today && <span className="tag overdue">{t('bar.overdue')}</span>}
                  </button>
                );
              }
              const r = reminders.find((x) => x.id === a.id);
              if (!r) return null;
              return (
                <div key={a.key} className="card conv-card agenda-row">
                  <span aria-hidden>⏰</span>
                  <span className="grow"><b>{r.note || t('bar.reminder')}</b><span className="small muted" style={{ display: 'block' }}>{t('bar.onlyYou')} · {new Date(r.remindAt).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></span>
                </div>
              );
            })}
          </div>
          <div className="modal-actions">
            {canOpenIssues && <button className="btn" onClick={() => { setPane(null); onNewIssue(); }}>＋ {t('bar.newIssue')}</button>}
            {conv.canPost && <button className="btn primary" onClick={() => { setPane(null); newEvent({ conversationId: conv.id }); }}>＋ {t('bar.newEvent')}</button>}
          </div>
        </Modal>
      )}
    </>
  );
}

const fmtDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' });

function ThreadRow({ d, c, onOpen }: { d: BootstrapDTO; c: ConversationDTO; onOpen: () => void }) {
  const priv = isPrivateThread(c);
  const n = Math.max(0, c.lastMessageSeq - 1);
  return (
    <button className={`card conv-card thread-row ${c.unread ? 'unread' : ''}`} onClick={onOpen}>
      <span aria-hidden>{priv ? '🔒' : '💬'}</span>
      <span className="grow" style={{ minWidth: 0 }}>
        <b className="ellipsis" style={{ display: 'block' }}>{threadTitle(d, c)}</b>
        <span className="small muted">{[priv ? t('bar.private') : t('bar.public'), t('bar.peopleN', { n: c.memberIds.length }), n ? (n === 1 ? t('bar.replyOne') : t('bar.repliesN', { n })) : null, c.lastMessageAt ? timeLabel(c.lastMessageAt) : null].filter(Boolean).join(' · ')}</span>
      </span>
      {c.unread > 0 && <span className="pill">{c.unread}</span>}
      <span className={`tag ${c.returnedAt ? 'is-done' : ''}`}>{c.returnedAt ? `✓ ${t('bar.solved')}` : t('bar.open')}</span>
    </button>
  );
}

/** El título sin el prefijo que ya dice el ícono. */
export const threadTitle = (d: BootstrapDTO, c: ConversationDTO) => conversationTitle(d, c).replace(/^(Sidechat|Consulta|Hilo|Thread|Interno|Internal|Derivada|Branch|Diagnóstico|Diagnosis|Decisión|Decision)\s*·\s*/i, '');

/** Bajo el mensaje, como en Slack: «💬 3 respuestas · Laura: ya va». Abre el hilo al lado. Los privados usan SideChip. */
export function ThreadChip({ d, threads, onOpen }: { d: BootstrapDTO; threads: ConversationDTO[]; onOpen: (id: string) => void }) {
  if (!threads.length) return null;
  return (
    <div className="thread-chips">
      {threads.map((c) => {
        const n = Math.max(0, c.lastMessageSeq - 1);
        const last = c.lastHumanPreview;
        const who = last ? (last.authorId === d.me.id ? t('common.youShort') : personById(d, last.authorId)?.name.split(' ')[0]) : null;
        const people = c.memberIds.filter((m) => m !== d.me.id).slice(0, 3);
        return (
          <button key={c.id} className={`side-thread is-public ${c.unread ? 'unread' : ''} ${c.returnedAt ? 'is-returned' : ''}`} onClick={() => onOpen(c.id)}>
            <span className="stack" style={{ width: 20 + Math.max(0, people.length - 1) * 11, height: 20 }}>
              {people.map((m, i) => <span key={m} style={{ left: i * 11, zIndex: 3 - i }}><Avatar person={personById(d, m)} org={null} size={20} /></span>)}
            </span>
            <span className="side-thread-text">
              <b>💬 {c.returnedAt ? `✓ ${threadTitle(d, c)}` : n ? (n === 1 ? t('bar.replyOne') : t('bar.repliesN', { n })) : threadTitle(d, c)}</b>
              {last && <span className="side-thread-last">{who ? `${who}: ` : ''}{last.body}</span>}
            </span>
            {c.unread > 0 && <span className="side-dot" />}
          </button>
        );
      })}
    </div>
  );
}
