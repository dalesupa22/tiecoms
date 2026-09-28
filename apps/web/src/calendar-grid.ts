// Rangos de las vistas del calendario (Día · Semana · Mes). Módulo puro, con pruebas.
export type CalView = 'day' | 'week' | 'month';
export const VIEW_KEY = 'chaggu:calView';
export function storedView(): CalView { try { const v = localStorage.getItem(VIEW_KEY); return v === 'day' || v === 'month' ? v : 'week'; } catch { return 'week'; } }
export function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
export function startOfWeek(d: Date) { const x = startOfDay(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; }
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
/** Cuadrícula del mes: 6 semanas de lunes a domingo (42 días), con los días de los meses vecinos. */
export function monthGrid(anchor: Date) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
/** Rango visible de cada vista (en hora local; setDate respeta los cambios de horario). */
export function viewRange(view: CalView, anchor: Date): { from: Date; to: Date; days: Date[] } {
  if (view === 'day') { const from = startOfDay(anchor); return { from, to: addDays(from, 1), days: [from] }; }
  if (view === 'week') { const from = startOfWeek(anchor); return { from, to: addDays(from, 7), days: Array.from({ length: 7 }, (_, i) => addDays(from, i)) }; }
  const days = monthGrid(anchor);
  return { from: days[0]!, to: addDays(days[41]!, 1), days };
}
