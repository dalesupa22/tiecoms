import type { ConversationDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { t } from '../i18n.ts';
import { navigate } from '../router.ts';
import { openMenuAt } from '../menu.tsx';
import { conversationTitle } from '../ui.tsx';
import { isTreeChild, pendingOf } from '../home-order.ts';

/**
 * Pendientes escondidos en las derivadas de este grupo (hilos, ramas, internas): el caso de «leí el grupo
 * y sigue con 11». Dice cuántos y dónde; tocar lleva a cada una. No marca nada como leído por sí sola.
 */
export function DerivedPendingStrip({ conv }: { conv: ConversationDTO }) {
  const d = useClient((s) => s.data)!;
  const kids = d.conversations.filter((x) => isTreeChild(x, conv.id) && (pendingOf(x) > 0 || (x.unreadMentions ?? 0) > 0));
  if (!kids.length) return null;
  const n = kids.reduce((s, x) => s + pendingOf(x), 0);
  const mentions = kids.reduce((s, x) => s + (x.unreadMentions ?? 0), 0);
  const open = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    openMenuAt(r.left, r.bottom + 4, [
      ...kids.map((x) => ({
        label: conversationTitle(d, x), icon: x.deriveKind === 'same' ? '💬' : '⑂',
        hint: `${pendingOf(x)}${(x.unreadMentions ?? 0) > 0 ? ' · @' : ''}`,
        onSelect: () => navigate(`/c/${x.id}`),
      })),
      { divider: true },
      { label: t('tree.markAll'), icon: '✓', onSelect: () => void client.markTreeRead(conv.id) },
    ]);
  };
  return (
    <button className="tree-strip" onClick={(e) => open(e.currentTarget)}>
      <span aria-hidden>⑂</span>
      <span className="grow ellipsis">{kids.length === 1 ? t('tree.stripOne', { n, name: conversationTitle(d, kids[0]!) }) : t('tree.strip', { n, k: kids.length })}{mentions > 0 ? ` · @ ${mentions}` : ''}</span>
      <span className="link-btn">{t('sched.see')}</span>
    </button>
  );
}
