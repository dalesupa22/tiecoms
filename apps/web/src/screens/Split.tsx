/**
 * La cuadrícula: hasta 4 paneles a la vez (split.ts). Un panel es un chat de chaggu, un correo o una conversación de WhatsApp.
 * Se arrastra una fila y se suelta aquí: con menos de 4 se abre al lado; con 4, reemplaza al panel donde se suelta
 * (los fijados no se reemplazan). Un correo o un mensaje de WhatsApp soltado sobre un chat se lleva a ese chat.
 * 1 → pantalla completa · 2 → lado a lado · 3 → dos arriba y uno abajo · 4 → cuadrícula 2×2.
 * Vive en /c/:id (el chat del URL es el activo) y en /cuadricula, y también al lado de WhatsApp y Correo.
 */
import { useEffect, useState, type DragEvent } from 'react';
import { useClient } from '../app-client.ts';
import { t } from '../i18n.ts';
import { navigate } from '../router.ts';
import { conversationTitle } from '../ui.tsx';
import { parseKey } from '../grid-keys.ts';
import { openInGrid, readDrag, shareToChat } from '../grid-actions.ts';
import {
  MAX_PANES, closePane, dragKindOf, fitsChat, fitsSlot, focusPane, onlyPane, rememberBack, setSplitSize, syncActive, togglePin,
  useActiveKey, useBack, usePanes, usePinned, useSplitSizes, useWide, type DragKind,
} from '../split.ts';
import { ConversationScreen } from './Conversation.tsx';
import { InboxPane, MailPane, TasksPane, WaListPane, WaPane } from './Panes.tsx';

/** /c/:id: el chat del URL es el panel activo. */
export function ConversationArea({ id, search }: { id: string; search: string }) {
  return <GridArea id={id} search={search} />;
}

/** /cuadricula: la cuadrícula sola, con un «← Volver» a donde estabas. */
export function GridScreen() {
  const back = useBack();
  const names: Record<string, string> = { '/': t('nav.today'), '/whatsapp': 'WhatsApp', '/correo': t('nav.mail'), '/asuntos': t('nav.issues'), '/agenda': t('nav.agenda'), '/dms': t('nav.dms'), '/grupos': t('nav.groups') };
  return (
    <div className="grid-screen">
      {back && <button className="grid-back" onClick={() => { const to = back; rememberBack(null); navigate(to); }}>← {t('grid.backTo', { name: names[back] ?? (back.startsWith('/c/') ? t('grid.chat') : t('nav.today')) })}</button>}
      <GridArea id={null} />
    </div>
  );
}

