/**
 * Marcas de rendimiento (performance.mark) para medir el arranque y la apertura de chats sin herramientas extra:
 * `chaggu:ready` (primera pintura de la lista), `chaggu:chat-open:<id>` y `chaggu:chat-shown:<id>` (mensajes a la vista).
 * En la consola: performance.getEntriesByType('mark').filter((m) => m.name.startsWith('chaggu:')).
 */
const seen = new Set<string>();
export function markOnce(name: string) {
  if (seen.has(name)) return;
  seen.add(name);
  try { performance.mark(name); } catch {}
}
export function markAgain(name: string) {
  try { performance.clearMarks(name); performance.mark(name); } catch {}
}
