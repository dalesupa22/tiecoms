/**
 * Color de un grupo en la Agenda: el mismo en web, iOS y Android (docs/AGENDA-COLORES.md).
 * hash = h*31 + código UTF-16 de cada carácter del id del grupo, en uint32; índice = hash % 10.
 */
export const GROUP_COLORS = [
  { bg: '#DCE8FB', fg: '#1E4E9C' }, // azul
  { bg: '#D7F0E2', fg: '#17603D' }, // verde
  { bg: '#E9DEFB', fg: '#5B32A8' }, // morado
  { bg: '#D3EEF0', fg: '#0A5F67' }, // turquesa
  { bg: '#FBDDEB', fg: '#962868' }, // rosado
  { bg: '#FDE8CF', fg: '#8A4B0B' }, // naranja
  { bg: '#E2E4F8', fg: '#3C4196' }, // índigo
  { bg: '#F9DADA', fg: '#9B2525' }, // rojo
  { bg: '#EEF3C9', fg: '#5B6412' }, // oliva
  { bg: '#F6EDC4', fg: '#735600' }, // ámbar
] as const;

export function groupColorIndex(conversationId: string): number {
  let h = 0;
  for (let i = 0; i < conversationId.length; i++) h = (Math.imul(h, 31) + conversationId.charCodeAt(i)) >>> 0;
  return h % GROUP_COLORS.length;
}

export const groupColor = (conversationId: string) => GROUP_COLORS[groupColorIndex(conversationId)]!;

/** Día completo: empieza a las 00:00 y termina a las 23:59 o más tarde, en la hora local de quien mira. */
export function isAllDayEvent(startsAt: string, endsAt: string): boolean {
  const s = new Date(startsAt), e = new Date(endsAt);
  return s.getHours() === 0 && s.getMinutes() === 0 && (e.getTime() - s.getTime() >= 86_340_000) && (e.getHours() === 23 && e.getMinutes() >= 59 || (e.getHours() === 0 && e.getMinutes() === 0));
}
