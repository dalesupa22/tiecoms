import type { ClientNotice } from '@tiecoms/client-core';
import { client } from './app-client.ts';
import { t } from './i18n.ts';
import { toast } from './menu.tsx';
import { BASE, navigate } from './router.ts';
import { isOpenInPanes } from './split.ts';
import { conversationTitle, personById } from './ui.tsx';
import { placeWorkspace } from './screens/Groups.tsx';
import type { BootstrapDTO, ConversationDTO } from '@tiecoms/contracts';
import { activeUntil, mayAlert, shouldSound } from './silence.ts';
import { playMessageSound, soundEnabled } from './sound.ts';
import { dismissIncomingCall, showIncomingCall } from './screens/Call.tsx';
import { onCallTranscriptEvent } from './call.ts';
import { showMessageBubble } from './bubbles.tsx';

/** En el chat abierto, ¿la vista está arriba, lejos del final (más de una pantalla)? */
function farFromEnd(conversationId: string) {
  const el = document.querySelector<HTMLElement>(`.msgs[data-conv-id="${conversationId}"]`);
  if (!el) return false;
  return el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight;
}

/** «Empresa - Grupo» (p. ej. «Xertify - General») para chats de un espacio; igual que en los push del servidor. */
export function groupNoticeTitle(d: BootstrapDTO, c: ConversationDTO): string | null {
  const ws = c.workspaceId ? d.workspaces.find((w) => w.id === c.workspaceId) : null;
  if (!ws || c.kind === 'direct') return null;
  return `${placeWorkspace(d, ws).name} - ${conversationTitle(d, c)}`;
}

/**
 * Mensajes nuevos: suenan (sound.ts) si la pestaña está oculta, es de otro chat o estoy arriba en el
 * chat abierto; notificación del sistema solo si la pestaña no está a la vista. Nada con «No molestar»,
 * y en un chat silenciado solo las menciones (salvo «hasta que lo reactive»), igual que el push.
 * Recordatorios y reuniones: toast siempre; notificación del sistema si hay permiso y no hay «No molestar».
 */
/** Notificaciones del sistema de llamadas entrantes, para cerrarlas si contesto en otro dispositivo. */
const callNotes = new Map<string, Notification>();

