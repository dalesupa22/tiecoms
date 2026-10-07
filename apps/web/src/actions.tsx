import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { MESSAGE_SOUNDS, type BootstrapDTO, type ConversationDTO, type MessageDTO, type PersonDTO, type SoundChoice, type WorkspaceDTO } from '@tiecoms/contracts';
import { client } from './app-client.ts';
import { errorText, locale, t } from './i18n.ts';
import { copyText, toast, type MenuItem } from './menu.tsx';
import { BASE, navigate } from './router.ts';
import { Modal, conversationTitle, personById } from './ui.tsx';
import { previewModeMenu } from './screens/Links.tsx';
import { SleepDialog, sleepSummary } from './screens/Sleep.tsx';
import { MUTE_FOREVER, activeUntil, isForever, tomorrowAt8, untilText } from './silence.ts';
import { DEFAULT_SOUND, playMessageSound } from './sound.ts';
import { MAX_PANES, currentPanes, isOpenInPanes, openBeside, splitAvailable } from './split.ts';
import { InOverlayHost } from './overlay-host.tsx';

// ---------- Diálogos globales (se pueden abrir desde cualquier menú) ----------
let dialog: ((close: () => void) => ReactNode) | null = null;
const dl = new Set<() => void>();
export function openDialog(render: (close: () => void) => ReactNode) { dialog = render; dl.forEach((l) => l()); }
export const getDialogIdentity = () => dialog;
const closeDialog = () => { dialog = null; dl.forEach((l) => l()); };
/** A sequential workflow awaits each form instead of replacing it with the next suggestion. */
export function showDialogUntilClosed(render: (close: () => void) => ReactNode): Promise<void> {
  return new Promise((resolve) => openDialog((close) => render(() => { close(); resolve(); })));
}
export function DialogHost() {
  const d = useSyncExternalStore((l) => { dl.add(l); return () => dl.delete(l); }, () => dialog);
  // Con la llamada en pantalla completa, el diálogo sale dentro de ella (overlay-host.tsx).
  return d ? <InOverlayHost>{d(closeDialog)}</InOverlayHost> : null;
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

/** defaultNote y defaultDate (YYYY-MM-DD, a las 9:00) los usa «gg de este chat» para abrirlo ya lleno. */
export function ReminderDialog({ conv, message, defaultNote, defaultDate, onClose }: { conv: ConversationDTO; message?: MessageDTO; defaultNote?: string; defaultDate?: string | null; onClose: () => void }) {
  const d = client.getState().data!;
  const def = defaultDate && /^\d{4}-\d{2}-\d{2}$/.test(defaultDate) ? new Date(`${defaultDate}T09:00`) : new Date(Date.now() + 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const [when, setWhen] = useState(`${def.getFullYear()}-${pad(def.getMonth() + 1)}-${pad(def.getDate())}T${pad(def.getHours())}:${pad(def.getMinutes())}`);
  const [note, setNote] = useState(defaultNote?.slice(0, 300) ?? (message ? message.body.slice(0, 120) : ''));
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
  const plain = `${f.author}: ${f.body}\n\n— ${f.title} · chaggu\n${f.link}`;
  return {
    label: t('menu.forward'), icon: '↪',
    items: [
      { label: t('fwd.tiecoms'), icon: '◍', onSelect: openInternal },
      { divider: true },
      { label: t('fwd.whatsapp'), icon: '🟢', onSelect: () => window.open(`https://wa.me/?text=${encodeURIComponent(plain)}`, '_blank', 'noopener') },
      { label: t('fwd.slack'), icon: '#', onSelect: async () => { await copyText(`>${f.body.split('\n').join('\n>')}\n— *${f.author}* · ${f.title} · <${f.link}|chaggu>`); toast(t('toast.slackCopied')); } },
      { label: t('fwd.teams'), icon: 'T', onSelect: async () => { await copyText(plain); toast(t('toast.teamsCopied')); } },
      { label: t('fwd.email'), icon: '✉', onSelect: () => { location.href = `mailto:?subject=${encodeURIComponent(`${f.title} · chaggu`)}&body=${encodeURIComponent(plain)}`; } },
    ],
  };
}

/** Reenviar un mensaje a otra conversación de chaggu, conservando autor y origen. */
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

// ---------- Silenciar un chat y «No molestar» ----------
/** «Silenciado hasta las 18:00», «Silenciado hasta el mar 29, 8:00» o «Silenciado» (hasta que lo reactive). */
export function mutedText(conv: ConversationDTO): string | null {
  if (!activeUntil(conv.mutedUntil)) return null;
  const when = untilText(conv.mutedUntil!, locale());
  if (!when) return t('mute.on');
  return new Date(conv.mutedUntil!).toDateString() === new Date().toDateString() ? t('mute.until', { time: when }) : t('mute.untilDay', { time: when });
}

/** Opciones para silenciar un chat: 1 hora · 8 horas · 1 semana · Hasta que lo reactive. */
export function muteOptions(conv: ConversationDTO): MenuItem[] {
  const until = (ms: number) => new Date(Date.now() + ms).toISOString();
  const set = (iso: string) => client.setConversationPrefs(conv.id, { mutedUntil: iso }).then(() => toast(t('toast.muted'))).catch((e) => toast(errorText(e)));
  return [
    { label: t('mute.1h'), onSelect: () => set(until(3600_000)) },
    { label: t('mute.8h'), onSelect: () => set(until(8 * 3600_000)) },
    { label: t('mute.week'), onSelect: () => set(until(7 * 86400_000)) },
    { label: t('mute.forever'), onSelect: () => set(MUTE_FOREVER) },
  ];
}
export const unmute = (conv: ConversationDTO) => client.setConversationPrefs(conv.id, { mutedUntil: null }).then(() => toast(t('toast.unmuted'))).catch((e) => toast(errorText(e)));

/** Submenú «Sonido» de un chat: Predeterminado, los 10 sonidos (suenan al elegirlos) y Sin sonido. */
export function soundMenu(conv: ConversationDTO): MenuItem {
  const cur = conv.sound ?? null;
  const pick = (v: SoundChoice | null) => {
    if (v && v !== 'none') playMessageSound(v, false, true);
    void client.setConversationPrefs(conv.id, { sound: v }).then(() => toast(t('sound.set', { name: soundName(v) }))).catch((e) => toast(errorText(e)));
  };
  return {
    label: t('sound.chat'), icon: '🎵', hint: soundName(cur),
    items: [
      { label: `${cur === null ? '✓ ' : ''}${t('sound.default')}`, onSelect: () => pick(null) },
      { divider: true },
      ...MESSAGE_SOUNDS.map((x) => ({ label: `${cur === x ? '✓ ' : ''}${soundName(x)}`, onSelect: () => pick(x) })),
      { divider: true },
      { label: `${cur === 'none' ? '✓ ' : ''}${t('sound.none')}`, onSelect: () => pick('none') },
    ],
  };
}
/** «Pop», «Campana», «Predeterminado (Pop)», «Sin sonido»… */
export function soundName(v: SoundChoice | null | undefined): string {
  if (v == null) { const def = client.getState().data?.me.messageSound ?? DEFAULT_SOUND; return `${t('sound.default')} (${soundName(def)})`; }
  return v === 'none' ? t('sound.none') : t(`sound.n.${v}` as any);
}

export function muteMenu(conv: ConversationDTO): MenuItem {
  if (activeUntil(conv.mutedUntil)) return { label: t('menu.unmute'), icon: '🔔', hint: mutedText(conv) ?? undefined, onSelect: () => void unmute(conv) };
  return { label: t('menu.mute'), icon: '🔕', items: muteOptions(conv) };
}

/** «No molestar hasta las 18:00» (o el día), «No molestar activo» si es hasta que lo reactive; null si está apagado. */
export function dndText(until: string | null | undefined): string | null {
  if (!activeUntil(until)) return null;
  const when = untilText(until!, locale());
  if (!when) return t('dnd.on');
  return new Date(until!).toDateString() === new Date().toDateString() ? t('dnd.until', { time: when }) : t('dnd.untilDay', { time: when });
}

export async function setDnd(until: string | null) {
  try {
    const r = await client.setDnd(until);
    toast(r.local ? t('dnd.localOnly') : until ? t('dnd.toastOn') : t('dnd.toastOff'));
  } catch (e) { toast(errorText(e)); }
}

/** «No molestar»: 1 hora · 8 horas · Hasta mañana (8:00) · Hasta que lo reactive; o «Reactivar» si está activo. */
export function dndMenu(until: string | null | undefined): MenuItem {
  const on = activeUntil(until);
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const tomorrow = tomorrowAt8();
  return {
    label: t('dnd.title'), icon: '🌙', hint: on ? untilText(until!, locale()) ?? t('dnd.activeHint') : undefined,
    items: [
      ...(on ? [{ label: t('dnd.off'), icon: '🔔', onSelect: () => void setDnd(null) }, { divider: true }] : []),
      { label: t('dnd.1h'), onSelect: () => void setDnd(at(3600_000)) },
      { label: t('dnd.8h'), onSelect: () => void setDnd(at(8 * 3600_000)) },
      { label: t('dnd.tomorrow'), hint: tomorrow.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }), onSelect: () => void setDnd(tomorrow.toISOString()) },
      { label: t('dnd.forever'), onSelect: () => void setDnd(MUTE_FOREVER) },
      // Complemento automático: «No molestar» todas las noches en mi horario (modo sueño).
      { divider: true },
      { label: t('sleep.title'), icon: '🛌', hint: sleepSummary(client.getState().data?.me.sleep) ?? undefined, onSelect: () => openDialog((close) => <SleepDialog onClose={close} />) },
    ],
  };
}

