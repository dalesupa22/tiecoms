import { describe, expect, it } from 'vitest';
import { parseScheduleTime } from '../src/modules/mcp-schedule-time.ts';
const now = Date.parse('2026-10-04T23:30:00Z');

describe('MCP explicit schedule instant and IANA zone', () => {
  it('converts tomorrow 10am Bogota and returns the unambiguous wall clock', () => {
    expect(parseScheduleTime('2026-10-05T10:00:00-05:00', 'America/Bogota', true, now))
      .toEqual({ sendAt: '2026-10-05T15:00:00.000Z', timezone: 'America/Bogota', localSendAt: '2026-10-05T10:00:00' });
  });
  it('accepts UTC instants displayed in any IANA zone', () => {
    expect(parseScheduleTime('2026-10-05T15:00:00.000Z', 'America/Bogota', true, now).localSendAt).toBe('2026-10-05T10:00:00');
  });
  it.each(['2026-10-05T10:00:00', '2026-02-30T10:00:00Z', '2026-10-05T25:00:00Z', '2026-10-05T10:00:00+24:00'])('rejects malformed or normalized dates: %s', (date) => {
    expect(() => parseScheduleTime(date, 'America/Bogota', false)).toThrow();
  });
  it('rejects offset-zone disagreements and a DST spring gap', () => {
    expect(() => parseScheduleTime('2026-10-05T10:00:00-04:00', 'America/Bogota', false)).toThrow(/offset/);
    expect(() => parseScheduleTime('2027-03-14T02:30:00-05:00', 'America/New_York', false)).toThrow(/offset/);
  });
  it('keeps both explicitly disambiguated DST fall occurrences', () => {
    expect(parseScheduleTime('2026-11-01T01:30:00-04:00', 'America/New_York', false).sendAt).toBe('2026-11-01T05:30:00.000Z');
    expect(parseScheduleTime('2026-11-01T01:30:00-05:00', 'America/New_York', false).sendAt).toBe('2026-11-01T06:30:00.000Z');
  });
  it.each(['Mars/Olympus', '+05:00', ''])('rejects non-IANA zone %s', (zone) => {
    expect(() => parseScheduleTime('2026-10-05T15:00:00Z', zone, false)).toThrow(/IANA/);
  });
  it('enforces the 30-second and 366-day bounds only for new schedules', () => {
    expect(() => parseScheduleTime(new Date(now + 29_999).toISOString(), 'UTC', true, now)).toThrow(/30 segundos/);
    expect(parseScheduleTime(new Date(now + 30_000).toISOString(), 'UTC', true, now).sendAt).toBe('2026-10-04T23:30:30.000Z');
    expect(() => parseScheduleTime(new Date(now + 366 * 86_400_000 + 1).toISOString(), 'UTC', true, now)).toThrow(/366/);
    expect(parseScheduleTime('2020-01-01T10:00:00Z', 'UTC', false).sendAt).toBe('2020-01-01T10:00:00.000Z');
  });
});
