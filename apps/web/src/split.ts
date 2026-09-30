/**
 * Hasta 4 conversaciones abiertas a la vez (pedido de Danny, 30-sep-2026): se arrastra un chat de la lista
 * al área del chat, o «Abrir en paralelo» en su menú. La del URL (/c/:id) es la activa; las demás quedan
 * guardadas en este navegador para volver a encontrarlas igual.
 * - Tocar un chat de la lista cambia el panel activo (como las pestañas de un editor).
 * - Tocar dentro de otro panel lo vuelve el activo (el URL cambia, sin recargar ni perder el scroll).
 * - En pantallas angostas solo se ve el activo.
 */
import { useSyncExternalStore } from 'react';
import { navigate } from './router.ts';

export const MAX_PANES = 4;
/** Desde qué ancho de ventana hay paneles (la app de Mac abre en ~1000 px: con 1100 no aparecían). */
export const SPLIT_MEDIA = '(min-width: 860px)';
export const splitAvailable = () => typeof matchMedia !== 'undefined' && matchMedia(SPLIT_MEDIA).matches;
/** Tipo del arrastre (dataTransfer) de una conversación de la lista. */
export const DRAG_TYPE = 'application/x-chaggu-conversation';
const KEY = 'chaggu:split';

function load(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_PANES) : []; } catch { return []; }
}
let panes: string[] = load();
const listeners = new Set<() => void>();
function set(next: string[]) {
  panes = next.slice(0, MAX_PANES);
  try { localStorage.setItem(KEY, JSON.stringify(panes)); } catch { /* sin almacenamiento */ }
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const usePanes = () => useSyncExternalStore(subscribe, () => panes);
export const currentPanes = () => panes;

/**
 * Los paneles a mostrar con `active` (el del URL) adentro: si no estaba, reemplaza al activo anterior
 * (o se agrega si no había paneles). Así tocar un chat en la lista cambia el panel que tienes enfocado.
 */
let lastActive: string | null = null;
export function syncActive(active: string) {
  if (panes.length === 0 || panes.includes(active)) { lastActive = active; return; }
  const at = lastActive ? panes.indexOf(lastActive) : -1;
  const next = [...panes];
  if (at >= 0) next[at] = active; else next.unshift(active);
  lastActive = active;
  set([...new Set(next)]);
}

/**
 * Abre `id` en paralelo junto a `active` (la conversación que se está viendo). Con 4 abiertos, reemplaza a
 * `replace` (el panel donde se soltó) o al último. Devuelve false si ya estaba abierta.
 */
export function openBeside(id: string, active: string | null, replace?: string | null) {
  const base = panes.length ? [...panes] : active ? [active] : [];
  if (base.includes(id)) { navigate(`/c/${id}`, true); return false; }
  if (base.length < MAX_PANES) base.push(id);
  else base[Math.max(0, replace ? base.indexOf(replace) : base.length - 1)] = id;
  set(base);
  if (!active) navigate(`/c/${id}`);
  return true;
}

/** Cierra un panel; si era el activo, el activo pasa al vecino. Con uno solo, vuelve a la vista normal. */
export function closePane(id: string, active: string | null) {
  const at = panes.indexOf(id);
  const next = panes.filter((x) => x !== id);
  set(next.length > 1 ? next : []);
  if (id === active) {
    const to = next[Math.min(Math.max(0, at - 1), next.length - 1)];
    if (to) { lastActive = to; navigate(`/c/${to}`, true); }
  }
}

/** Deja solo esta conversación (⤢). */
export function onlyPane(id: string) { set([]); navigate(`/c/${id}`, true); }

/** Enfocar un panel sin recargar: el URL pasa a ser el suyo. */
export function focusPane(id: string) { lastActive = id; navigate(`/c/${id}`, true); }

/** ¿La conversación está a la vista en algún panel? (para no avisar de lo que ya se está leyendo). */
export const isOpenInPanes = (id: string) => panes.includes(id);

// ---------- Tamaño de los paneles (se arrastran las divisiones) ----------
/** Fracción del ancho para la columna izquierda y del alto para la fila de arriba (0,2–0,8). */
const SIZE_KEY = 'chaggu:split-size';
let sizes: { col: number; row: number } = (() => {
  try { const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null'); if (v && v.col > 0 && v.row > 0) return v; } catch { /* */ }
  return { col: 0.5, row: 0.5 };
})();
const sizeListeners = new Set<() => void>();
export const useSplitSizes = () => useSyncExternalStore((l) => { sizeListeners.add(l); return () => { sizeListeners.delete(l); }; }, () => sizes);
export function setSplitSize(p: Partial<{ col: number; row: number }>, persist = false) {
  const clamp = (x: number) => Math.min(0.8, Math.max(0.2, x));
  sizes = { col: clamp(p.col ?? sizes.col), row: clamp(p.row ?? sizes.row) };
  sizeListeners.forEach((l) => l());
  if (persist) { try { localStorage.setItem(SIZE_KEY, JSON.stringify(sizes)); } catch { /* */ } }
}

// ---------- Zoom por conversación (A− / A+ o ⌘/Ctrl + rueda) ----------
const ZOOM_KEY = 'chaggu:conv-zoom';
export const ZOOM_MIN = 0.7, ZOOM_MAX = 1.6;
let zooms: Record<string, number> = (() => { try { return JSON.parse(localStorage.getItem(ZOOM_KEY) ?? '{}') ?? {}; } catch { return {}; } })();
const zoomListeners = new Set<() => void>();
export const useConvZoom = (id: string) => useSyncExternalStore((l) => { zoomListeners.add(l); return () => { zoomListeners.delete(l); }; }, () => zooms[id] ?? 1);
/** Zoom actual sin suscribirse (para los manejadores de eventos). */
export const convZoomNow = (id: string) => zooms[id] ?? 1;
export function setConvZoom(id: string, z: number) {
  const v = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 10) / 10;
  zooms = { ...zooms };
  if (v === 1) delete zooms[id]; else zooms[id] = v;
  zoomListeners.forEach((l) => l());
  try { localStorage.setItem(ZOOM_KEY, JSON.stringify(zooms)); } catch { /* */ }
}
