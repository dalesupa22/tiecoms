/** Bounded interpretation for availability proposals, never for automatic bookings. */
export function inferredCalendarWindow(text: string, timezone: string, reference = Date.now(), now = Date.now()) {
  if (/(?:no\s+(?:revises|consultes|busques|mires)|do not check|don't check)/i.test(text)) return null;
  if (!/(?:horarios?|disponibilidad|libres?|fechas?|agendar|reuni[oó]n|availability|free time|dates?|schedule|meeting)/i.test(text)) return null;
  // Explicit foreign zones or several competing relative dates need clarification.
  if (/\b(?:mx|cdmx|mexico|méxico|pst|est|gmt|utc)\b/i.test(text)) return null;
  const nextWeek = /(?:pr[oó]xima semana|semana que viene|next week)/i.test(text);
  const tomorrow = /\b(?:ma[ñn]ana|tomorrow)\b/i.test(text);
  if (nextWeek === tomorrow || !Number.isFinite(reference)) return null;
  let local: string;
  try { local = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(reference)); } catch { return null; }
  const day = new Date(`${local}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + (nextWeek ? ((8-day.getUTCDay())%7 || 7) : 1));
  const fromDate = day.toISOString().slice(0,10);
  if (nextWeek) day.setUTCDate(day.getUTCDate()+6);
  const toDate = day.toISOString().slice(0,10);
  const utc = (date: string, hour: number) => {
    const [y,m,d] = date.split('-').map(Number) as [number,number,number];
    const guess = Date.UTC(y,m-1,d,hour);
    const offset = (at: number) => {const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'}).formatToParts(new Date(at));const part=(key:string)=>Number(parts.find(p=>p.type===key)!.value);return Date.UTC(part('year'),part('month')-1,part('day'),part('hour'),part('minute'),part('second'))-at;};
    return guess-offset(guess-offset(guess));
  };
  const from=utc(fromDate,0),to=utc(toDate,23)+59*60_000+59_000;
  if(to<=now) return null;
  const minutes=text.match(/\b(\d{1,3})\s*(?:minutos?|minutes?|mins?)\b/i);
  const durationMin=minutes ? Number(minutes[1]) : 30;
  if(durationMin<15||durationMin>240) return null;
  return {from:new Date(from).toISOString(),to:new Date(to).toISOString(),durationMin,timezone,startHour:9,endHour:18};
}
