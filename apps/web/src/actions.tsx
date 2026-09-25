import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { BootstrapDTO, ConversationDTO, MessageDTO, PersonDTO, WorkspaceDTO } from '@tiecoms/contracts';
import { client } from './app-client.ts';
import { errorText, locale, t } from './i18n.ts';
import { copyText, toast, type MenuItem } from './menu.tsx';
import { BASE, navigate } from './router.ts';
import { Modal, conversationTitle, personById } from './ui.tsx';

// ---------- Diálogos globales (se pueden abrir desde cualquier menú) ----------
let dialog: ((close: () => void) => ReactNode) | null = null;
const dl = new Set<() => void>();
export function openDialog(render: (close: () => void) => ReactNode) { dialog = render; dl.forEach((l) => l()); }
const closeDialog = () => { dialog = null; dl.forEach((l) => l()); };
export function DialogHost() {
  const d = useSyncExternalStore((l) => { dl.add(l); return () => dl.delete(l); }, () => dialog);
  return d ? <>{d(closeDialog)}</> : null;
}

// ---------- Tiempos rápidos ----------
function at9(daysAhead: number) { const d = new Date(); d.setDate(d.getDate() + daysAhead); d.setHours(9, 0, 0, 0); return d; }
export function quickTimes(): { key: string; label: string; date: Date }[] {
  const now = Date.now();
  const daysToMonday = ((8 - new Date().getDay()) % 7) || 7;
  return [
    { key: '20m', label: t('when.20m'), date: new Date(now + 20 * 60_000) },
    { key: '1h', label: t('when.1h'), date: new Date(now + 3600_000) },
    { key: '3h', label: t('when.3h'), date: new Date(now + 3 * 3600_000) },
    { key: 'tomorrow', label: t('when.tomorrow'), date: at9(1) },
    { key: 'monday', label: t('when.monday'), date: at9(daysToMonday) },
  ];
}
const whenText = (d: Date) => d.toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export async function remind(conversationId: string, date: Date, messageId?: string | null, note?: string | null) {
  try {
    await client.createReminder({ conversationId, messageId: messageId ?? null, note: note ?? null, remindAt: date.toISOString() });
    toast(t('toast.reminderSet', { when: whenText(date) }));
    askNotifications();
  } catch (e) { toast(errorText(e)); }
}

function ReminderDialog({ conv, message, onClose }: { conv: ConversationDTO; message?: MessageDTO; onClose: () => void }) {
  const d = client.getState().data!;
  const def = new Date(Date.now() + 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const [when, setWhen] = useState(`${def.getFullYear()}-${pad(def.getMonth() + 1)}-${pad(def.getDate())}T${pad(def.getHours())}:${pad(def.getMinutes())}`);
  const [note, setNote] = useState(message ? message.body.slice(0, 120) : '');
  const submit = async (e: FormEvent) => { e.preventDefault(); await remind(conv.id, new Date(when), message?.id, note || null); onClose(); };
  return (
    <Modal title={t('rem.custom')} onClose={onClose}>
      <div className="small muted">{t('rem.about', { name: conversationTitle(d, conv) })}</div>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field"><span>{t('rem.when')}</span><input className="input" type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} /></label>
        <label className="field"><span>{t('rem.note')}</span><input className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary">{t('rem.save')}</button></div>
      </form>
    </Modal>
  );
}

export function remindMenu(conv: ConversationDTO, message?: MessageDTO): MenuItem {
  return {
    label: t('menu.remind'), icon: '⏰',
    items: [
      ...quickTimes().map((q) => ({ label: q.label, hint: q.date.toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }), onSelect: () => void remind(conv.id, q.date, message?.id, message?.body.slice(0, 120)) })),
      { divider: true },
      { label: t('when.custom'), onSelect: () => openDialog((close) => <ReminderDialog conv={conv} message={message} onClose={close} />) },
    ],
  };
}

// ---------- Notificaciones del navegador ----------
export function askNotifications() {
  if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
}

// ---------- Enlaces y reenvíos hacia otras apps ----------
export const convLink = (id: string) => `${location.origin}${BASE}/c/${id}`;
export const messageLink = (m: MessageDTO) => `${convLink(m.conversationId)}?m=${m.seq}`;