/** Vuelve a pintar cuando vence `until` (para que la lunita, la franja o el 🔕 desaparezcan solos). */
export function useExpiry(until: string | null | undefined) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!activeUntil(until) || isForever(until)) return;
    const ms = Date.parse(until!) - Date.now() + 250;
    if (ms > 2 ** 31 - 1) return;
    const h = setTimeout(() => bump((n) => n + 1), ms);
    return () => clearTimeout(h);
  }, [until]);
}

// ---------- Menús de conversación, espacio y persona ----------
/** Pendientes del grupo y sus derivadas que ve este cliente (mensajes o menciones). */
export function treePending(conv: ConversationDTO) {
  const own = conv.unread + (conv.unreadMentions ?? 0);
  return own + client.derivedOf(conv.id).reduce((n, x) => n + x.unread + (x.unreadMentions ?? 0), 0);
}

/** La conversación del URL (/c/:id), si se está viendo una. */
function currentConversationId() {
  const m = /\/c\/([^/?#]+)/.exec(location.pathname.slice(BASE.length));
  return m ? decodeURIComponent(m[1]!) : null;
}

export function conversationMenu(conv: ConversationDTO, extra: { onNewMeeting?: () => void } = {}): MenuItem[] {
  const pinned = !!conv.pinnedAt;
  return [
    { label: t('menu.open'), icon: '↗', onSelect: () => navigate(`/c/${conv.id}`) },
    { label: t('menu.openTab'), icon: '⧉', onSelect: () => window.open(convLink(conv.id), '_blank', 'noopener') },
    // Hasta 4 en paralelo (split.ts), solo en pantalla ancha y si no está ya abierta.
    ...(splitAvailable() && !isOpenInPanes(conv.id) && currentConversationId() !== conv.id
      ? [{ label: currentPanes().length >= MAX_PANES ? t('split.openReplace') : t('split.open'), icon: '⊞', onSelect: () => openBeside(conv.id, currentConversationId()) }] : []),
    { divider: true },
    { label: pinned ? t('menu.unpinTop') : t('menu.pinTop'), icon: '📌', onSelect: () => client.setConversationPrefs(conv.id, { pinned: !pinned }).catch((e) => toast(errorText(e))) },
    // «Marcar como leído» mira el grupo y sus derivadas (hilos, ramas): así no queda «leído» con pendientes escondidos.
    treePending(conv) > 0
      ? { label: t('menu.markRead'), icon: '✓', onSelect: () => void client.markTreeRead(conv.id).then(() => toast(t('toast.markedRead'))).catch((e) => toast(errorText(e))) }
      : { label: t('menu.markUnreadConv'), icon: '●', disabled: conv.lastMessageSeq <= conv.historyFromSeq, onSelect: () => void client.markUnread(conv.id, conv.lastMessageSeq).then(() => toast(t('toast.markedUnread'))).catch((e) => toast(errorText(e))) },
    muteMenu(conv),
    soundMenu(conv),
    previewModeMenu(conv),
    remindMenu(conv),
    ...(extra.onNewMeeting && conv.canPost ? [{ label: t('menu.meeting'), icon: '📅', onSelect: extra.onNewMeeting }] : []),
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
