import { describe, expect, it } from 'vitest';
import { firstUnread, readThroughVisible, isReadTransparentMessage } from '../src/chat-nav.ts';
describe('long unread history', () => {
  it('keeps requiring older pages beyond the former three-page limit', () => {
    for (const first of [451, 401, 351, 301, 251, 201, 151, 101, 51]) expect(firstUnread([{ seq: first }], 0, 500, true)).toBe('older');
    expect(firstUnread([{ seq: 1 }, { seq: 2 }], 0, 500, true)).toEqual({ seq: 1 });
    expect(firstUnread([], 0, 500, true)).toBe('older');
  });
  it('does not mark a skipped range when jumping to a mention or the end', () => {
    const seen = new Set<number>();
    expect(readThroughVisible(10, seen, [18, 19, 20])).toBe(10);
    expect(readThroughVisible(10, seen, [11, 12])).toBe(12);
    expect(readThroughVisible(12, seen, [13, 14, 15, 16, 17])).toBe(20);
    expect(seen.size).toBe(0);
  });
  it('accepts a read confirmed on another device without losing pending newer rows', () => {
    const seen = new Set([19, 20, 23]);
    expect(readThroughVisible(20, seen, [21])).toBe(21);
    expect(readThroughVisible(21, seen, [22])).toBe(23);
  });
});

it('only the thread marker is transparent, never an ordinary system or user message', () => {
  expect(isReadTransparentMessage({kind: 'system', body: '{"k":"derived.from"}'})).toBe(true);
  expect(isReadTransparentMessage({kind: 'text', body: '{"k":"derived.from"}'})).toBe(false);
  expect(isReadTransparentMessage({kind: 'system', body: '{"k":"issue.created"}'})).toBe(false);
});
