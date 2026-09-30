/**
 * Poda de memoria cuando la app lleva rato oculta (pestaña en segundo plano, escritorio minimizado o en la bandeja):
 * cada caché se registra con onTrim y aquí se llaman todas juntas (docs/MEMORIA.md). Lo podado se vuelve a pedir o
 * a pintar desde la caché local al volver; lo que está a la vista no se toca.
 */
export const HIDDEN_TRIM_MS = 5 * 60_000;

const trimmers = new Set<() => void>();
/** Registra una poda; devuelve cómo quitarla. */
export function onTrim(fn: () => void) { trimmers.add(fn); return () => { trimmers.delete(fn); }; }
/** Poda ya (y la usa el arnés para medir). */
export function trimMemoryNow() { for (const fn of trimmers) { try { fn(); } catch { /* una poda que falla no detiene las demás */ } } }

/**
 * Oculta más de `delay` → poda. Volver a la vista antes cancela. `hint()` sirve cuando el sistema avisa que ocultó
 * la ventana sin que el WebView cambie visibilityState (escritorio: cerrar la ventana la manda a la bandeja).
 */
export function installMemoryTrim(o: { delay?: number; doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>; trim?: () => void } = {}) {
  const delay = o.delay ?? HIDDEN_TRIM_MS;
  const doc = o.doc ?? document;
  const trim = o.trim ?? trimMemoryNow;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const start = () => { timer ??= setTimeout(() => { timer = null; trim(); }, delay); };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const on = () => { if (doc.visibilityState === 'hidden') start(); else cancel(); };
  doc.addEventListener('visibilitychange', on);
  const api = { hint: start, cancel, dispose: () => { doc.removeEventListener('visibilitychange', on); cancel(); if (installed === api) installed = null; } };
  if (!o.doc) installed = api;
  return api;
}
let installed: ReturnType<typeof installMemoryTrim> | null = null;
/** El sistema ocultó la ventana (escritorio → bandeja): empieza a contar como si visibilityState fuera 'hidden'. */
export const hintHidden = () => installed?.hint();
/** La ventana volvió (foco): no se poda. */
export const cancelHidden = () => installed?.cancel();
