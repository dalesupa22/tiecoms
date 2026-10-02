import { useEffect, useRef, type RefObject } from 'react';
import type { PanePosition } from '../grid-span-layout.ts';
import { PANE_DRAG_DISTANCE, PANE_TOUCH_HOLD_MS, paneResizeFromDelta, type PaneExtent, type PaneResizeAxis } from '../grid-gestures.ts';

interface GestureOptions {
  enabled: boolean;
  order: readonly string[];
  tall: readonly string[];
  wide: readonly string[];
  en: boolean;
  onMove: (source: string, target: string | null, position: PanePosition) => void;
  onResize: (key: string, rows: PaneExtent, columns: PaneExtent) => void;
}
const interactive = 'button,a,input,textarea,select,label,[contenteditable="true"],[role="button"],[role="menuitem"],[draggable="true"]';
const primaryHeader = ':scope > .conv > .conv-main > .conv-head, :scope > .pane-typed > .pane-head, :scope > .section-pane > .pane-head';

/** Delegated pointer gestures never reorder DOM or update external state before pointerup. */
export function usePaneGestures(root: RefObject<HTMLDivElement | null>, options: GestureOptions) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const el = root.current;
    if (!el || !options.enabled) return;
    let cancel: (() => void) | null = null;
    let suppressClick = false;
    let suppressTimer: ReturnType<typeof setTimeout> | undefined;
    const click = (e: MouseEvent) => { if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; } };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !e.isPrimary || cancel) return;
      const target = e.target instanceof Element ? e.target : null;
      const pane = target?.closest<HTMLElement>('[data-pane]');
      const key = pane?.dataset.pane;
      if (!pane || !key || !el.contains(pane)) return;
      const handle = target?.closest<HTMLElement>('[data-pane-resize]');
      const header = target?.closest<HTMLElement>('.conv-head,.pane-head');
      if (!handle && (!header || header !== pane.querySelector(primaryHeader) || target?.closest(interactive))) return;
      // A second touch is a cancellation, never a second resize operation.
      const config = latest.current;
      const axis = handle?.dataset.paneResize as PaneResizeAxis | undefined;
      const box = pane.getBoundingClientRect();
      const rows: PaneExtent = config.tall.includes(key) ? 2 : 1;
      const columns: PaneExtent = config.wide.includes(key) ? 2 : 1;
      let size = { rows, columns }, over: string | null = null, position: PanePosition | null = null;
      let active = false, lastX = e.clientX, lastY = e.clientY, frame = 0;
      let hold: ReturnType<typeof setTimeout> | undefined;
      let overlay: HTMLDivElement | null = null;
      const capture = handle ?? header!;
      const touch = e.pointerType === 'touch';
      const draw = () => {
        frame = 0;
        if (!active || !overlay) return;
        if (axis) {
          size = paneResizeFromDelta(rows, columns, lastX - e.clientX, lastY - e.clientY, box.width, box.height, axis);
          const gridBox = el.getBoundingClientRect();
          const height = size.rows === rows ? box.height : size.rows === 2 ? gridBox.height : gridBox.height / 2;
          const width = box.width * size.columns / columns;
          Object.assign(overlay.style, { left: `${box.left}px`, top: `${size.rows === 2 ? gridBox.top : box.top}px`, width: `${Math.min(width, innerWidth - box.left)}px`, height: `${height}px` });
          overlay.textContent = `${size.columns} ${config.en ? (size.columns === 1 ? 'column' : 'columns') : (size.columns === 1 ? 'columna' : 'columnas')} · ${size.rows} ${config.en ? (size.rows === 1 ? 'row' : 'rows') : (size.rows === 1 ? 'fila' : 'filas')}`;
        } else {
          const hit = document.elementFromPoint(lastX, lastY)?.closest<HTMLElement>('[data-pane]');
          over = hit && el.contains(hit) && hit !== pane ? hit.dataset.pane ?? null : null;
          const split = pane.parentElement!;
          const r = split.getBoundingClientRect(), style = getComputedStyle(split);
          const widths = style.gridTemplateColumns.split(' ').map(Number.parseFloat);
          const heights = style.gridTemplateRows.split(' ').map(Number.parseFloat);
          const gap = Number.parseFloat(style.gap) || 0;
          const localX = lastX - r.left + split.scrollLeft, localY = lastY - r.top;
          const track = (lengths: number[], point: number) => { let at = 0; for (let i = 0; i < lengths.length; i++) { if (point <= at + lengths[i]! + gap / 2) return i; at += lengths[i]! + gap; } return lengths.length - 1; };
          let col = track(widths, localX), row = rows === 2 ? 0 : track(heights, localY);
          if (over) {
            const targetBox = hit!.getBoundingClientRect();
            col = track(widths, targetBox.left - r.left + split.scrollLeft + 1);
            row = rows === 2 ? 0 : track(heights, targetBox.top - r.top + 1);
          }
          position = lastX >= r.left && lastX <= r.right && lastY >= r.top && lastY <= r.bottom ? { column: col + 1, row: row + 1 } : null;
          const preview = position ? {
            left: r.left + widths.slice(0, col).reduce((a, b) => a + b + gap, 0) - split.scrollLeft,
            top: r.top + heights.slice(0, row).reduce((a, b) => a + b + gap, 0),
            width: widths.slice(col, col + columns).reduce((a, b) => a + b, 0) + gap * (columns - 1),
            height: rows === 2 ? r.height : heights[row]!,
          } : box;
          Object.assign(overlay.style, { left: `${preview.left}px`, top: `${preview.top}px`, width: `${preview.width}px`, height: `${preview.height}px` });
          overlay.textContent = position ? (config.en ? 'Release to move here' : 'Suelta para mover aquí') : (config.en ? 'Move onto the grid' : 'Lleva el panel a la cuadrícula');
        }
      };
      const activate = () => {
        if (active) return;
        active = true;
        pane.classList.add('is-gesturing');
        document.body.classList.add(axis ? 'is-pane-resizing' : 'is-pane-moving');
        overlay = document.createElement('div');
        overlay.className = 'pane-gesture-preview';
        overlay.setAttribute('role', 'status');
        document.body.append(overlay);
        try { capture.setPointerCapture(e.pointerId); } catch { /* the pointer may already have ended */ }
        draw();
      };
      const cleanup = () => {
        clearTimeout(hold);
        cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', abort, true);
        window.removeEventListener('pointerdown', additionalPointer, true);
        window.removeEventListener('keydown', keydown, true);
        window.removeEventListener('blur', abort);
        capture.removeEventListener('lostpointercapture', abort);
        pane.classList.remove('is-gesturing');
        document.body.classList.remove('is-pane-resizing', 'is-pane-moving');
        overlay?.remove();
        try { if (capture.hasPointerCapture(e.pointerId)) capture.releasePointerCapture(e.pointerId); } catch { /* removed pane */ }
        if (active) { suppressClick = true; clearTimeout(suppressTimer); suppressTimer = setTimeout(() => { suppressClick = false; }, 0); }
        cancel = null;
      };
      const abort = () => cleanup();
      const additionalPointer = (ev: PointerEvent) => { if (ev.pointerId !== e.pointerId) abort(); };
      const keydown = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); abort(); } };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        lastX = ev.clientX; lastY = ev.clientY;
        const moved = Math.hypot(lastX - e.clientX, lastY - e.clientY) >= PANE_DRAG_DISTANCE;
        if (!active && moved) { if (touch && !axis) { abort(); return; } activate(); }
        if (!active) return;
        ev.preventDefault();
        if (!frame) frame = requestAnimationFrame(draw);
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        if (active) { lastX = ev.clientX; lastY = ev.clientY; cancelAnimationFrame(frame); draw(); }
        const valid = active && pane.isConnected && latest.current.order.includes(key);
        cleanup();
        if (!valid) return;
        ev.preventDefault(); ev.stopPropagation();
        if (axis && (size.rows !== rows || size.columns !== columns)) config.onResize(key, size.rows, size.columns);
        else if (!axis && position && (!over || latest.current.order.includes(over))) config.onMove(key, over, position);
      };
      cancel = abort;
      window.addEventListener('pointermove', move, { capture: true, passive: false });
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', abort, true);
      window.addEventListener('pointerdown', additionalPointer, true);
      window.addEventListener('keydown', keydown, true);
      window.addEventListener('blur', abort);
      capture.addEventListener('lostpointercapture', abort);
      if (axis) e.preventDefault();
      else if (touch) hold = setTimeout(activate, PANE_TOUCH_HOLD_MS);
    };
    const nativeDrag = (e: DragEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const pane = target?.closest<HTMLElement>('[data-pane]'), header = target?.closest('.conv-head,.pane-head');
      if (pane && header === pane.querySelector(primaryHeader) && !target?.closest(interactive)) e.preventDefault();
    };
    el.addEventListener('dragstart', nativeDrag, true);
    el.addEventListener('pointerdown', down);
    el.addEventListener('click', click, true);
    return () => { cancel?.(); clearTimeout(suppressTimer); el.removeEventListener('dragstart', nativeDrag, true); el.removeEventListener('pointerdown', down); el.removeEventListener('click', click, true); };
  }, [root, options.enabled, options.order.join('|')]);
}
