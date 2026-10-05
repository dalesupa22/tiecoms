import { badRequest } from '../errors.ts';

const MAX_AHEAD_MS = 366 * 86_400_000;
/** Numeric offsets describe local wall time; Z describes an absolute UTC instant in the supplied display zone. */
export function parseScheduleTime(sendAt: string, timezone: string, checkBounds = true, now = Date.now()) {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(timezone)) throw badRequest('timezone debe ser una zona IANA válida');
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw badRequest('timezone debe ser una zona IANA válida, por ejemplo America/Bogota'); }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(sendAt);
  if (!match) throw badRequest('sendAt debe ser ISO 8601 con Z o un offset explícito');
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  const wall = Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +second!, +(fraction ?? '').padEnd(3, '0'));
  const parts = new Date(wall);
  if (parts.getUTCFullYear() !== +year! || parts.getUTCMonth() + 1 !== +month! || parts.getUTCDate() !== +day! || +hour! > 23 || +minute! > 59 || +second! > 59
    || (offset !== 'Z' && (+offset!.slice(1, 3) > 23 || +offset!.slice(4, 6) > 59))) throw badRequest('sendAt contiene una fecha u hora inválida');
  const at = Date.parse(sendAt);
  if (!Number.isFinite(at)) throw badRequest('sendAt inválido');
  const p = Object.fromEntries(formatter.formatToParts(at).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  const localSendAt = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  if (offset !== 'Z' && localSendAt !== sendAt.slice(0, 19)) throw badRequest('El offset no coincide con timezone, o esa hora local no existe por el cambio de horario');
  if (checkBounds && at < now + 30_000) throw badRequest('Elige una hora al menos 30 segundos en el futuro');
  if (checkBounds && at > now + MAX_AHEAD_MS) throw badRequest('Se puede programar hasta con 366 días de anticipación');
  return { sendAt: new Date(at).toISOString(), timezone, localSendAt };
}
