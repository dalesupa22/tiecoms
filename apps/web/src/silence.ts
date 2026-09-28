/**
 * Silenciar chats, «No molestar» y cuándo suena un mensaje (reglas puras, con pruebas en test/silence.test.ts).
 * Mismas reglas que el push del servidor: un chat silenciado deja pasar las menciones salvo que el
 * silencio sea «hasta que lo reactive» (más de un año); con «No molestar» no pasa nada.
 */
export const MUTE_FOREVER = '9999-12-31T00:00:00Z';
const YEAR_MS = 366 * 86_400_000;

export const activeUntil = (until: string | null | undefined, now = Date.now()) => !!until && Date.parse(until) > now;
/** Silencio o DND «hasta que lo reactive» (más de un año). */
export const isForever = (until: string | null | undefined, now = Date.now()) => !!until && Date.parse(until) > now + YEAR_MS;

/** Mañana a las 8:00 a. m. (hora local). */
export function tomorrowAt8(now = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}

/** Hora corta si es hoy («18:00»), o día y hora si no («mar 29, 8:00»); null si es «hasta que lo reactive». */
export function untilText(until: string, locale: string, now = new Date()): string | null {
  if (isForever(until, now.getTime())) return null;
  const d = new Date(until);
  const sameDay = d.toDateString() === now.toDateString();
  // Espacios duros para que «8:30 p. m.» no se parta en dos líneas.
  const text = sameDay
    ? d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(locale, { weekday: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return text.replace(/\s/g, '\u00a0');
}

export interface SoundCheck {
  /** Mensaje de texto de otra persona (ni mío ni de sistema). */
  fromOther: boolean;
  mutedUntil: string | null | undefined;
  mentioned: boolean;
  dndUntil: string | null | undefined;
  soundOn: boolean;
  /** La pestaña no está a la vista. */
  hidden: boolean;
  /** El mensaje es del chat abierto en pantalla. */
  current: boolean;
  /** En el chat abierto, la vista está arriba, lejos del final. */
  farFromEnd: boolean;
}

/** ¿Este mensaje puede avisar (sonido o notificación)? Silencio del chat, menciones y «No molestar». */
export function mayAlert(c: Pick<SoundCheck, 'fromOther' | 'mutedUntil' | 'mentioned' | 'dndUntil'>, now = Date.now()): boolean {
  if (!c.fromOther || activeUntil(c.dndUntil, now)) return false;
  if (!activeUntil(c.mutedUntil, now)) return true;
  return c.mentioned && !isForever(c.mutedUntil, now);
}

/** ¿Suena? Además de poder avisar: sonido activado y el mensaje no está ya a la vista. */
export function shouldSound(c: SoundCheck, now = Date.now()): boolean {
  if (!c.soundOn || !mayAlert(c, now)) return false;
  return c.hidden || !c.current || c.farFromEnd;
}
