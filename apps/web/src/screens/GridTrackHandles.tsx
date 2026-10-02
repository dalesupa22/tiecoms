import { useEffect, useRef, useState, type RefObject } from 'react';
import { columnDragLimits, type PhysicalPaneColumns } from '../grid-track-sizing.ts';

interface Tracks { widths: number[]; heights: number[]; gap: number; panes: PhysicalPaneColumns[]; columnSegments: { index: number; top: number; height: number }[]; rowSegments: { left: number; width: number }[] }
const read = (el: HTMLElement): Tracks => {
  const style = getComputedStyle(el), r = el.getBoundingClientRect();
  const widths = style.gridTemplateColumns.split(' ').map(Number.parseFloat).filter(Number.isFinite);
  const heights = style.gridTemplateRows.split(' ').map(Number.parseFloat).filter(Number.isFinite);
  const gap = Number.parseFloat(style.gap) || 0;
  const boundary = r.top + (heights[0] ?? 0);
  const elements = Array.from(el.querySelectorAll<HTMLElement>(':scope > [data-pane]:not([hidden])'));
  const offsets = widths.map((_, i) => widths.slice(0, i).reduce((sum, w) => sum + w + gap, 0));
  const closest = (x: number, points: number[]) => points.reduce((best, n, i) => Math.abs(n - x) < Math.abs(points[best]! - x) ? i : best, 0);
  const panes = elements.map((pane) => { const box = pane.getBoundingClientRect(); return { start: closest(box.left - r.left + el.scrollLeft, offsets), end: closest(box.right - r.left + el.scrollLeft, offsets.map((x, i) => x + widths[i]!)), width: box.width }; });
  const columnSegments = widths.slice(0, -1).flatMap((_, index) => {
    const x = r.left + offsets[index]! + widths[index]! - el.scrollLeft;
    const intervals = elements.flatMap((pane) => { const p = pane.getBoundingClientRect(); return Math.abs(p.right - x) < 2 || Math.abs(p.left - x - gap) < 2 ? [{ top: p.top - r.top, bottom: p.bottom - r.top }] : []; }).sort((a, b) => a.top - b.top);
    const merged: { top: number; bottom: number }[] = [];
    for (const interval of intervals) { const last = merged.at(-1); if (last && interval.top <= last.bottom + gap) last.bottom = Math.max(last.bottom, interval.bottom); else merged.push({ ...interval }); }
    return merged.map((interval) => ({ index, top: interval.top, height: interval.bottom - interval.top }));
  });
  const rowSegments = elements.flatMap((pane) => {
    const p = pane.getBoundingClientRect();
    return heights.length === 2 && Math.abs(p.bottom - boundary) < 2 ? [{ left: p.left - r.left + el.scrollLeft, width: p.width }] : [];
  });
  return { widths, heights, gap, panes, columnSegments, rowSegments };
};

