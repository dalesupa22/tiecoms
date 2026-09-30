/** «Es hoy» (tanda 1.7): fechas en la zona de cada evento, sin dependencias. */
// ---------- Fechas en una zona horaria ----------
function parts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o: Record<string, string> = {};
  for (const x of f.formatToParts(d)) o[x.type] = x.value;
  return { date: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute) };
}
export const localDate = (d: Date, tz: string) => parts(d, tz).date;

/**
 * ¿Publicar «es hoy» ahora? Mismo día local que el inicio; ya pasaron las 07:00 locales (o ya empezó);
 * si se creó ese mismo día después de las 07:00, solo si faltan más de 10 minutos. 'skip' = ya no avisará.
 */
export function todayDecision(ev: { startsAt: Date; endsAt: Date; createdAt: Date; timezone: string }, now = new Date()): 'post' | 'wait' | 'skip' {
  if (now >= ev.endsAt) return 'skip';
  const n = parts(now, ev.timezone), s = parts(ev.startsAt, ev.timezone);
  if (n.date > s.date) return 'skip';
  if (n.date < s.date) return 'wait';
  if (n.minutes < 7 * 60 && now < ev.startsAt) return 'wait';
  const cr = parts(ev.createdAt, ev.timezone);
  const createdToday7 = cr.date === s.date && cr.minutes >= 7 * 60;
  if (createdToday7 && ev.startsAt.getTime() - now.getTime() <= 10 * 60_000) return 'skip';
  return 'post';
}

