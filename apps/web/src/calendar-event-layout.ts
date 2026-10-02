import { addDays, startOfDay } from './calendar-grid.ts';

export interface TimedEvent { id: string; startsAt: string; endsAt: string }
export interface DaySegment<E extends TimedEvent> {
  event: E;
  startMinute: number;
  endMinute: number;
  startsAt: Date;
  endsAt: Date;
  continuesBefore: boolean;
  continuesAfter: boolean;
}
export interface EventPlacement<E extends TimedEvent> extends DaySegment<E> {
  top: number;
  height: number;
  compact: boolean;
  column: number;
  columns: number;
}
export const CAL_EVENT_MIN_HEIGHT = 28;
export const CAL_EVENT_MIN_COLUMN = 160;
const minutes = (at: Date) => at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60;

/** Visible part of an event in the browser's calendar day. Original UTC instants stay untouched. */
export function timedDaySegments<E extends TimedEvent>(events: readonly E[], day: Date): DaySegment<E>[] {
  const from = startOfDay(day), to = addDays(from, 1), low = from.getTime(), high = to.getTime();
  return events.flatMap((event) => {
    const start = Date.parse(event.startsAt), end = Date.parse(event.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start >= high || end <= low) return [];
    const startsAt = new Date(Math.max(start, low)), endsAt = new Date(Math.min(end, high));
    const startMinute = start <= low ? 0 : minutes(startsAt);
    const wallEnd = end >= high ? 1440 : minutes(endsAt);
    // A repeated DST hour may move the wall clock backwards; retain the positive real duration.
    const endMinute = wallEnd > startMinute ? wallEnd : Math.min(1440, startMinute + (endsAt.getTime() - startsAt.getTime()) / 60_000);
    return [{ event, startsAt, endsAt, startMinute, endMinute, continuesBefore: start < low, continuesAfter: end > high }];
  }).sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute || a.event.id.localeCompare(b.event.id));
}

/** Keep the usual 07–21 range, extending only when an existing timed meeting requires it. */
export function timedHourRange<E extends TimedEvent>(days: readonly Date[], events: readonly E[]) {
  let startHour = 7, endHour = 21;
  for (const day of days) for (const segment of timedDaySegments(events, day)) {
    startHour = Math.min(startHour, Math.floor(segment.startMinute / 60));
    endHour = Math.max(endHour, Math.min(24, Math.ceil(segment.endMinute / 60)));
  }
  return { startHour, endHour };
}

/** Collision groups use rendered bounds: minimum hit targets must not obscure nearby short events. */
export function layoutTimedDay<E extends TimedEvent>(events: readonly E[], day: Date, startHour = 7, pixelsPerHour = 48): EventPlacement<E>[] {
  const placed = timedDaySegments(events, day).map((segment) => {
    const height = Math.max(CAL_EVENT_MIN_HEIGHT, (segment.endMinute - segment.startMinute) * pixelsPerHour / 60 - 2);
    return { ...segment, top: (segment.startMinute - startHour * 60) * pixelsPerHour / 60, height, compact: height < 44, column: 0, columns: 1 };
  });
  let group: EventPlacement<E>[] = [], groupBottom = -Infinity;
  const flush = () => {
    const columnBottoms: number[] = [];
    for (const item of group) {
      const free = columnBottoms.findIndex((bottom) => bottom <= item.top);
      item.column = free < 0 ? columnBottoms.length : free;
      columnBottoms[item.column] = item.top + item.height;
    }
    for (const item of group) item.columns = columnBottoms.length;
    group = [];
  };
  for (const item of placed) {
    if (group.length && item.top >= groupBottom) { flush(); groupBottom = -Infinity; }
    group.push(item); groupBottom = Math.max(groupBottom, item.top + item.height);
  }
  flush();
  return placed;
}