function forwardText(d: BootstrapDTO, conv: ConversationDTO, m: MessageDTO) {
  const author = personById(d, m.authorId)?.name ?? '';
  return { author, title: conversationTitle(d, conv), link: messageLink(m), body: m.body };
}

export function forwardMenu(d: BootstrapDTO, conv: ConversationDTO, m: MessageDTO, openInternal: () => void): MenuItem {
  const f = forwardText(d, conv, m);
  const plain = `${f.author}: ${f.body}\n\n— ${f.title} · TieComs\n${f.link}`;
  return {
    label: t('menu.forward'), icon: '↪',
    items: [
      { label: t('fwd.tiecoms'), icon: '◍', onSelect: openInternal },
      { divider: true },
      { label: t('fwd.whatsapp'), icon: '🟢', onSelect: () => window.open(`https://wa.me/?text=${encodeURIComponent(plain)}`, '_blank', 'noopener') },
      { label: t('fwd.slack'), icon: '#', onSelect: async () => { await copyText(`>${f.body.split('\n').join('\n>')}\n— *${f.author}* · ${f.title} · <${f.link}|TieComs>`); toast(t('toast.slackCopied')); } },
      { label: t('fwd.teams'), icon: 'T', onSelect: async () => { await copyText(plain); toast(t('toast.teamsCopied')); } },
      { label: t('fwd.email'), icon: '✉', onSelect: () => { location.href = `mailto:?subject=${encodeURIComponent(`${f.title} · TieComs`)}&body=${encodeURIComponent(plain)}`; } },
    ],
  };
}

