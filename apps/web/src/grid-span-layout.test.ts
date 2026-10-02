import { describe, expect, it } from 'vitest';
import { gridSpanLayout, layoutAfterPlacement } from './grid-span-layout.ts';

describe('two-row pane layout', () => {
  it('fits Agenda and Tasks tall beside two short chats', () => {
    const layout = gridSpanLayout(['wa', 'agenda:', 'chat', 'tasks:'], new Set(['agenda:', 'tasks:']));
    expect(layout.columns).toBe(3);
    expect(layout.cells['agenda:']).toEqual({ column: 2, row: 1, span: 2 });
    expect(layout.cells['tasks:']).toEqual({ column: 3, row: 1, span: 2 });
    expect(layout.cells.chat).toEqual({ column: 1, row: 2, span: 1 });
  });
  it('keeps every pane without overlapping for every supported span combination', () => {
    const keys = ['one', 'two', 'three', 'four', 'tasks:'];
    for (let length = 1; length <= keys.length; length++) for (let mask = 0; mask < (1 << length); mask++) {
      const panes = keys.slice(0, length);
      const layout = gridSpanLayout(panes, new Set(panes.filter((_, i) => mask & (1 << i))));
      const occupied = new Set<string>();
      expect(Object.keys(layout.cells)).toEqual(panes);
      for (const cell of Object.values(layout.cells)) for (let row = cell.row; row < cell.row + cell.span; row++) {
        const slot = `${cell.column}:${row}`;
        expect(occupied.has(slot)).toBe(false);
        occupied.add(slot);
        expect(row).toBeLessThanOrEqual(2);
        expect(cell.column).toBeLessThanOrEqual(layout.columns);
      }
    }
  });
  it('keeps unrelated visual order for moves or additions into a free slot', () => {
    expect(layoutAfterPlacement(['b','a','c'], ['a','b','c'], ['b','c','a'], 'a', 3)).toEqual(['b','c','a']);
    expect(layoutAfterPlacement(['tasks:','b','a'], ['a','b','tasks:'], ['a','b','x','tasks:'], 'x', 3)).toEqual(['tasks:','b','a','x']);
  });
  it('swaps occupied visual slots and retains unrelated tasks and heights', () => {
    expect(layoutAfterPlacement(['b','a','c','tasks:'], ['a','b','c','tasks:'], ['c','b','a','tasks:'], 'c', 0)).toEqual(['b','c','a','tasks:']);
    expect(layoutAfterPlacement(['tasks:','b','a'], ['a','b','tasks:'], ['a','x','tasks:'], 'x', 1)).toEqual(['tasks:','x','a']);
  });
});
