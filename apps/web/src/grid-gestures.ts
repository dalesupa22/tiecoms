export type PaneExtent = 1 | 2;
export type PaneResizeAxis = 'rows' | 'columns' | 'both';
export const PANE_DRAG_DISTANCE = 7;
export const PANE_TOUCH_HOLD_MS = 320;

/** Keep gestures local until release; tiny pointer movements never alter a saved layout. */
export function paneResizeFromDelta(rows: PaneExtent, columns: PaneExtent, dx: number, dy: number, width: number, height: number, axis: PaneResizeAxis) {
  const threshold = (extent: number) => Math.max(28, Math.min(100, extent * .22));
  const snap = (span: PaneExtent, delta: number, unit: number): PaneExtent => Math.abs(delta) < threshold(unit) ? span : delta > 0 ? 2 : 1;
  return {
    rows: axis === 'columns' ? rows : snap(rows, dy, height / rows),
    columns: axis === 'rows' ? columns : snap(columns, dx, width / columns),
  };
}