/** Reenviar un mensaje a otra conversación de TieComs, conservando autor y origen. */
export function ForwardDialog({ source, onClose }: { source: MessageDTO; onClose: () => void }) {
  const d = client.getState().data!;
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const author = personById(d, source.authorId)?.name ?? null;
  const list = d.conversations.filter((c) => c.canPost && c.id !== source.conversationId && (!q || conversationTitle(d, c).toLowerCase().includes(q.toLowerCase())));
  const send = async () => {
    if (!target) return;
    if (comment.trim()) await client.send(target, comment.trim());
    await client.send(target, source.body, null, { source: 'tiecoms', author, sentAt: source.createdAt, fromConversationId: source.conversationId });
    toast(t('toast.sent'), { label: t('lin.open'), run: () => navigate(`/c/${target}`) });
    onClose();
  };
  return (
    <Modal title={t('fwd.title')} onClose={onClose}>
      <blockquote className="derive-quote">“{source.body.slice(0, 240)}”</blockquote>
      <input className="input" placeholder={t('fwd.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="list" style={{ maxHeight: 240, overflow: 'auto' }}>
        {list.map((c) => (
          <label key={c.id} className={`check ${target === c.id ? 'derive-opt is-on' : ''}`}>
            <input type="radio" name="fwd" checked={target === c.id} onChange={() => setTarget(c.id)} />
            <span className="grow"><b>{conversationTitle(d, c)}</b><span className="small muted" style={{ display: 'block' }}>{d.workspaces.find((w) => w.id === c.workspaceId)?.name ?? t('kind.direct')}</span></span>
          </label>
        ))}
      </div>
      <input className="input" placeholder={t('fwd.comment')} value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={!target} onClick={send}>{t('fwd.send')}</button></div>
    </Modal>
  );
}

// ---------- Menús de conversación, espacio y persona ----------
export function muteMenu(conv: ConversationDTO): MenuItem {
  const muted = !!conv.mutedUntil && Date.parse(conv.mutedUntil) > Date.now();
  if (muted) return { label: t('menu.unmute'), icon: '🔔', onSelect: () => client.setConversationPrefs(conv.id, { mutedUntil: null }).then(() => toast(t('toast.unmuted'))).catch((e) => toast(errorText(e))) };
  const until = (ms: number) => new Date(Date.now() + ms).toISOString();
  const set = (iso: string) => client.setConversationPrefs(conv.id, { mutedUntil: iso }).then(() => toast(t('toast.muted'))).catch((e) => toast(errorText(e)));
  return {
    label: t('menu.mute'), icon: '🔕',
    items: [
      { label: t('mute.1h'), onSelect: () => set(until(3600_000)) },
      { label: t('mute.8h'), onSelect: () => set(until(8 * 3600_000)) },
      { label: t('mute.week'), onSelect: () => set(until(7 * 86400_000)) },
      { label: t('mute.forever'), onSelect: () => set(new Date('2099-12-31T00:00:00Z').toISOString()) },
    ],
  };
}

export function conversationMenu(conv: ConversationDTO, extra: { onNewMeeting?: () => void } = {}): MenuItem[] {
  const pinned = !!conv.pinnedAt;
  return [
    { label: t('menu.open'), icon: '↗', onSelect: () => navigate(`/c/${conv.id}`) },
    { label: t('menu.openTab'), icon: '⧉', onSelect: () => window.open(convLink(conv.id), '_blank', 'noopener') },
    { divider: true },
    { label: pinned ? t('menu.unpinTop') : t('menu.pinTop'), icon: '📌', onSelect: () => client.setConversationPrefs(conv.id, { pinned: !pinned }).catch((e) => toast(errorText(e))) },
    conv.unread > 0
      ? { label: t('menu.markRead'), icon: '✓', onSelect: () => void client.markConversationRead(conv.id).catch((e) => toast(errorText(e))) }
      : { label: t('menu.markUnreadConv'), icon: '●', disabled: conv.lastMessageSeq <= conv.historyFromSeq, onSelect: () => void client.markUnread(conv.id, conv.lastMessageSeq).then(() => toast(t('toast.markedUnread'))).catch((e) => toast(errorText(e))) },
    muteMenu(conv),
    remindMenu(conv),
    ...(extra.onNewMeeting && conv.workspaceId ? [{ label: t('menu.meeting'), icon: '📅', onSelect: extra.onNewMeeting }] : []),
    { divider: true },
    { label: t('menu.copyLink'), icon: '⛓', onSelect: async () => { await copyText(convLink(conv.id)); toast(t('toast.linkCopied')); } },
    ...(conv.kind !== 'direct' ? [{ divider: true }, {
      label: t('menu.leave'), icon: '⎋', danger: true,
      onSelect: () => { if (confirm(t('chat.leaveConfirm'))) void client.removeMember(conv.id, client.getState().data!.me.id).then(() => navigate('/')).catch((e) => toast(errorText(e))); },
    }] : []),
  ];
}

export function workspaceMenu(ws: WorkspaceDTO, extra: { onNewGroup?: () => void; onInvite?: () => void } = {}): MenuItem[] {
  const pinned = !!ws.pinnedAt;
  return [
    { label: t('menu.openSpace'), icon: '↗', onSelect: () => navigate(`/w/${ws.id}`) },
    { label: t('menu.openTab'), icon: '⧉', onSelect: () => window.open(`${location.origin}${BASE}/w/${ws.id}`, '_blank', 'noopener') },
    { label: pinned ? t('menu.unpinTop') : t('menu.pinTop'), icon: '📌', onSelect: () => client.setWorkspacePinned(ws.id, !pinned).catch((e) => toast(errorText(e))) },
    ...(ws.myRole !== 'guest' && extra.onNewGroup ? [{ label: t('menu.newGroup'), icon: '#', onSelect: extra.onNewGroup }] : []),
    ...(ws.myRole !== 'guest' && extra.onInvite ? [{ label: t('menu.invite'), icon: '＋', onSelect: extra.onInvite }] : []),
    { label: t('menu.viewIssues'), icon: '◆', onSelect: () => navigate(`/w/${ws.id}`) },
    { divider: true },
    { label: t('menu.copyLink'), icon: '⛓', onSelect: async () => { await copyText(`${location.origin}${BASE}/w/${ws.id}`); toast(t('toast.linkCopied')); } },
  ];
}

export function personMenu(p: PersonDTO): MenuItem[] {
  const me = client.getState().data?.me.id;
  if (p.id === me) return [];
  return [{ label: t('people.sendMessage'), icon: '✉', onSelect: () => void client.openDirect(p.id).then((r) => navigate(`/c/${r.id}`)).catch((e) => toast(errorText(e))) }];
}
