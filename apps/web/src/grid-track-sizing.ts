export interface PhysicalPaneColumns { start: number; end: number; width: number }

/** A virtual track may be narrow when it belongs to a wider panel. Bounds apply to the whole panel. */
export function columnDragLimits(widths: readonly number[], panes: readonly PhysicalPaneColumns[], index: number, minimumPaneWidth = 240) {
  let min = 16 - widths[index]!, max = widths[index + 1]! - 16;
  for (const pane of panes) {
    const left = pane.start <= index && pane.end >= index;
    const right = pane.start <= index + 1 && pane.end >= index + 1;
    if (left && !right) min = Math.max(min, Math.min(0, minimumPaneWidth - pane.width));
    if (right && !left) max = Math.min(max, Math.max(0, pane.width - minimumPaneWidth));
  }
  return { min, max };
}

/** Shared minimum scale preserves all physical panel widths as the viewport shrinks. */
export function paneColumnTracks(count: number, saved: readonly number[], cells: Readonly<Record<string, { column: number; width: number }>>, gap = 6) {
  const valid = saved.length === count && saved.every((n) => Number.isFinite(n) && n >= .0001 && n <= 1);
  const values = valid ? saved : Array.from({ length: count }, () => 1);
  const total = values.reduce((a, b) => a + b, 0);
  const fractions = values.map((n) => n / total);
  let minimum = 0;
  for (const cell of Object.values(cells)) {
    const share = fractions.slice(cell.column - 1, cell.column - 1 + cell.width).reduce((a, b) => a + b, 0);
    if (share > 0) minimum = Math.max(minimum, (240 - gap * (cell.width - 1)) / share);
  }
  return fractions.map((fraction) => ({ fraction, min: Math.max(16, fraction * minimum) }));
}
