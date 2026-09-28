import type { ClientNotice } from '@tiecoms/client-core';
import { client } from './app-client.ts';
import { t } from './i18n.ts';
import { toast } from './menu.tsx';
import { BASE, navigate } from './router.ts';
import { conversationTitle, personById } from './ui.tsx';
import { placeWorkspace } from './screens/Groups.tsx';
import type { BootstrapDTO, ConversationDTO } from '@tiecoms/contracts';
import { activeUntil, mayAlert, shouldSound } from './silence.ts';
import { playPop, soundEnabled } from './sound.ts';

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
export function handleNotice(n: ClientNotice) {
  const d = client.getState().data;
  if (!d) return;
  const dnd = activeUntil(d.me.dndUntil);
  const canNotify = !dnd && 'Notification' in window && Notification.permission === 'granted';
  if (n.kind === 'message') {
    const conv = d.conversations.find((c) => c.id === n.conversationId);
    const hidden = document.visibilityState !== 'visible';
    const current = location.pathname === `${BASE}/c/${n.conversationId}`;
    const check = {
      fromOther: n.message.authorId !== d.me.id && n.message.kind === 'text', mutedUntil: conv?.mutedUntil, mentioned: !!n.mentioned,
      dndUntil: d.me.dndUntil, soundOn: soundEnabled(), hidden, current, farFromEnd: current && !hidden && farFromEnd(n.conversationId),
    };
    if (!mayAlert(check)) return;
    if (shouldSound(check)) playPop(!!n.mentioned);
    const who = personById(d, n.message.authorId)?.name ?? '';
    if (hidden && canNotify) {
      const group = conv ? groupNoticeTitle(d, conv) : null;
      const title = n.mentioned ? t('mention.mentionedYou', { name: who }) : null;
      const note = title
        ? new Notification(title, { body: `${group ?? (conv ? conversationTitle(d, conv) : 'Chaggu')}: ${n.message.body.slice(0, 160)}`, tag: n.conversationId, icon: `${BASE}/icon-192.png` })
        : group
        ? new Notification(group, { body: `${who}: ${n.message.body.slice(0, 160)}`, tag: n.conversationId, icon: `${BASE}/icon-192.png` })
        : new Notification(`${who} · ${conv ? conversationTitle(d, conv) : 'Chaggu'}`, { body: n.message.body.slice(0, 160), tag: n.conversationId, icon: `${BASE}/icon-192.png` });
      note.onclick = () => { window.focus(); navigate(`/c/${n.conversationId}?m=${n.message.seq}`); note.close(); };
    }
    return;
  }
  if (n.kind === 'reaction') {
    // Reacción a un mensaje mío: toast si estoy en otra pantalla; notificación del sistema si la pestaña no está a la vista.
    const current = location.pathname === `${BASE}/c/${n.conversationId}`;
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
  const title = r.note || (conv ? conversationTitle(d, conv) : 'Chaggu');
  const go = () => navigate(`/c/${r.conversationId}${r.messageSeq ? `?m=${r.messageSeq}` : ''}`);
  toast(`⏰ ${title}`, { label: t('rem.open'), run: go }, 12_000);
  if (canNotify) {
    const note = new Notification(`⏰ ${t('rem.alert')}`, { body: title, tag: r.id, requireInteraction: true, icon: `${BASE}/icon-192.png` });
    note.onclick = () => { window.focus(); go(); note.close(); };
  }
}
