import { describe, expect, it } from 'vitest';
import { layoutTimedDay, timedDaySegments, timedHourRange } from '../src/calendar-event-layout.ts';
const day = new Date(2026, 9, 1);
const event = (id: string, hour: number, minute: number, duration: number) => {
  const start = new Date(2026, 9, 1, hour, minute);
  return { id, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + duration * 60_000).toISOString() };
};
describe('timed calendar event layout', () => {
  it('short targets remain readable and nearby short targets never obscure each other', () => {
    const input = [event('a', 9, 0, 5), event('b', 9, 10, 5), event('c', 9, 20, 5)];
    const placed = layoutTimedDay(input, day);
    expect(placed.every((p) => p.compact && p.height >= 28)).toBe(true);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!, b = placed[j]!;
      if (a.column === b.column) expect(a.top + a.height).toBeLessThanOrEqual(b.top);
    }
    expect(input[0]!.endsAt).toBe(event('a', 9, 0, 5).endsAt);
  });
  it('overlapping cluster uses columns, later independent meeting regains full width', () => {
    const placed = layoutTimedDay([event('a', 9, 0, 120), event('b', 9, 0, 60), event('c', 10, 0, 60), event('d', 14, 0, 60)], day);
    expect(placed.filter((p) => p.event.id !== 'd').map((p) => p.columns)).toEqual([2, 2, 2]);
    expect(placed.find((p) => p.event.id === 'd')?.columns).toBe(1);
    expect(placed.find((p) => p.event.id === 'b')?.column).toBe(placed.find((p) => p.event.id === 'c')?.column);
  });
  it('numeric instants and deterministic ties avoid comparing mixed ISO offsets lexically', () => {
    const start = new Date(2026, 9, 1, 9);
    const e = event('z', 9, 0, 60);
    const inOffset = (iso: string) => new Date(Date.parse(iso) + 2 * 3_600_000).toISOString().replace('Z', '+02:00');
    const same = { ...e, id: 'a', startsAt: inOffset(e.startsAt), endsAt: inOffset(e.endsAt) };
    expect(Date.parse(same.startsAt)).toBe(start.getTime());
    expect(layoutTimedDay([e, same], day).map((p) => p.event.id)).toEqual(['a', 'z']);
  });
  it('clips overnight events per calendar day without changing their original times', () => {
    const input = { id: 'night', startsAt: new Date(2026, 8, 30, 23, 30).toISOString(), endsAt: new Date(2026, 9, 1, 1).toISOString() };
    const segment = timedDaySegments([input], day)[0]!;
    expect(segment.startMinute).toBe(0); expect(segment.endMinute).toBe(60);
    expect(segment.continuesBefore).toBe(true); expect(segment.continuesAfter).toBe(false);
    expect(segment.event).toBe(input);
    const last = timedDaySegments([{ ...input, endsAt: new Date(2026, 9, 2, 2).toISOString() }], day)[0]!;
    expect(last.endMinute).toBe(1440); expect(last.continuesAfter).toBe(true);
  });
  it('keeps default hours and extends for early/late meetings, rejects invalid durations', () => {
    expect(timedHourRange([day], [])).toEqual({ startHour: 7, endHour: 21 });
    expect(timedHourRange([day], [event('early', 6, 15, 30), event('late', 23, 50, 5)])).toEqual({ startHour: 6, endHour: 24 });
    expect(timedDaySegments([{ id: 'bad', startsAt: 'bad', endsAt: 'bad' }, { ...event('zero', 9, 0, 0) }], day)).toEqual([]);
  });
});
