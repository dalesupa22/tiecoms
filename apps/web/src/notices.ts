import type { ClientNotice } from '@tiecoms/client-core';
import { client } from './app-client.ts';
import { t } from './i18n.ts';
import { toast } from './menu.tsx';
import { BASE, navigate } from './router.ts';
import { conversationTitle, personById } from './ui.tsx';

/**
 * Mensajes nuevos: notificación del sistema solo si la pestaña no está a la vista
 * y la conversación no está silenciada. Recordatorios: siempre (toast y, si hay
 * permiso, notificación del sistema).
 */
export function handleNotice(n: ClientNotice) {
  const d = client.getState().data;
  if (!d) return;
  const canNotify = 'Notification' in window && Notification.permission === 'granted';
  if (n.kind === 'message') {
    const current = location.pathname === `${BASE}/c/${n.conversationId}`;
    if (document.visibilityState === 'visible' && current) return;
    const conv = d.conversations.find((c) => c.id === n.conversationId);
    const who = personById(d, n.message.authorId)?.name ?? '';
    if (document.visibilityState !== 'visible' && canNotify) {
      const note = new Notification(`${who} · ${conv ? conversationTitle(d, conv) : 'Chaggu'}`, { body: n.message.body.slice(0, 160), tag: n.conversationId, icon: `${BASE}/icon-192.png` });
      note.onclick = () => { window.focus(); navigate(`/c/${n.conversationId}?m=${n.message.seq}`); note.close(); };
    }
    return;
  }
  if (n.kind === 'reaction') {
    // Reacción a un mensaje mío: toast si estoy en otra pantalla; notificación del sistema si la pestaña no está a la vista.
    const current = location.pathname === `${BASE}/c/${n.conversationId}`;
    if (document.visibilityState === 'visible' && current) return;
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