export function handleNotice(n: ClientNotice) {
  const d = client.getState().data;
  if (!d) return;
  const dnd = activeUntil(d.me.dndUntil);
  const canNotify = !dnd && 'Notification' in window && Notification.permission === 'granted';
  if (n.kind === 'message') {
    const conv = d.conversations.find((c) => c.id === n.conversationId);
    const hidden = document.visibilityState !== 'visible';
    const current = location.pathname === `${BASE}/c/${n.conversationId}` || isOpenInPanes(n.conversationId);
    const check = {
      fromOther: n.message.authorId !== d.me.id && n.message.kind === 'text', mutedUntil: conv?.mutedUntil, mentioned: !!n.mentioned,
      dndUntil: d.me.dndUntil, soundOn: soundEnabled(), hidden, current, farFromEnd: current && !hidden && farFromEnd(n.conversationId),
    };
    if (!mayAlert(check)) return;
    if (shouldSound(check)) playMessageSound(conv?.sound ?? d.me.messageSound, !!n.mentioned);
    const who = personById(d, n.message.authorId)?.name ?? '';
    // Una sola vista: nunca el contenido en la notificación.
    const body = n.message.viewOnce ? (n.message.attachments?.some((x) => x.kind === 'voice') ? t('once.voice') : n.message.attachments?.length ? t('once.photo') : t('once.message')) : n.message.body.slice(0, 160);
    if (hidden && canNotify) {
      const group = conv ? groupNoticeTitle(d, conv) : null;
      const title = n.mentioned ? t('mention.mentionedYou', { name: who }) : null;
      const note = title
        ? new Notification(title, { body: `${group ?? (conv ? conversationTitle(d, conv) : 'chaggu')}: ${body}`, tag: n.conversationId, icon: `${BASE}/icon-192.png` })
        : group
        ? new Notification(group, { body: `${who}: ${body}`, tag: n.conversationId, icon: `${BASE}/icon-192.png` })
        : new Notification(`${who} · ${conv ? conversationTitle(d, conv) : 'chaggu'}`, { body, tag: n.conversationId, icon: `${BASE}/icon-192.png` });
      note.onclick = () => { window.focus(); navigate(`/c/${n.conversationId}?m=${n.message.seq}`); note.close(); };
    } else if (!current) {
      // En otra pantalla (o con la pestaña oculta y sin permiso de avisos): burbuja con quién, dónde y el mensaje; un clic abre el chat.
      const group = conv ? groupNoticeTitle(d, conv) : null;
      const person = personById(d, n.message.authorId) ?? null;
      showMessageBubble({
        conversationId: n.conversationId, seq: n.message.seq, person, mentioned: !!n.mentioned, body,
        title: n.mentioned ? t('mention.mentionedYou', { name: who }) : who,
        place: group ?? (conv && conv.kind !== 'direct' ? conversationTitle(d, conv) : null),
      });
    }
    return;
  }
  if (n.kind === 'reaction') {
    // Reacción a un mensaje mío: toast si estoy en otra pantalla; notificación del sistema si la pestaña no está a la vista.
    const current = location.pathname === `${BASE}/c/${n.conversationId}` || isOpenInPanes(n.conversationId);
    if (document.visibilityState === 'visible' && current) return;
    // Igual que el push de reacciones: nada con «No molestar» ni en un chat silenciado.
    if (dnd || activeUntil(d.conversations.find((c) => c.id === n.conversationId)?.mutedUntil)) return;
    const who = personById(d, n.userId)?.name.split(' ')[0] ?? '';
    const text = t('react.notice', { name: who, emoji: n.emoji, excerpt: n.message.body.replace(/\s+/g, ' ').slice(0, 60) });
    const go = () => navigate(`/c/${n.conversationId}?m=${n.message.seq}`);
    if (document.visibilityState === 'visible') toast(text, { label: t('rem.open'), run: go }, 5000);
    else if (canNotify) {
      const note = new Notification(text, { tag: `react-${n.message.id}`, icon: `${BASE}/icon-192.png` });
      note.onclick = () => { window.focus(); go(); note.close(); };
    }
    return;
  }
  if (n.kind === 'mentionsDropped') {
    const names = n.userIds.map((id) => (id === 'all' ? t('mention.allLabel') : personById(d, id)?.name ?? '?')).join(', ');
    toast(t('mention.dropped', { names }));
    return;
  }
  if (n.kind === 'callTranscript') { onCallTranscriptEvent(n.event); return; }
  if (n.kind === 'callHandled') {
    // Contesté o rechacé en otro de mis dispositivos: aquí deja de sonar y se cierra el aviso.
    dismissIncomingCall(n.callId);
    callNotes.get(n.callId)?.close();
    callNotes.delete(n.callId);
    return;
  }
  if (n.kind === 'callRinging') {
    // El aviso en pantalla siempre (el cliente ya filtra «No molestar»); notificación del sistema si la pestaña está oculta.
    // Suena el tono de llamada (distinto de los mensajes) hasta contestar, rechazar o que termine.
    showIncomingCall(n.call, n.callerName, n.conversationTitle);
    if (document.visibilityState !== 'visible' && canNotify) {
      const note = new Notification(`${n.call.kind === 'video' ? '🎥' : '📞'} ${t('call.incomingFrom', { name: n.callerName })}`, { body: n.conversationTitle ?? '', tag: `call-${n.call.id}`, requireInteraction: true, icon: `${BASE}/icon-192.png` });
      note.onclick = () => { window.focus(); navigate(`/c/${n.call.conversationId}`); note.close(); };
      callNotes.set(n.call.id, note);
    }
    return;
  }
  if (n.kind === 'eventSoon') {
    const ev = n.event;
    const text = t('cal.soon', { n: n.minutes, title: ev.title });
    const go = () => navigate(`/c/${ev.conversationId}`);
    toast(`📅 ${text}`, { label: t('rem.open'), run: go }, 15_000);
    if (canNotify) {
      const note = new Notification(`📅 ${text}`, { body: ev.location ?? '', tag: `soon-${ev.id}`, requireInteraction: true, icon: `${BASE}/icon-192.png` });
      note.onclick = () => { window.focus(); go(); note.close(); };
    }
    return;
  }
  const r = n.reminder;
  const conv = d.conversations.find((c) => c.id === r.conversationId);
  const title = r.note || (conv ? conversationTitle(d, conv) : 'chaggu');
  const go = () => navigate(`/c/${r.conversationId}${r.messageSeq ? `?m=${r.messageSeq}` : ''}`);
  toast(`⏰ ${title}`, { label: t('rem.open'), run: go }, 12_000);
  if (canNotify) {
    const note = new Notification(`⏰ ${t('rem.alert')}`, { body: title, tag: r.id, requireInteraction: true, icon: `${BASE}/icon-192.png` });
    note.onclick = () => { window.focus(); go(); note.close(); };
  }
}
