import { useEffect, useSyncExternalStore } from 'react';
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
export function useTabBadge() {
  const n = useClient((s) => (s.data?.conversations ?? []).reduce((k, c) => k + (pendingOf(c) > 0 || (c.unreadMentions ?? 0) > 0 ? 1 : 0), 0));
  useEffect(() => {
    document.title = n > 0 ? `(${n > 99 ? '99+' : n}) chaggu` : 'chaggu';
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try { void (n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {}); } catch {}
  }, [n]);
  useEffect(() => () => { document.title = 'chaggu'; }, []);
}
