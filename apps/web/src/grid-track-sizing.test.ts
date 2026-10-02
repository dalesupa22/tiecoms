import { describe, expect, it } from 'vitest';
import { columnDragLimits, paneColumnTracks } from './grid-track-sizing.ts';

describe('physical panel width constraints', () => {
  const cells = { adriana: { column: 1, width: 2 }, valentina: { column: 3, width: 2 }, tasks: { column: 5, width: 1 } };
  it('lets a two-column panel yield 100px to Tasks while every panel remains readable', () => {
    const widths = [269, 269, 269, 269, 269];
    const limits = columnDragLimits(widths, [{ start: 0, end: 1, width: 544 }, { start: 2, end: 3, width: 544 }, { start: 4, end: 4, width: 269 }], 3);
    expect(limits.min).toBeLessThanOrEqual(-100);
    expect(limits.max).toBe(29);
    expect(269 - 100).toBeGreaterThan(16);
    expect(544 - 100).toBeGreaterThan(240);
  });
  it('protects a small pane on another row even if its neighbor spans two columns', () => {
    expect(columnDragLimits([269, 269, 269], [{ start: 0, end: 1, width: 544 }, { start: 1, end: 1, width: 269 }, { start: 2, end: 2, width: 269 }], 1)).toEqual({ min: -29, max: 29 });
  });
  it('keeps saved virtual tracks narrow and constrains full panels on viewport shrink', () => {
    const saved = [269, 269, 269, 169, 369].map((n) => n / 1345);
    const tracks = paneColumnTracks(5, saved, cells);
    expect(tracks[3]!.min).toBeLessThan(169);
    for (const cell of Object.values(cells)) {
      const minimum = tracks.slice(cell.column - 1, cell.column - 1 + cell.width).reduce((n, t) => n + t.min, 0) + (cell.width - 1) * 6;
      expect(minimum).toBeGreaterThanOrEqual(240 - .001);
    }
    expect(tracks.reduce((n, t) => n + t.min, 0) + 24).toBeLessThan(1369);
  });
  it('ignores corrupt persisted track fractions', () => {
    expect(paneColumnTracks(5, [0, -1, NaN, Infinity, .3], cells)).toEqual(paneColumnTracks(5, [], cells));
  });
});
