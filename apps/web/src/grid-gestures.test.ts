import { describe, expect, it } from 'vitest';
import { paneResizeFromDelta } from './grid-gestures.ts';

describe('direct panel gestures', () => {
  it('requires deliberate movement before snapping and ignores the other axis', () => {
    expect(paneResizeFromDelta(1, 1, 12, 12, 500, 400, 'both')).toEqual({ rows: 1, columns: 1 });
    expect(paneResizeFromDelta(1, 1, 300, 130, 500, 400, 'rows')).toEqual({ rows: 2, columns: 1 });
    expect(paneResizeFromDelta(1, 1, 130, 300, 500, 400, 'columns')).toEqual({ rows: 1, columns: 2 });
  });
  it('grows to two rows/columns and shrinks using the same handle without unbounded spans', () => {
    expect(paneResizeFromDelta(1, 1, 300, 300, 500, 400, 'both')).toEqual({ rows: 2, columns: 2 });
    expect(paneResizeFromDelta(2, 2, -300, -300, 1000, 800, 'both')).toEqual({ rows: 1, columns: 1 });
    expect(paneResizeFromDelta(2, 2, 9999, 9999, 1000, 800, 'both')).toEqual({ rows: 2, columns: 2 });
  });
});
