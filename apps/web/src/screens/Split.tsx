/**
 * La cuadrícula: hasta 4 paneles a la vez (split.ts). Un panel es un chat de chaggu, un correo o una conversación de WhatsApp.
 * Se arrastra una fila y se suelta aquí: con menos de 4 se abre al lado; con 4, reemplaza al panel donde se suelta
 * (los fijados no se reemplazan). Un correo o un mensaje de WhatsApp soltado sobre un chat se lleva a ese chat.
 * 1 → pantalla completa · 2 → lado a lado · 3 → dos arriba y uno abajo · 4 → cuadrícula 2×2.
 * Vive en /c/:id (el chat del URL es el activo) y en /cuadricula, y también al lado de WhatsApp y Correo.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
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
  useTallPanes, useWidePanes, setPaneSize, setGridGeometry, placeGridPane, usePanePositions, useGridColumnSizes, useMetas,
} from '../split.ts';
import { gridSpanLayout } from '../grid-span-layout.ts';
import { paneColumnTracks } from '../grid-track-sizing.ts';
import { collapseMany, collapseToDock, dockPanes, fillColumns, othersOf, pruneCollapsed, restoreAll, restoreFromDock, useCollapsed, visiblePanes } from '../grid-collapse.ts';
import { GridTrackHandles } from './GridTrackHandles.tsx';
import { usePaneGestures } from './usePaneGestures.ts';
import { ConversationScreen } from './Conversation.tsx';
import { ensureAssigned, openTintMenu, usePaneTints } from '../tints.ts';
import './GridDock.css';
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
  const widePanes = useWidePanes();
  const panePositions = usePanePositions();
  const columnSizes = useGridColumnSizes();
  const metas = useMetas();
  const wide = useWide();
  const d = useClient((s) => s.data);
  const known = d?.conversations;
  useEffect(() => { if (id) syncActive(id); }, [id]);
  const exists = (x: string) => parseKey(x).kind !== 'chat' || x === id || !!known?.some((c) => c.id === x);
  // En /c/:id, un solo panel guardado no esconde el chat abierto; en /cuadricula se ven todos, aunque sea uno.
  const shown = panes.filter(exists);
  const opened = wide && (id ? shown.length > 1 : shown.length > 0) ? shown : id ? [id] : shown.slice(0, 1);
  if (id && !opened.includes(id)) opened[0] = id;
  // Recogidos (grid-collapse.ts): siguen abiertos pero salen del dibujo y van a la barra de arriba.
  const collapsed = useCollapsed();
  const canCollapse = wide && opened.length > 1;
  const list = canCollapse ? visiblePanes(opened, collapsed) : opened;
  const docked = canCollapse ? dockPanes(opened, collapsed) : [];
  // El chat del URL siempre se ve: abrirlo lo saca de la barra.
  useEffect(() => { if (id) restoreFromDock(id); }, [id]);
  useEffect(() => { if (wide && d) pruneCollapsed(panes.filter(exists)); }, [panes.join('|'), wide, !!d]);
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
  const currentTall = customLayout ? tallPanes : mixedLayout ? arranged.slice(0, 2) : [...(hasTasks ? [TASKS_KEY] : []), ...(grid.length <= 2 ? grid : [])];
  const currentWide = customLayout ? widePanes : [];
  const packed = gridSpanLayout(arranged, new Set(currentTall), new Set(currentWide), customLayout && !docked.length ? panePositions : {});
  // Con recogidos, los demás se reacomodan y llenan el espacio libre (grid-collapse.ts).
  const spanLayout = docked.length ? { ...packed, cells: fillColumns(packed.cells) } : packed;
  // Translate presets to their visible column order before the first direct resize.
  const sizingOrder = mixedLayout
    ? (layout === 'tall-left' ? [arranged[2]!, arranged[3]!, arranged[0]!, arranged[1]!] : layout === 'tall-center' ? [arranged[0]!, arranged[2]!, arranged[3]!, arranged[1]!] : arranged.slice(0, 4)).concat(arranged.slice(4))
    : !customLayout && grid.length >= 4 ? [grid[0]!, grid[2]!, grid[1]!, grid[3]!, ...grid.slice(4), ...(withTasks ? [TASKS_KEY] : [])] : arranged;
  const resizePane = (key: string, rows: 1 | 2, columns: 1 | 2) => setPaneSize(key, rows, columns, currentTall, currentWide, [...new Set(sizingOrder)]);
  const gestureRoot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const split = gestureRoot.current?.querySelector<HTMLElement>('.split'); if (!split) return;
    // Wait for membership and active-key updates from the same operation to settle.
    const frame = requestAnimationFrame(() => {
      split.scrollLeft = 0;
      const selected = split.querySelector<HTMLElement>(':scope > .split-cell.is-active:not([hidden])');
      if (selected) {
        const box = selected.getBoundingClientRect(), viewport = split.getBoundingClientRect();
        if (box.right > viewport.right) split.scrollLeft += box.right - viewport.right;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [list.join('|')]);
  const gesturesEnabled = wide && !side && !expanded && list.length > 1;
  usePaneGestures(gestureRoot, { enabled: gesturesEnabled, order: list, tall: currentTall, wide: currentWide, en: locale().startsWith('en'),
    onResize: resizePane, onMove: (source, target, position) => {
      const visual = captureVisualLayout();
      const current = visual.positions;
      if (target && current[source] && current[target]) {
        position = current[target]!;
        current[target] = current[source]!;
      }
      if (current[source]?.column === position.column && current[source]?.row === position.row) return;
      placeGridPane(source, position, current, visual.tall, visual.wide, [...new Set(sizingOrder)], visual.widths);
    },
  });
  const captureVisualLayout = () => {
    const split = gestureRoot.current?.querySelector<HTMLElement>('.split');
    if (!split) return { positions: {}, tall: currentTall, wide: currentWide, widths: [] };
    const bounds = split.getBoundingClientRect(), css = getComputedStyle(split), gap = parseFloat(css.gap) || 0;
    const columns = css.gridTemplateColumns.split(' ').map(Number.parseFloat), heights = css.gridTemplateRows.split(' ').map(Number.parseFloat);
    const offsets = columns.map((_, i) => columns.slice(0, i).reduce((a, b) => a + b + gap, 0));
    const positions: Record<string, { column: number; row: number }> = {}, tall: string[] = [], wide: string[] = [];
    for (const pane of split.querySelectorAll<HTMLElement>(':scope > [data-pane]:not([hidden])')) {
      const key = pane.dataset.pane!, box = pane.getBoundingClientRect(), left = box.left - bounds.left + split.scrollLeft;
      const col = offsets.reduce((best, v, i) => Math.abs(v - left) < Math.abs(offsets[best]! - left) ? i : best, 0);
      positions[key] = { column: col + 1, row: box.top - bounds.top > heights[0]! - 2 ? 2 : 1 };
      if (heights.length === 1 || box.height > heights[0]! + gap) tall.push(key);
      if (box.width > columns[col]! + gap + 2) wide.push(key);
    }
    return { positions, tall, wide, widths: columns };
  };
  /** Alto completo a la izquierda, al centro o a la derecha: quienes estaban en esa columna pasan a la del panel. */
  const placeSide = (key: string, where: 'left' | 'center' | 'right') => {
    const visual = captureVisualLayout();
    const from = visual.positions[key];
    const columns = Math.max(1, visual.widths.length);
    const column = where === 'left' ? 1 : where === 'right' ? columns : Math.max(1, Math.ceil(columns / 2));
    const positions = { ...visual.positions };
    for (const [k, at] of Object.entries(positions)) {
      if (k === key || at.column !== column) continue;
      // Ceden su columna: pasan a la que deja el panel, o (si ya estaba ahí) se acomodan en el primer hueco libre.
      if (from && from.column !== column) positions[k] = { column: from.column, row: at.row }; else delete positions[k];
    }
    positions[key] = { column, row: 1 };
    const tall = [...new Set([...visual.tall, key])];
    // El que deja su columna y no tiene pareja abajo también queda de alto completo (sin huecos).
    for (const [k, at] of Object.entries(positions)) if (k !== key && at.column === from?.column && !Object.entries(positions).some(([o, p]) => o !== k && p.column === at.column)) { if (!tall.includes(k)) tall.push(k); positions[k] = { column: at.column, row: 1 }; }
    placeGridPane(key, { column, row: 1 }, positions, tall, visual.wide.filter((k) => k !== key), [...new Set(sizingOrder)], visual.widths);
  };
  const resizeTracks = (widths: number[], row: number) => {
    const { positions, tall, wide } = captureVisualLayout();
    setGridGeometry(positions, tall, wide, [...new Set(sizingOrder)], widths, row);
  };
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

  const classicCellStyle = (x: string): CSSProperties | undefined => {
    if (!withTasks || expanded) return undefined;
    if (x === TASKS_KEY) return { gridColumn: grid.length > 1 ? 3 : 2, gridRow: '1 / -1' };
    const at = grid.indexOf(x);
    return { gridColumn: grid.length === 3 && at === 2 ? '1 / span 2' : (at % 2) + 1, gridRow: grid.length <= 2 ? '1 / -1' : Math.floor(at / 2) + 1 };
  };
  const cell = (x: string) => {
    const ref = parseKey(x);
    const size = wide && !side && !expanded ? { rows: (currentTall.includes(x) ? 2 : 1) as 1 | 2, columns: (currentWide.includes(x) ? 2 : 1) as 1 | 2, set: (rows: 1 | 2, columns: 1 | 2) => resizePane(x, rows, columns), place: list.length > 1 ? (where: 'left' | 'center' | 'right') => placeSide(x, where) : undefined } : undefined;
    const frame = { size, onCollapse: canCollapse && list.length > 1 ? () => collapseToDock(x) : undefined, visible: expanded ? expanded === x : visible.includes(x), active: x === active, count: list.length, pinned: pinned.has(x), onClose: () => closePane(x, id), onOnly: () => onlyPane(x), onPin: () => togglePin(x), onTint: (el: HTMLElement) => openTintMenu(el, x) };
    return (
      <div key={x} data-pane={x} data-tint={tints[x]} hidden={expanded ? expanded !== x : !visible.includes(x)}
        style={!expanded && customLayout && list.length > 1 ? { gridColumn: `${spanLayout.cells[x]!.column} / span ${spanLayout.cells[x]!.width}`, gridRow: `${spanLayout.cells[x]!.row} / span ${spanLayout.cells[x]!.span}` }
          : mixedLayout && !expanded ? { gridArea: ['a', 'b', 'c', 'd'][arranged.indexOf(x)] } : classicCellStyle(x)}
        className={`split-cell ${pinned.has(x) ? 'is-pinned-pane' : ''} ${x === active ? 'is-active' : ''} ${drop && drop.over === x && (full || (chatOver(x) && fitsChat(drop.kind))) ? 'is-target' : ''}`}
        // Tocar un panel lo vuelve el activo (antes del clic, para que el clic siga funcionando adentro).
        onPointerDownCapture={() => { if (x !== active) focusPane(x); }}>
        {ref.kind === 'chat' ? <ConversationScreen key={list.length === 1 && x === id ? x + search : x} id={x} search={x === id ? search : ''} pane={list.length > 1 || !id ? frame : undefined} />
          : ref.kind === 'mail' ? <MailPane key={x} paneKey={x} provider={ref.provider} id={ref.id} frame={frame} />
          : ref.kind === 'wa' ? <WaPane key={x} paneKey={x} accountId={ref.accountId} jid={ref.jid} frame={frame} />
          : ref.kind === 'tasks' ? <TasksPane key={x} frame={frame} />
          : ref.kind === 'inbox' ? <InboxPane key={x} frame={frame} />
          : ref.kind === 'agenda' || ref.kind === 'trazo' || ref.kind === 'calls' ? <SectionPane key={x} kind={ref.kind} frame={frame} />
          : <WaListPane key={x} frame={frame} />}
        {gesturesEnabled && <>
          <div className="pane-resize-edge is-bottom" data-pane-resize="rows" title={locale().startsWith('en') ? 'Drag to change panel height' : 'Arrastra para cambiar el alto del panel'} aria-hidden />
          <div className="pane-resize-edge is-right" data-pane-resize="columns" title={locale().startsWith('en') ? 'Drag to change panel width' : 'Arrastra para cambiar el ancho del panel'} aria-hidden />
          <div className="pane-resize-corner" data-pane-resize="both" title={locale().startsWith('en') ? 'Drag to resize panel' : 'Arrastra para cambiar el tamaño del panel'} aria-hidden>◢</div>
        </>}
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
      <div className={`split n${items.length} ${withTasks ? 'has-tasks-inline' : ''} ${mixedLayout || customLayout ? 'is-custom' : ''} ${customLayout && !expanded ? 'has-pane-spans' : ''} ${expanded ? 'is-expanded' : ''}`}
        style={withTasks ? { gridTemplateColumns: grid.length > 1 ? `${sizes.col}fr ${1 - sizes.col}fr clamp(300px, 28%, 440px)` : 'minmax(0, 1fr) clamp(300px, 28%, 440px)', gridTemplateRows: grid.length > 2 ? `${sizes.row}fr ${1 - sizes.row}fr` : 'minmax(0, 1fr)' }
          : customLayout ? { gridTemplateColumns: paneColumnTracks(spanLayout.columns, columnSizes, spanLayout.cells).map((track) => `minmax(${track.min}px, ${track.fraction}fr)`).join(' '), gridTemplateRows: `${sizes.row}fr ${1 - sizes.row}fr` }
          : mixedLayout ? { gridTemplateAreas: layout === 'tall-left' ? '"c a b" "d a b"' : layout === 'tall-right' ? '"a b c" "a b d"' : '"a c b" "a d b"', gridTemplateColumns: `${sizes.col * 2}fr 1fr ${(1 - sizes.col) * 2}fr`, gridTemplateRows: `${sizes.row}fr ${1 - sizes.row}fr` }
          : { gridTemplateColumns: `${sizes.col}fr ${1 - sizes.col}fr`, ...(items.length > 2 ? { gridTemplateRows: `${sizes.row}fr ${1 - sizes.row}fr` } : {}) }}>
        {items.map(cell)}
        {/* Divisiones que se arrastran para cambiar el tamaño (doble clic: mitad y mitad). */}
        {gesturesEnabled && <GridTrackHandles root={gestureRoot} revision={`${layout}|${list.join('|')}|${order.join('|')}|${tallPanes.join('|')}|${widePanes.join('|')}|${JSON.stringify(panePositions)}|${columnSizes.join('|')}|${sizes.row}`} onCommit={resizeTracks} en={locale().startsWith('en')} />}
      </div>
    );
  };
  return (
    <div className="grid-workspace">
      {docked.length > 0 && !expanded && <GridDock keys={docked} name={paneName} unread={(k) => known?.find((c) => c.id === k)?.unread ?? 0} tints={tints} />}
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
              value={currentTall.includes(key) ? '2' : '1'} onChange={(e) => resizePane(key, +e.target.value as 1 | 2, currentWide.includes(key) ? 2 : 1)}>
              <option value="1">{locale().startsWith('en') ? '1 row' : '1 fila'}</option><option value="2">{locale().startsWith('en') ? '2 rows' : '2 filas'}</option>
            </select><select aria-label={`${locale().startsWith('en') ? 'Width of' : 'Ancho de'} ${paneName(key)}`} value={currentWide.includes(key) ? '2' : '1'} onChange={(e) => resizePane(key, currentTall.includes(key) ? 2 : 1, +e.target.value as 1 | 2)}><option value="1">{locale().startsWith('en') ? '1 column' : '1 columna'}</option><option value="2">{locale().startsWith('en') ? '2 columns' : '2 columnas'}</option></select></label>)}
          </details>
          {list.length > 2 && active && <button className="btn small grid-collapse-others" title={locale().startsWith('en') ? 'Leave only the active panel; the rest go to the bar above' : 'Deja solo el panel activo; los demás quedan en la barra de arriba'} onClick={() => collapseMany(othersOf(list, active))}>▁ {locale().startsWith('en') ? 'Tuck away the rest' : 'Recoger los demás'}</button>}
          {customLayout && <label>{locale().startsWith('en') ? 'Height' : 'Alto'} <input aria-label={locale().startsWith('en') ? 'Small panels height' : 'Alto de paneles pequeños'} type="range" min="20" max="80" value={Math.round(sizes.row * 100)} onChange={(e) => setSplitSize({ row: +e.target.value / 100 }, true)} /></label>}
          {mixedLayout && <><label>{locale().startsWith('en') ? 'Width' : 'Ancho'} <input aria-label={locale().startsWith('en') ? 'Column width' : 'Ancho de columnas'} type="range" min="20" max="80" value={Math.round(sizes.col * 100)} onChange={(e) => setSplitSize({ col: +e.target.value / 100 }, true)} /></label>
            <label>{locale().startsWith('en') ? 'Height' : 'Alto'} <input aria-label={locale().startsWith('en') ? 'Small panels height' : 'Alto de paneles pequeños'} type="range" min="20" max="80" value={Math.round(sizes.row * 100)} onChange={(e) => setSplitSize({ row: +e.target.value / 100 }, true)} /></label>
            <details><summary>{locale().startsWith('en') ? 'Arrange panels' : 'Ordenar paneles'}</summary>{arranged.map((key, at) => <label key={key}>{parseKey(key).kind === 'chat' ? (d && known?.find((c) => c.id === key) ? conversationTitle(d, known.find((c) => c.id === key)!) : key.slice(0, 8)) : sectionLabel(key)}
              <select aria-label={locale().startsWith('en') ? 'Panel position' : 'Posición del panel'} value={at} onChange={(e) => moveLayoutPane(key, +e.target.value)}>{arranged.map((_, index) => <option key={index} value={index}>{index < 4 ? `${index + 1} · ${index < 2 ? (locale().startsWith('en') ? 'Tall' : 'Largo') : (locale().startsWith('en') ? 'Small' : 'Pequeño')}` : locale().startsWith('en') ? 'Saved panel' : 'Panel guardado'}</option>)}</select></label>)}</details>
          </>}
          {mixedLayout && arranged.slice(4).map((key) => <button key={key} className="btn small" onClick={() => moveLayoutPane(key, 3)}>{locale().startsWith('en') ? 'Show saved panel' : 'Mostrar panel guardado'} · {sectionLabel(key)}</button>)}</>}
      </div>}
      <div ref={gestureRoot} className={`split-root ${gesturesEnabled ? 'has-pane-gestures' : ''} ${side ? 'is-side' : ''} ${drop ? 'is-dropping' : ''} ${expanded ? 'is-expanded' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="grid-main-body">{body(list)}</div>
      {hint && <div className="split-drop" aria-hidden><span>⊞ {hint}</span></div>}
      </div>
    </div>
  );
}

/** La barra de recogidos: una pestaña por panel; un clic lo devuelve a la cuadrícula. */
function GridDock({ keys, name, unread, tints }: { keys: string[]; name: (k: string) => string; unread: (k: string) => number; tints: Record<string, string | undefined> }) {
  const en = locale().startsWith('en');
  return (
    <div className="grid-dock" role="toolbar" aria-label={en ? 'Tucked-away panels' : 'Paneles recogidos'}>
      <span className="grid-dock-label">{en ? 'Tucked away' : 'Recogidos'} · {keys.length}</span>
      {keys.map((k) => {
        const n = unread(k);
        return <button key={k} className="grid-dock-chip" data-tint={tints[k]} title={en ? 'Show in the grid' : 'Mostrar en la cuadrícula'} onClick={() => { restoreFromDock(k); focusPane(k); }}>
          <span className="ellipsis">{name(k)}</span>{n > 0 && <span className="grid-dock-unread">{n > 99 ? '99+' : n}</span>}<span aria-hidden className="grid-dock-up">▴</span>
        </button>;
      })}
      <span className="grow" />
      <button className="btn ghost small" onClick={restoreAll}>▴ {en ? 'Show all' : 'Mostrar todos'}</button>
    </div>
  );
}
