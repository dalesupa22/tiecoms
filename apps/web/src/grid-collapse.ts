/**
 * Paneles recogidos de la cuadrícula (pedido de Danny, 2-oct-2026: «que uno los pueda contraer y recoger fácil»).
 * Un panel recogido sigue abierto (no pierde su lugar, su color ni su fijado) pero sale del dibujo de la cuadrícula
 * y queda como pestaña en la barra de arriba; un clic lo devuelve. Siempre queda al menos uno a la vista.
 * Vive aparte de split.ts para no tocar la lógica de posiciones y tamaños.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'chaggu:split-collapsed';

/** Lo que se dibuja: `list` sin los recogidos, pero nunca vacío (si todo quedó recogido, se ve el primero). */
export function visiblePanes(list: readonly string[], collapsed: readonly string[]): string[] {
  const shown = list.filter((k) => !collapsed.includes(k));
  return shown.length ? shown : list.slice(0, 1);
}
/** Los recogidos que siguen abiertos en la cuadrícula, en el orden de la cuadrícula. */
export function dockPanes(list: readonly string[], collapsed: readonly string[]): string[] {
  const shown = visiblePanes(list, collapsed);
  return list.filter((k) => !shown.includes(k));
}
/** Recoger todos menos `keep` (los que estén en `list`). */
export function othersOf(list: readonly string[], keep: string): string[] {
  return list.filter((k) => k !== keep);
}

function load(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 12) : []; } catch { return []; }
}
let collapsed: string[] = load();
const listeners = new Set<() => void>();
function set(next: string[]) {
  const unique = [...new Set(next)];
  if (unique.length === collapsed.length && unique.every((k, i) => k === collapsed[i])) return;
  collapsed = unique;
  try { localStorage.setItem(KEY, JSON.stringify(collapsed)); } catch { /* sin almacenamiento */ }
  listeners.forEach((l) => l());
}
export const useCollapsed = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => collapsed);
export const isCollapsed = (key: string) => collapsed.includes(key);
export function collapseToDock(key: string) { set([...collapsed, key]); }
export function collapseMany(keys: readonly string[]) { set([...collapsed, ...keys]); }
export function restoreFromDock(key: string) { if (collapsed.includes(key)) set(collapsed.filter((k) => k !== key)); }
export function restoreAll() { set([]); }
/** Olvida los que ya no están abiertos en la cuadrícula (se cerraron). */
export function pruneCollapsed(open: readonly string[]) { if (collapsed.some((k) => !open.includes(k))) set(collapsed.filter((k) => open.includes(k))); }

type Cell = { column: number; row: number; span: number; width: number };
/**
 * Con paneles recogidos, los que quedan solos en su columna crecen a lo alto: así ocupan el hueco que dejó el recogido
 * (solo cambia el dibujo; los tamaños guardados siguen igual para cuando se devuelva).
 */
export function fillColumns<T extends Record<string, Cell>>(cells: T): T {
  const out = { ...cells } as Record<string, Cell>;
  const covers = (c: Cell, col: number, row: number) => col >= c.column && col < c.column + c.width && row >= c.row && row < c.row + c.span;
  for (const [key, c] of Object.entries(out)) {
    if (c.span === 2) continue;
    const other = c.row === 1 ? 2 : 1;
    const free = Array.from({ length: c.width }, (_, i) => c.column + i).every((col) => !Object.entries(out).some(([k, x]) => k !== key && covers(x, col, other)));
    if (free) out[key] = { ...c, row: 1, span: 2 };
  }
  return out as T;
}
