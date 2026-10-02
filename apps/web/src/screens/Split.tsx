/**
 * La cuadrícula: hasta 4 paneles a la vez (split.ts). Un panel es un chat de chaggu, un correo o una conversación de WhatsApp.
 * Se arrastra una fila y se suelta aquí: con menos de 4 se abre al lado; con 4, reemplaza al panel donde se suelta
 * (los fijados no se reemplazan). Un correo o un mensaje de WhatsApp soltado sobre un chat se lleva a ese chat.
 * 1 → pantalla completa · 2 → lado a lado · 3 → dos arriba y uno abajo · 4 → cuadrícula 2×2.
 * Vive en /c/:id (el chat del URL es el activo) y en /cuadricula, y también al lado de WhatsApp y Correo.
 */
import { useEffect, useState, type DragEvent } from 'react';
import { useClient } from '../app-client.ts';
import { locale, t } from '../i18n.ts';
import { navigate } from '../router.ts';
import { conversationTitle } from '../ui.tsx';
import { TASKS_KEY, parseKey } from '../grid-keys.ts';
import { openInGrid, readDrag, shareToChat } from '../grid-actions.ts';
import {
  MAX_PANES, closePane, dragKindOf, fitsChat, fitsSlot, focusPane, onlyPane, rememberBack, setSplitSize, syncActive, togglePin,
  useActiveKey, useBack, usePanes, usePinned, useSplitSizes, useWide, type DragKind,
  useExpandedPane, collapsePane, useGridLayout, useLayoutOrder, setGridLayout, moveLayoutPane, type GridLayout,
  useTallPanes, setPaneRows, useMetas,
} from '../split.ts';
import { gridSpanLayout } from '../grid-span-layout.ts';
import { ConversationScreen } from './Conversation.tsx';
import { ensureAssigned, openTintMenu, usePaneTints } from '../tints.ts';
import { InboxPane, MailPane, SectionPane, TasksPane, WaListPane, WaPane } from './Panes.tsx';

