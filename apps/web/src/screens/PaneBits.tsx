/**
 * Piezas del encabezado de un panel (docs/PANELES.md), sin dependencias pesadas para que las usen tanto el chat
 * (Conversation.tsx) como los demás paneles (PaneItems.tsx): número, fijar, agrandar y cerrar.
 */
import type { CSSProperties, DragEvent } from 'react';
import { client } from '../app-client.ts';
import { chatBgChoice, effectiveBg } from '../chat-bg.ts';
import { localIsoDay } from '../panes-core.ts';
import { t } from '../i18n.ts';
import { isMac } from './Quick.tsx';
import { paneKind, type PaneKind } from '../panes-core.ts';

/** Lo que Split.tsx le pasa a cada panel cuando hay varios. */
export interface PaneProps {
  paneKey: string;
  /** Posición en pantalla (1…8): la del atajo ⌘1…⌘8. */
  index: number;
  active: boolean;
  count: number;
  pinned: boolean;
  maximized: boolean;
  onClose: () => void;
  onOnly: () => void;
  onPin: () => void;
  onMax: () => void;
  /** Tomar el encabezado para mover el panel. */
  onHeadDragStart: (e: DragEvent) => void;
  onHeadDragEnd: () => void;
}

export const MOD = isMac ? '⌘' : 'Ctrl+';
export const ALT = isMac ? '⌥' : 'Alt+';
export const SHIFT = isMac ? '⇧' : 'Shift+';

/** Color propio de cada panel: el del grupo en la Agenda para los chats; el del canal para lo demás. */
const TONES: Record<Exclude<PaneKind, 'conv' | 'view'> | `v:${string}`, [string, string]> = {
  wa: ['var(--green-bg)', 'var(--wa-ink)'],
  mail: ['var(--blue-bg)', 'var(--mail-ink)'],
  inbox: ['var(--blue-bg)', 'var(--mail-ink)'],
  task: ['var(--amber-bg)', 'var(--amber-ink)'],
  'v:issues': ['var(--amber-bg)', 'var(--amber-ink)'],
  'v:agenda': ['var(--violet-bg)', 'var(--violet-ink)'],
  'v:mail': ['var(--blue-bg)', 'var(--mail-ink)'],
  'v:whatsapp': ['var(--green-bg)', 'var(--wa-ink)'],
  'v:today': ['var(--accent-soft)', 'var(--accent-ink)'],
  'v:files': ['var(--teal-bg)', 'var(--teal-ink)'],
};
/** Color de la tarea según su estado: vencida en rojo, esperando en violeta, en curso en azul, hecha en verde. */
function taskTone(id: string): [string, string] {
  const i = client.getState().issues[id];
  if (!i) return ['var(--amber-bg)', 'var(--amber-ink)'];
  if (i.status === 'done' || i.status === 'cancelled') return ['var(--green-bg)', 'var(--green-ink)'];
  if (i.dueDate && i.dueDate.slice(0, 10) < localIsoDay()) return ['var(--red-bg)', 'var(--red-ink)'];
  if (i.status === 'waiting') return ['var(--violet-bg)', 'var(--violet-ink)'];
  if (i.status === 'in_progress') return ['var(--blue-bg)', 'var(--blue-ink)'];
  return ['var(--amber-bg)', 'var(--amber-ink)'];
}
/** Color propio de cada panel. En los chats, el mismo tono de su fondo (chat-bg.ts), para que el acento combine. */
export function paneTone(key: string, multi = true): CSSProperties {
  const k = paneKind(key);
  if (k === 'conv') {
    const bg = effectiveBg(chatBgChoice(key), key, multi);
    if (!bg) return {};
    return { ['--pane-bg' as never]: `var(--gc-${bg.tone}-bg)`, ['--pane-fg' as never]: `var(--gc-${bg.tone}-fg)`, ['--chat-bg' as never]: `var(--cbg-${bg.tone})` };
  }
  if (k === 'task') { const [bg, fg] = taskTone(key.slice(5)); return { ['--pane-bg' as never]: bg, ['--pane-fg' as never]: fg }; }
  const [bg, fg] = TONES[(k === 'view' ? key : k) as keyof typeof TONES] ?? ['var(--paper-3)', 'var(--ink-2)'];
  return { ['--pane-bg' as never]: bg, ['--pane-fg' as never]: fg };
}

export function PaneNum({ pane }: { pane: PaneProps }) {
  return <span className="pane-num" title={`${t('split.num', { n: pane.index })} · ${MOD}${pane.index}`} aria-label={t('split.num', { n: pane.index })}>{pane.index}</span>;
}

/** 📌 · ⤢ · × (en un panel angosto, fijar y agrandar pasan al menú ⋯ del chat). */
export function PaneControls({ pane }: { pane: PaneProps }) {
  return (
    <span className="pane-ctl">
      <button className={`icon-btn pane-pin ${pane.pinned ? 'is-on' : ''}`} aria-pressed={pane.pinned} aria-label={pane.pinned ? t('split.unpin') : t('split.pin')}
        title={`${pane.pinned ? t('split.unpin') : t('split.pin')} · ${MOD}${ALT}P`} onClick={pane.onPin}>📌</button>
      <button className="icon-btn pane-max" aria-pressed={pane.maximized} aria-label={pane.maximized ? t('split.restore', { n: pane.count }) : t('split.max')}
        title={pane.maximized ? t('split.restore', { n: pane.count }) : `${t('split.max')} · ${MOD}${SHIFT}↵`} onClick={pane.onMax}>{pane.maximized ? '⤡' : '⤢'}</button>
      <button className="icon-btn pane-close" aria-label={t('split.close')} title={`${t('split.close')} · ${MOD}${ALT}W`} onClick={pane.onClose}>×</button>
    </span>
  );
}

/** Props del encabezado para arrastrarlo (mover o intercambiar el panel). */
export const headDrag = (pane: PaneProps | undefined) => pane ? {
  draggable: true,
  onDragStart: (e: DragEvent) => {
    // Desde un botón o un campo no se arrastra el panel.
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) { e.preventDefault(); return; }
    pane.onHeadDragStart(e);
  },
  onDragEnd: pane.onHeadDragEnd,
} : {};
