/** Bounded interpretation for availability proposals, never for automatic bookings. */
export const CALENDAR_INTENT = /(?:horarios?|disponib\w*|libres?|fechas?|agendar|agenda|reuni[oó]n|cita|hueco|espacio para|cu[aá]ndo (?:puedo|puedes|podemos|nos vemos|te queda|est[aá]s)|availability|available|free time|dates?|schedule|meeting|calendar)/i;

const WEEKDAYS: [RegExp, number][] = [
  [/\b(?:el |este |pr[oó]ximo )?lunes\b|\bmonday\b/i, 1], [/\b(?:el |este |pr[oó]ximo )?martes\b|\btuesday\b/i, 2],
  [/\b(?:el |este |pr[oó]ximo )?mi[eé]rcoles\b|\bwednesday\b/i, 3], [/\b(?:el |este |pr[oó]ximo )?jueves\b|\bthursday\b/i, 4],
  [/\b(?:el |este |pr[oó]ximo )?viernes\b|\bfriday\b/i, 5],
];

/**
 * Turns «¿cuándo tengo libre?», «agéndame con X», «el jueves», «mañana», «esta/la próxima semana» into a window to check.
 * Without a date word it looks at the next 7 days (5 working days): gg should check the calendar instead of asking.
 */
export function inferredCalendarWindow(text: string, timezone: string, reference = Date.now(), now = Date.now()) {
  if (/(?:no\s+(?:revises|consultes|busques|mires)|do not check|don't check)/i.test(text)) return null;
  if (!CALENDAR_INTENT.test(text)) return null;
  // Explicit foreign zones need clarification.
  if (/\b(?:mx|cdmx|mexico|méxico|pst|est|gmt|utc)\b/i.test(text)) return null;
  if (!Number.isFinite(reference)) return null;
  // A stale message («la próxima semana» written months ago) is not about now.
  if (now - reference > 21 * 86400_000) return null;
  let local: string;
  try { local = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(reference)); } catch { return null; }
  const base = new Date(`${local}T12:00:00Z`);
  const plus = (n: number) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + n); return d; };
  const dow = base.getUTCDay();
  const nextMonday = ((8 - dow) % 7) || 7;
  const ranges: [Date, Date][] = [];
  if (/(?:pr[oó]xima semana|semana que viene|next week)/i.test(text)) ranges.push([plus(nextMonday), plus(nextMonday + 6)]);
  if (/(?:esta semana|this week)/i.test(text)) ranges.push([plus(0), plus(Math.max(0, 5 - dow))]);
  if (/(?:pasado ma[ñn]ana|day after tomorrow)/i.test(text)) ranges.push([plus(2), plus(2)]);
  else if (/\b(?:ma[ñn]ana|tomorrow)\b/i.test(text) && !/\b(?:en la|por la|de la|this|in the) ma[ñn]ana\b/i.test(text)) ranges.push([plus(1), plus(1)]);
  if (/\b(?:hoy|today)\b/i.test(text)) ranges.push([plus(0), plus(0)]);
  for (const [re, wd] of WEEKDAYS) if (re.test(text)) { const ahead = ((wd - dow) + 7) % 7 || 7; ranges.push([plus(ahead), plus(ahead)]); }
  // Nothing said about the date: the next 7 days.
  if (!ranges.length) ranges.push([plus(0), plus(7)]);
  const fromDate = new Date(Math.min(...ranges.map((r) => r[0].getTime()))).toISOString().slice(0, 10);
  const toDate = new Date(Math.max(...ranges.map((r) => r[1].getTime()))).toISOString().slice(0, 10);
  const utc = (date: string, hour: number) => {
    const [y,m,d] = date.split('-').map(Number) as [number,number,number];
    const guess = Date.UTC(y,m-1,d,hour);
    const offset = (at: number) => {const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'}).formatToParts(new Date(at));const part=(key:string)=>Number(parts.find(p=>p.type===key)!.value);return Date.UTC(part('year'),part('month')-1,part('day'),part('hour'),part('minute'),part('second'))-at;};
    return guess-offset(guess-offset(guess));
  };
  const from=utc(fromDate,0),to=utc(toDate,23)+59*60_000+59_000;
  if(to<=now) return null;
  const minutes=text.match(/\b(\d{1,3})\s*(?:minutos?|minutes?|mins?)\b/i);
  const hours=text.match(/\b(?:una|1|one)\s*(?:hora|hour)\b/i);
  const durationMin=minutes ? Number(minutes[1]) : hours ? 60 : 30;
  if(durationMin<15||durationMin>240) return null;
  return {from:new Date(from).toISOString(),to:new Date(to).toISOString(),durationMin,timezone,startHour:9,endHour:18};
}