/** Pixel preview touches only the local grid style; the saved layout is committed once on release. */
export function GridTrackHandles({ root, revision, onCommit, en }: { root: RefObject<HTMLDivElement | null>; revision: string; onCommit: (widths: number[], row: number) => void; en: boolean }) {
  const [tracks, setTracks] = useState<Tracks>({ widths: [], heights: [], gap: 6, panes: [], columnSegments: [], rowSegments: [] });
  const stop = useRef<(() => void) | null>(null);
  const commit = useRef(onCommit); commit.current = onCommit;
  useEffect(() => {
    const el = root.current?.querySelector<HTMLElement>('.split'); if (!el) return;
    const measure = () => { if (!stop.current) setTracks(read(el)); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(el);
    return () => { observer.disconnect(); stop.current?.(); };
  }, [root, revision]);
  const adjust = (el: HTMLElement, axis: 'columns' | 'rows', index: number, delta: number, initial: Tracks) => {
    const widths = [...initial.widths], heights = [...initial.heights];
    if (axis === 'columns') {
      const total = widths[index]! + widths[index + 1]!;
      const limits = columnDragLimits(widths, initial.panes, index);
      widths[index] = widths[index]! + Math.min(limits.max, Math.max(limits.min, delta));
      widths[index + 1] = total - widths[index]!;
      el.style.gridTemplateColumns = widths.map((w) => `${w}px`).join(' ');
    } else {
      const total = heights[0]! + heights[1]!;
      const min = Math.min(total / 2, Math.max(120, total * .2));
      heights[0] = Math.min(total - min, Math.max(min, heights[0]! + delta));
      heights[1] = total - heights[0]!;
      el.style.gridTemplateRows = heights.map((h) => `${h}px`).join(' ');
    }
    return { widths, row: heights.length === 2 ? heights[0]! / (heights[0]! + heights[1]!) : .5 };
  };
  const start = (e: React.PointerEvent, axis: 'columns' | 'rows', index: number) => {
    if (e.button !== 0 || !e.isPrimary || stop.current) return;
    const el = root.current?.querySelector<HTMLElement>('.split'); if (!el) return;
    e.preventDefault(); e.stopPropagation();
    const handle = e.currentTarget as HTMLElement, initial = read(el), oldColumns = el.style.gridTemplateColumns, oldRows = el.style.gridTemplateRows;
    const origin = axis === 'columns' ? e.clientX : e.clientY;
    let delta = 0, frame = 0, result = { widths: initial.widths, row: initial.heights[0]! / (initial.heights.reduce((a, b) => a + b, 0)) };
    const draw = () => { frame = 0; result = adjust(el, axis, index, delta, initial); };
    const clean = () => {
      cancelAnimationFrame(frame); window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', other, true); handle.removeEventListener('lostpointercapture', cancel);
      el.style.gridTemplateColumns = oldColumns; el.style.gridTemplateRows = oldRows;
      document.body.classList.remove('is-pane-resizing'); stop.current = null;
      try { if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId); } catch { /* removed handle */ }
    };
    const cancel = () => clean();
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); clean(); } };
    const other = (ev: PointerEvent) => { if (ev.pointerId !== e.pointerId) clean(); };
    const move = (ev: PointerEvent) => { if (ev.pointerId !== e.pointerId) return; ev.preventDefault(); delta = (axis === 'columns' ? ev.clientX : ev.clientY) - origin; if (!frame) frame = requestAnimationFrame(draw); };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return; delta = (axis === 'columns' ? ev.clientX : ev.clientY) - origin;
      cancelAnimationFrame(frame); draw();
      // Capture geometry before removing the preview, so the caller can keep current pane locations.
      if (Math.abs(delta) >= 2 && el.isConnected) commit.current(result.widths, result.row);
      clean();
    };
    stop.current = cancel; document.body.classList.add('is-pane-resizing'); handle.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', move, { capture: true, passive: false }); window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true); window.addEventListener('blur', cancel); window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', other, true); handle.addEventListener('lostpointercapture', cancel);
  };
  const keyboard = (e: React.KeyboardEvent, axis: 'columns' | 'rows', index: number) => {
    const arrows = axis === 'columns' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (!arrows.includes(e.key) && e.key !== 'Home') return;
    e.preventDefault(); e.stopPropagation();
    const el = root.current?.querySelector<HTMLElement>('.split'); if (!el) return;
    const initial = read(el), oldColumns = el.style.gridTemplateColumns, oldRows = el.style.gridTemplateRows;
    const values = axis === 'columns' ? initial.widths : initial.heights;
    const delta = e.key === 'Home' ? (values[index + 1]! - values[index]!) / 2 : (e.key === arrows[0] ? -20 : 20);
    const result = adjust(el, axis, index, delta, initial); commit.current(result.widths, result.row);
    el.style.gridTemplateColumns = oldColumns; el.style.gridTemplateRows = oldRows;
  };
  return <>
    {tracks.columnSegments.map((segment, at) => { const i = segment.index, limits = columnDragLimits(tracks.widths, tracks.panes, i); return <div key={`c${i}-${at}`} className="grid-track-handle is-col" role="separator" tabIndex={0} aria-orientation="vertical" aria-valuenow={Math.round(tracks.widths[i]!)} aria-valuemin={Math.round(tracks.widths[i]! + limits.min)} aria-valuemax={Math.round(tracks.widths[i]! + limits.max)} aria-label={`${en ? 'Column width' : 'Ancho de columna'} ${i + 1}`} title={en ? 'Drag to set width · Arrow keys to adjust' : 'Arrastra para ajustar ancho · Flechas para ajustar'}
      style={{ left: tracks.widths.slice(0, i + 1).reduce((a, b) => a + b, 0) + tracks.gap * i, top: segment.top, height: segment.height, bottom: 'auto' }} onPointerDown={(e) => start(e, 'columns', i)} onKeyDown={(e) => keyboard(e, 'columns', i)} />; })}
    {tracks.rowSegments.map((segment, i) => <div key={`r${i}`} className="grid-track-handle is-row" role="separator" tabIndex={0} aria-orientation="horizontal" aria-valuenow={Math.round(tracks.heights[0]! / (tracks.heights[0]! + tracks.heights[1]!) * 100)} aria-valuemin={20} aria-valuemax={80} aria-label={en ? 'Row height' : 'Alto de filas'} title={en ? 'Drag to set height · Arrow keys to adjust' : 'Arrastra para ajustar alto · Flechas para ajustar'}
      style={{ top: tracks.heights[0], left: segment.left, width: segment.width }} onPointerDown={(e) => start(e, 'rows', 0)} onKeyDown={(e) => keyboard(e, 'rows', 0)} />)}
  </>;
}
