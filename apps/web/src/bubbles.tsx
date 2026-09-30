import { useEffect, useState, useSyncExternalStore } from 'react';
import { useClient } from './app-client.ts';
import { pendingOf } from './home-order.ts';
import { t } from './i18n.ts';
import { navigate } from './router.ts';
import { Avatar } from './ui.tsx';
import type { PersonDTO } from '@tiecoms/contracts';

// ---------- Burbuja de mensaje nuevo (con la pestaña a la vista y en otro chat) ----------
type Bubble = { id: number; conversationId: string; seq: number; person: PersonDTO | null; title: string; place: string | null; body: string; mentioned: boolean };
let bubbles: Bubble[] = [];
let nextBubble = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const drop = (id: number) => { bubbles = bubbles.filter((x) => x.id !== id); emit(); };

/** Una burbuja por chat: un mensaje nuevo del mismo chat reemplaza la anterior. Máximo 3 a la vez. */
export function showMessageBubble(b: Omit<Bubble, 'id'>) {
  const id = nextBubble++;
  bubbles = [...bubbles.filter((x) => x.conversationId !== b.conversationId).slice(-2), { ...b, id }];
  emit();
  setTimeout(() => drop(id), b.mentioned ? 9000 : 6000);
}

export function BubbleHost() {
  const list = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => bubbles);
  if (!list.length) return null;
  return (
    <div className="msg-bubbles" role="status" aria-live="polite">
      {list.map((b) => (
        <div key={b.id} className={`msg-bubble${b.mentioned ? ' at-me' : ''}`} role="button" tabIndex={0}
          onClick={() => { drop(b.id); navigate(`/c/${b.conversationId}?m=${b.seq}`); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { drop(b.id); navigate(`/c/${b.conversationId}?m=${b.seq}`); } }}>
          <Avatar person={b.person} size={36} />
          <div className="msg-bubble-text">
            <div className="msg-bubble-head"><b>{b.title}</b>{b.place && <span>{b.place}</span>}</div>
            <div className="msg-bubble-body">{b.body}</div>
          </div>
          <button className="msg-bubble-x" aria-label={t('common.close')} onClick={(e) => { e.stopPropagation(); drop(b.id); }}>×</button>
        </div>
      ))}
    </div>
  );
}

// ---------- Número de conversaciones sin leer en la pestaña (y en el ícono de la app instalada) ----------
// Llamada entrante: el título de la pestaña titila «📞 Fulano te está llamando» hasta contestar o colgar.
let titleFlash: string | null = null;
let flashOn = false;
let flashTimer: ReturnType<typeof setInterval> | null = null;
const titleListeners = new Set<() => void>();
const emitTitle = () => titleListeners.forEach((l) => l());
export function flashTitle(text: string | null) {
  if (flashTimer) clearInterval(flashTimer);
  flashTimer = null;
  titleFlash = text; flashOn = !!text;
  if (text) flashTimer = setInterval(() => { flashOn = !flashOn; emitTitle(); }, 1000);
  emitTitle();
}
const titleNow = () => (titleFlash && flashOn ? titleFlash : null);

export function useTabBadge() {
  const n = useClient((s) => (s.data?.conversations ?? []).reduce((k, c) => k + (pendingOf(c) > 0 || (c.unreadMentions ?? 0) > 0 ? 1 : 0), 0));
  const flash = useSyncExternalStore((l) => { titleListeners.add(l); return () => titleListeners.delete(l); }, titleNow);
  useEffect(() => {
    document.title = flash ?? (n > 0 ? `(${n > 99 ? '99+' : n}) chaggu` : 'chaggu');
  }, [n, flash]);
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try { void (n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {}); } catch {}
  }, [n]);
  useEffect(() => () => { document.title = 'chaggu'; }, []);
}

// ---------- Pedir permiso de avisos del sistema (una franja en la barra, se puede posponer) ----------
const ASK_KEY = 'chaggu:notifyAskLater';
export function NotifyAsk() {
  const supported = typeof Notification !== 'undefined';
  const [perm, setPerm] = useState(() => (supported ? Notification.permission : 'denied'));
  const [later, setLater] = useState(() => { try { return Number(localStorage.getItem(ASK_KEY) ?? 0) > Date.now(); } catch { return false; } });
  if (!supported || perm !== 'default' || later) return null;
  return (
    <div className="notify-ask" role="note">
      <span className="grow">🔔 {t('notif.ask')}</span>
      <span className="notify-ask-btns">
        <button className="btn small accent" onClick={() => { void Notification.requestPermission().then(setPerm).catch(() => {}); }}>{t('notif.askBtn')}</button>
        <button className="btn small" onClick={() => { setLater(true); try { localStorage.setItem(ASK_KEY, String(Date.now() + 7 * 86400_000)); } catch {} }}>{t('notif.later')}</button>
      </span>
    </div>
  );
}
