/** Two-row packing: tall panels keep a column; short panels share the next column. */
export function gridSpanLayout(keys: readonly string[], tall: ReadonlySet<string>) {
  let column = 1;
  let shortColumn: number | null = null;
  const cells: Record<string, { column: number; row: number; span: number }> = {};
  for (const key of keys) {
    if (tall.has(key)) cells[key] = { column: column++, row: 1, span: 2 };
    else if (shortColumn !== null) {
      cells[key] = { column: shortColumn, row: 2, span: 1 };
      shortColumn = null;
    } else {
      shortColumn = column++;
      cells[key] = { column: shortColumn, row: 1, span: 1 };
    }
  }
  return { cells, columns: Math.max(1, column - 1) };
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