export function GridArea({ id, search = '', side }: { id: string | null; search?: string; side?: boolean }) {
  const panes = usePanes();
  const pinned = usePinned();
  const activeStore = useActiveKey();
  const wide = useWide();
  const d = useClient((s) => s.data);
  const known = d?.conversations;
  useEffect(() => { if (id) syncActive(id); }, [id]);
  const exists = (x: string) => parseKey(x).kind !== 'chat' || x === id || !!known?.some((c) => c.id === x);
  // En /c/:id, un solo panel guardado no esconde el chat abierto; en /cuadricula se ven todos, aunque sea uno.
  const shown = panes.filter(exists);
  const list = wide && (id ? shown.length > 1 : shown.length > 0) ? shown : id ? [id] : shown.slice(0, 1);
  if (id && !list.includes(id)) list[0] = id;
  const active = id ?? (activeStore && list.includes(activeStore) ? activeStore : list[0] ?? null);
  const [drop, setDrop] = useState<{ over: string | null; kind: DragKind } | null>(null);
  const full = list.length >= MAX_PANES;
  const sizes = useSplitSizes();

  const cellOf = (e: DragEvent) => (e.target as HTMLElement).closest<HTMLElement>('[data-pane]')?.dataset.pane ?? null;
  const chatOver = (over: string | null) => (over && parseKey(over).kind === 'chat' ? over : null);
  const onDragOver = (e: DragEvent) => {
    const kind = dragKindOf(e.dataTransfer.types);
    if (!wide || !kind) return;
    const over = cellOf(e);
    // Un mensaje suelto solo viaja a un chat; lo demás se puede llevar a un cuadrito.
    if (kind === 'wamsg' ? !chatOver(over) : !fitsSlot(kind) && !fitsChat(kind)) { if (drop) setDrop(null); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!drop || drop.over !== over || drop.kind !== kind) setDrop({ over, kind });
  };
  const onDragLeave = (e: DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDrop(null);
  };
  const onDrop = (e: DragEvent) => {
    const kind = dragKindOf(e.dataTransfer.types);
    const over = cellOf(e);
    setDrop(null);
    if (!kind) return;
    const p = readDrag(e.dataTransfer, kind);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation(); // el área principal de otras pantallas también recibe soltados (Shell.tsx): este ya lo atendió
    const chat = chatOver(over);
    // Acción 1: un correo o un mensaje de WhatsApp sobre un chat se lleva a ese chat.
    if (chat && (p.kind === 'mail' || p.kind === 'wamsg')) {
      const title = conversationTitle(d!, d!.conversations.find((c) => c.id === chat)!);
      void shareToChat(p, chat, title);
      return;
    }
    if (p.kind === 'wamsg') return;
    // Acción 2: un cuadrito.
    openInGrid(p, active, full ? over : null);
  };
  const hint = (() => {
    if (!drop) return null;
    const chat = chatOver(drop.over);
    if (chat && fitsChat(drop.kind)) {
      const c = d?.conversations.find((x) => x.id === chat);
      return t('grid.dropShare', { name: c && d ? conversationTitle(d, c) : '' });
    }
    return full ? t('split.dropReplace') : t('split.dropAdd', { n: list.length + 1, max: MAX_PANES });
  })();

  if (list.length === 0) {
    return (
      <div className={`split n1 grid-empty ${drop ? 'is-dropping' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div className="grid-empty-card">
          <div className="grid-glyph big" aria-hidden><i /><i /><i /><i /></div>
          <h2 className="serif">{t('grid.emptyTitle')}</h2>
          <p>{t('grid.emptyBody')}</p>
          <ul className="grid-empty-list">
            <li><b>{t('grid.toChat')}</b> {t('grid.toChatHow')}</li>
            <li><b>{t('grid.toSlot')}</b> {t('grid.toSlotHow')}</li>
          </ul>
        </div>
        {hint && <div className="split-drop" aria-hidden><span>⊞ {hint}</span></div>}
      </div>
    );
  }
  const cell = (x: string) => {
    const ref = parseKey(x);
    const frame = { active: x === active, count: list.length, pinned: pinned.has(x), onClose: () => closePane(x, id), onOnly: () => onlyPane(x), onPin: () => togglePin(x) };
    return (
      <div key={x} data-pane={x} className={`split-cell ${x === active ? 'is-active' : ''} ${drop && drop.over === x && (full || (chatOver(x) && fitsChat(drop.kind))) ? 'is-target' : ''}`}
        // Tocar un panel lo vuelve el activo (antes del clic, para que el clic siga funcionando adentro).
        onPointerDownCapture={() => { if (x !== active) focusPane(x); }}>
        {ref.kind === 'chat' ? <ConversationScreen key={list.length === 1 && x === id ? x + search : x} id={x} search={x === id ? search : ''} pane={list.length > 1 || !id ? frame : undefined} />
          : ref.kind === 'mail' ? <MailPane key={x} paneKey={x} provider={ref.provider} id={ref.id} frame={frame} />
          : ref.kind === 'wa' ? <WaPane key={x} paneKey={x} accountId={ref.accountId} jid={ref.jid} frame={frame} />
          : ref.kind === 'tasks' ? <TasksPane key={x} frame={frame} />
          : ref.kind === 'inbox' ? <InboxPane key={x} frame={frame} />
          : <WaListPane key={x} frame={frame} />}
      </div>
    );
  };
  if (list.length === 1) {
    return (
      <div className={`split n1 ${side ? 'is-side' : ''} ${drop ? 'is-dropping' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {cell(list[0]!)}
        {hint && <div className="split-drop" aria-hidden><span>⊞ {hint}</span></div>}
      </div>
    );
  }
  // Al lado de WhatsApp o Correo el espacio es angosto: los paneles van uno sobre otro, sin divisiones.
  if (side) {
    return (
      <div className={`split n${list.length} is-side ${drop ? 'is-dropping' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
        style={{ gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: `repeat(${list.length}, minmax(0, 1fr))` }}>
        {list.map(cell)}
        {hint && <div className="split-drop" aria-hidden><span>⊞ {hint}</span></div>}
      </div>
    );
  }
  return (
    <div className={`split n${list.length} ${drop ? 'is-dropping' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      style={{ gridTemplateColumns: `${sizes.col}fr ${1 - sizes.col}fr`, ...(list.length > 2 ? { gridTemplateRows: `${sizes.row}fr ${1 - sizes.row}fr` } : {}) }}>
      {list.map(cell)}
      {/* Divisiones que se arrastran para cambiar el tamaño (doble clic: mitad y mitad). */}
      <SplitHandle dir="col" at={sizes.col} />
      {list.length > 2 && <SplitHandle dir="row" at={sizes.row} />}
      {hint && <div className="split-drop" aria-hidden><span>⊞ {hint}</span></div>}
    </div>
  );
}

function SplitHandle({ dir, at }: { dir: 'col' | 'row'; at: number }) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add(dir === 'col' ? 'is-resizing-col' : 'is-resizing-row');
    const move = (ev: PointerEvent) => setSplitSize(dir === 'col' ? { col: (ev.clientX - box.left) / box.width } : { row: (ev.clientY - box.top) / box.height });
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-resizing-col', 'is-resizing-row');
      setSplitSize({}, true);
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    e.preventDefault();
  };
  return <div className={`split-handle is-${dir}`} role="separator" aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'} title={t('split.resize')}
    style={dir === 'col' ? { left: `calc(${at * 100}% - 5px)` } : { top: `calc(${at * 100}% - 5px)` }}
    onPointerDown={start} onDoubleClick={() => setSplitSize(dir === 'col' ? { col: 0.5 } : { row: 0.5 }, true)} />;
}
