export interface PanePosition { column: number; row: number }
export function sanitizePanePositions(value: unknown, keys: readonly string[]): Record<string, PanePosition> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(keys.slice(0, 5).flatMap((key) => {
    const at = (value as Record<string, PanePosition>)[key];
    return at && Number.isInteger(at.column) && at.column >= 1 && at.column <= 10 && (at.row === 1 || at.row === 2) ? [[key, { column: at.column, row: at.row }]] : [];
  }));
}

/** Two-row packing: tall panels keep a column; short panels share the next column. */
export function gridSpanLayout(keys: readonly string[], tall: ReadonlySet<string>, wide: ReadonlySet<string> = new Set(), positions: Readonly<Record<string, PanePosition>> = {}) {
  let columns = 1;
  const occupied = new Set<string>();
  const cells: Record<string, { column: number; row: number; span: number; width: number }> = {};
  const place = (key: string, column: number, row: number) => {
    const span = tall.has(key) ? 2 : 1, width = wide.has(key) ? 2 : 1;
    if (!Number.isInteger(column) || column < 1 || column + width - 1 > 10 || !Number.isInteger(row) || row < 1 || row + span > 3) return false;
    const slots = Array.from({ length: width * span }, (_, i) => `${column + i % width}:${row + Math.floor(i / width)}`);
    if (slots.some((slot) => occupied.has(slot))) return false;
    slots.forEach((slot) => occupied.add(slot)); cells[key] = { column, row, span, width };
    columns = Math.max(columns, column + width - 1); return true;
  };
  // Explicit empty-cell drops may leave intentional holes. Reserve them before packing others.
  for (const key of keys) {
    const at = positions[key];
    if (at) place(key, at.column, tall.has(key) ? 1 : at.row);
  }
  for (const key of keys) {
    if (cells[key]) continue;
    const span = tall.has(key) ? 2 : 1, width = wide.has(key) ? 2 : 1;
    // Fill each column before moving right, so two short panels share one column.
    let placed = false;
    for (let column = 1; !placed; column++) for (let row = 1; row <= 3 - span; row++) {
      const slots = Array.from({ length: width * span }, (_, i) => `${column + i % width}:${row + Math.floor(i / width)}`);
      if (slots.some((slot) => occupied.has(slot))) continue;
      slots.forEach((slot) => occupied.add(slot));
      cells[key] = { column, row, span, width };
      columns = Math.max(columns, column + width - 1);
      placed = true; break;
    }
  }
  return { cells, columns };
}

/** Translate an explicit drop without shuffling unrelated visual positions. */
export function layoutAfterPlacement(order: readonly string[], before: readonly string[], after: readonly string[], key: string, index: number) {
  const prior = [...order.filter((k) => before.includes(k)), ...before.filter((k) => !order.includes(k))];
  const free = index >= before.filter((k) => k !== 'tasks:').length;
  const moved = free || key === 'tasks:'
    ? [...prior.filter((k) => k !== key), key]
    : prior.map((k) => { const at = before.indexOf(k); return at >= 0 ? after[at] ?? k : k; });
  return [...new Set([...moved.filter((k) => after.includes(k)), ...after])];
}