const sectionLabel = (key: string) => ({ tasks: t('nav.issues'), inbox: t('nav.mail'), wachats: 'WhatsApp', agenda: t('nav.agenda'), trazo: t('nav.trazo'), calls: t('nav.calls') } as Record<string,string>)[parseKey(key).kind] ?? parseKey(key).kind;

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
  const expandedKey = useExpandedPane();
  const layout = useGridLayout();
  const order = useLayoutOrder();
  const tallPanes = useTallPanes();
  const metas = useMetas();
  const wide = useWide();
  const d = useClient((s) => s.data);
  const known = d?.conversations;
  useEffect(() => { if (id) syncActive(id); }, [id]);
  const exists = (x: string) => parseKey(x).kind !== 'chat' || x === id || !!known?.some((c) => c.id === x);
  // En /c/:id, un solo panel guardado no esconde el chat abierto; en /cuadricula se ven todos, aunque sea uno.
  const shown = panes.filter(exists);
  const list = wide && (id ? shown.length > 1 : shown.length > 0) ? shown : id ? [id] : shown.slice(0, 1);
  if (id && !list.includes(id)) list[0] = id;
  const expanded = expandedKey && list.includes(expandedKey) ? expandedKey : null;
  const customLayout = wide && !side && layout === 'custom';
  const mixedLayout = wide && !side && layout !== 'classic' && layout !== 'custom' && list.length >= 4;
  const ordered = [...order.filter((k) => list.includes(k)), ...list.filter((k) => !order.includes(k))];
  const arranged = mixedLayout || customLayout ? ordered : list;
  const visible = mixedLayout ? arranged.slice(0, 4) : arranged;
  const active = id ?? (activeStore && list.includes(activeStore) ? activeStore : list[0] ?? null);
  const [drop, setDrop] = useState<{ over: string | null; kind: DragKind } | null>(null);
  useEffect(() => {
    const end = () => setDrop(null), dropEnd = () => queueMicrotask(end), key = (e: KeyboardEvent) => { if(e.key === 'Escape') end(); };
    addEventListener('dragend',end); addEventListener('drop',dropEnd); addEventListener('blur',end); addEventListener('keydown',key);
    return () => { removeEventListener('dragend',end); removeEventListener('drop',dropEnd); removeEventListener('blur',end); removeEventListener('keydown',key); };
  }, []);
  // Tareas va en su propia columna, a la derecha y de arriba a abajo (la tercera columna): no gasta uno de los 4 cuaditos.
  // Al lado de WhatsApp o Correo el espacio es angosto y va apilada con los demás.
  const hasTasks = list.includes(TASKS_KEY);
  const withTasks = hasTasks && !side && !mixedLayout && !customLayout;
  const grid = withTasks ? list.filter((k) => k !== TASKS_KEY) : arranged;
  const full = list.filter((k) => k !== TASKS_KEY).length >= MAX_PANES;
  const currentTall = customLayout ? tallPanes : mixedLayout ? arranged.slice(0, 2) : hasTasks ? [TASKS_KEY] : [];
  const spanLayout = gridSpanLayout(arranged, new Set(currentTall));
  const paneName = (key: string) => parseKey(key).kind === 'chat'
    ? (d && known?.find((c) => c.id === key) ? conversationTitle(d, known.find((c) => c.id === key)!) : key.slice(0, 8))
    : metas[key]?.title ?? (parseKey(key).kind === 'wa' ? 'WhatsApp' : parseKey(key).kind === 'mail' ? t('nav.mail') : sectionLabel(key));
  const sizes = useSplitSizes();
  // Cada cuadrito con su color (tints.ts): los nuevos reciben uno que no esté repetido.
  const tints = usePaneTints();
  useEffect(() => { ensureAssigned(list); }, [list.join('|')]);

  const cellOf = (e: DragEvent) => (e.target as HTMLElement).closest<HTMLElement>('[data-pane]')?.dataset.pane ?? null;
  const chatOver = (over: string | null) => (over && parseKey(over).kind === 'chat' ? over : null);
  /** Lo que solo viaja a un chat (un mensaje o una tarea suelta) no se acepta fuera de un chat. */
  const onlyChat = (k: DragKind) => k === 'wamsg' || k === 'task';
  const onDragOver = (e: DragEvent) => {
    const kind = dragKindOf(e.dataTransfer.types);
    if (!wide || !kind) return;
    const over = cellOf(e);
    if (onlyChat(kind) ? !chatOver(over) : !fitsSlot(kind) && !fitsChat(kind)) { if (drop) setDrop(null); return; }
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
    // Acción 1: un correo, un mensaje de WhatsApp o una tarea sobre un chat se lleva a ese chat.
    if (chat && (p.kind === 'mail' || p.kind === 'wamsg' || p.kind === 'task')) {
      const title = conversationTitle(d!, d!.conversations.find((c) => c.id === chat)!);
      void shareToChat(p, chat, title);
      return;
    }
    if (p.kind === 'wamsg' || p.kind === 'task') return;
    // Acción 2: un cuadrito (Tareas, a su columna).
    openInGrid(p, active, full ? over : null);
  };
  const hint = (() => {
    if (!drop) return null;
    const chat = chatOver(drop.over);
    if (chat && fitsChat(drop.kind)) {
      const c = d?.conversations.find((x) => x.id === chat);
      return t('grid.dropShare', { name: c && d ? conversationTitle(d, c) : '' });
    }
    return full ? t('split.dropReplace') : t('split.dropAdd', { n: list.filter((k) => k !== TASKS_KEY).length + 1, max: MAX_PANES });
  })();

  const cell = (x: string) => {
    const ref = parseKey(x);
    const frame = { visible: expanded ? expanded === x : visible.includes(x), active: x === active, count: list.length, pinned: pinned.has(x), onClose: () => closePane(x, id), onOnly: () => onlyPane(x), onPin: () => togglePin(x), onTint: (el: HTMLElement) => openTintMenu(el, x) };
    return (
      <div key={x} data-pane={x} data-tint={tints[x]} hidden={expanded ? expanded !== x : !visible.includes(x)}
        style={!expanded && customLayout ? { gridColumn: spanLayout.cells[x]!.column, gridRow: `${spanLayout.cells[x]!.row} / span ${spanLayout.cells[x]!.span}` }
          : mixedLayout && !expanded ? { gridArea: ['a', 'b', 'c', 'd'][arranged.indexOf(x)] } : undefined}
        className={`split-cell ${x === active ? 'is-active' : ''} ${drop && drop.over === x && (full || (chatOver(x) && fitsChat(drop.kind))) ? 'is-target' : ''}`}
        // Tocar un panel lo vuelve el activo (antes del clic, para que el clic siga funcionando adentro).
        onPointerDownCapture={() => { if (x !== active) focusPane(x); }}>
        {ref.kind === 'chat' ? <ConversationScreen key={list.length === 1 && x === id ? x + search : x} id={x} search={x === id ? search : ''} pane={list.length > 1 || !id ? frame : undefined} />
          : ref.kind === 'mail' ? <MailPane key={x} paneKey={x} provider={ref.provider} id={ref.id} frame={frame} />
          : ref.kind === 'wa' ? <WaPane key={x} paneKey={x} accountId={ref.accountId} jid={ref.jid} frame={frame} />
          : ref.kind === 'tasks' ? <TasksPane key={x} frame={frame} />
          : ref.kind === 'inbox' ? <InboxPane key={x} frame={frame} />
          : ref.kind === 'agenda' || ref.kind === 'trazo' || ref.kind === 'calls' ? <SectionPane key={x} kind={ref.kind} frame={frame} />
          : <WaListPane key={x} frame={frame} />}
      </div>
    );
  };
  /** Los cuaditos: 1 → completo · 2 → lado a lado · 3 → dos arriba y uno abajo · 4 → 2×2 (al lado de otra página, uno sobre otro). */
  const body = (items: string[]) => {
    if (items.length === 0) {
      return (
        <div className="split n1 grid-empty">
          <div className="grid-empty-card">
            <div className="grid-glyph big" aria-hidden><i /><i /><i /><i /><i className="tall" /></div>
            <h2 className="serif">{t('grid.emptyTitle')}</h2>
            <p>{t('grid.emptyBody')}</p>
            <ul className="grid-empty-list">
              <li><b>{t('grid.toChat')}</b> {t('grid.toChatHow')}</li>
              <li><b>{t('grid.toSlot')}</b> {t('grid.toSlotHow')}</li>
              <li><b>{t('nav.issues')}</b> {t('grid.tasksColHow')}</li>
            </ul>
          </div>
        </div>
      );
    }
    if (items.length === 1) return <div className="split n1">{cell(items[0]!)}</div>;
    if (side) {
      return (
        <div className={`split n${items.length} is-side`} style={{ gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: `repeat(${items.length}, minmax(0, 1fr))` }}>
          {items.map(cell)}
        </div>
      );
    }
    return (
      <div className={`split n${items.length} ${mixedLayout || customLayout ? 'is-custom' : ''} ${customLayout && !expanded ? 'has-pane-spans' : ''} ${expanded ? 'is-expanded' : ''}`}
        style={customLayout ? { gridTemplateColumns: `repeat(${spanLayout.columns}, minmax(240px, 1fr))`, gridTemplateRows: `${sizes.row}fr ${1 - sizes.row}fr` }
          : mixedLayout ? { gridTemplateAreas: layout === 'tall-left' ? '"c a b" "d a b"' : layout === 'tall-right' ? '"a b c" "a b d"' : '"a c b" "a d b"', gridTemplateColumns: `${sizes.col * 2}fr 1fr ${(1 - sizes.col) * 2}fr`, gridTemplateRows: `${sizes.row}fr ${1 - sizes.row}fr` }
          : { gridTemplateColumns: `${sizes.col}fr ${1 - sizes.col}fr`, ...(items.length > 2 ? { gridTemplateRows: `${sizes.row}fr ${1 - sizes.row}fr` } : {}) }}>
        {items.map(cell)}
        {/* Divisiones que se arrastran para cambiar el tamaño (doble clic: mitad y mitad). */}
        {!expanded && !mixedLayout && !customLayout && <SplitHandle dir="col" at={sizes.col} />}
        {!expanded && !mixedLayout && !customLayout && items.length > 2 && <SplitHandle dir="row" at={sizes.row} />}
      </div>
    );
  };
  return (
    <div className="grid-workspace">
      {(expanded || (wide && list.length > 1)) && <div className="grid-layout-tools">
        {expanded ? <button className="btn small" onClick={collapsePane}>↙ {locale().startsWith('en') ? 'Back to grid' : 'Volver a la cuadrícula'}</button>
          : <><label>{locale().startsWith('en') ? 'Layout' : 'Diseño'} <select value={layout} onChange={(e) => setGridLayout(e.target.value as GridLayout)}>
            <option value="classic">{locale().startsWith('en') ? 'Classic' : 'Clásico'}</option>
            <option value="custom">{locale().startsWith('en') ? 'Custom panels' : 'Paneles a tu medida'}</option>
            <option value="tall-center">{locale().startsWith('en') ? '2 tall + 2 small (center)' : '2 largos + 2 pequeños (centro)'}</option>
            <option value="tall-left">{locale().startsWith('en') ? 'Small on left' : 'Pequeños a la izquierda'}</option>
            <option value="tall-right">{locale().startsWith('en') ? 'Small on right' : 'Pequeños a la derecha'}</option>
          </select></label>
          <details className="grid-pane-sizes"><summary>{locale().startsWith('en') ? 'Panel sizes' : 'Tamaño de paneles'}</summary>
            {arranged.map((key) => <label key={key}>{paneName(key)}<select aria-label={`${locale().startsWith('en') ? 'Height of' : 'Alto de'} ${paneName(key)}`}
              value={currentTall.includes(key) ? '2' : '1'} onChange={(e) => setPaneRows(key, +e.target.value as 1 | 2, currentTall)}>
              <option value="1">{locale().startsWith('en') ? '1 row' : '1 fila'}</option><option value="2">{locale().startsWith('en') ? '2 rows' : '2 filas'}</option>
            </select></label>)}
          </details>
          {customLayout && <label>{locale().startsWith('en') ? 'Height' : 'Alto'} <input aria-label={locale().startsWith('en') ? 'Small panels height' : 'Alto de paneles pequeños'} type="range" min="20" max="80" value={Math.round(sizes.row * 100)} onChange={(e) => setSplitSize({ row: +e.target.value / 100 }, true)} /></label>}
          {mixedLayout && <><label>{locale().startsWith('en') ? 'Width' : 'Ancho'} <input aria-label={locale().startsWith('en') ? 'Column width' : 'Ancho de columnas'} type="range" min="20" max="80" value={Math.round(sizes.col * 100)} onChange={(e) => setSplitSize({ col: +e.target.value / 100 }, true)} /></label>
            <label>{locale().startsWith('en') ? 'Height' : 'Alto'} <input aria-label={locale().startsWith('en') ? 'Small panels height' : 'Alto de paneles pequeños'} type="range" min="20" max="80" value={Math.round(sizes.row * 100)} onChange={(e) => setSplitSize({ row: +e.target.value / 100 }, true)} /></label>
            <details><summary>{locale().startsWith('en') ? 'Arrange panels' : 'Ordenar paneles'}</summary>{arranged.map((key, at) => <label key={key}>{parseKey(key).kind === 'chat' ? (d && known?.find((c) => c.id === key) ? conversationTitle(d, known.find((c) => c.id === key)!) : key.slice(0, 8)) : sectionLabel(key)}
              <select aria-label={locale().startsWith('en') ? 'Panel position' : 'Posición del panel'} value={at} onChange={(e) => moveLayoutPane(key, +e.target.value)}>{arranged.map((_, index) => <option key={index} value={index}>{index < 4 ? `${index + 1} · ${index < 2 ? (locale().startsWith('en') ? 'Tall' : 'Largo') : (locale().startsWith('en') ? 'Small' : 'Pequeño')}` : locale().startsWith('en') ? 'Saved panel' : 'Panel guardado'}</option>)}</select></label>)}</details>
          </>}
          {mixedLayout && arranged.slice(4).map((key) => <button key={key} className="btn small" onClick={() => moveLayoutPane(key, 3)}>{locale().startsWith('en') ? 'Show saved panel' : 'Mostrar panel guardado'} · {sectionLabel(key)}</button>)}</>}
      </div>}
      <div className={`split-root ${withTasks ? 'has-tasks' : ''} ${side ? 'is-side' : ''} ${drop ? 'is-dropping' : ''} ${expanded ? 'is-expanded' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="grid-main-body" hidden={expanded === TASKS_KEY && withTasks}>{body(grid)}</div>
      {withTasks && <div className="split-tasks" hidden={!!expanded && expanded !== TASKS_KEY}>{cell(TASKS_KEY)}</div>}
      {hint && <div className="split-drop" aria-hidden><span>⊞ {hint}</span></div>}
      </div>
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
