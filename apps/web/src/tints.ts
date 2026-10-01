/**
 * Un color de fondo para cada cuadrito de la cuadrícula (pedido de Danny, 1-oct-2026: «todo crema fastidia al ojo»).
 * Por defecto cada panel nace con un color distinto y suave (salvia, cielo, lavanda, durazno, arena, rosa); se cambia
 * desde el 🎨 de su encabezado y se puede volver a «todos crema». Se guarda en este navegador.
 * El color solo cambia los fondos del cuadrito (CSS: .split-cell[data-tint]), en claro y en oscuro.
 */
import { useSyncExternalStore } from 'react';
import { t } from './i18n.ts';
import { openMenuAt, type MenuItem } from './menu.tsx';
import { currentPanes } from './split.ts';
import { IDS, PALETTE, leastUsed, resolveTints } from './tints-core.ts';
export { PALETTE, leastUsed, resolveTints };

const CHOSEN = 'chaggu:pane-tints';
const ASSIGNED = 'chaggu:pane-tints-assigned';
const AUTO = 'chaggu:pane-tints-auto';

function read<T>(key: string, fallback: T): T { try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); return v ?? fallback; } catch { return fallback; } }
function write(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ } }

/** Lo que la persona eligió (un color o 'none' = crema) y lo que se asignó solo la primera vez. */
let chosen: Record<string, string> = read(CHOSEN, {});
let assigned: Record<string, string> = read(ASSIGNED, {});
let auto: boolean = read<boolean>(AUTO, true) !== false;
let resolved: Record<string, string> = {};
const listeners = new Set<() => void>();

function recompute() { resolved = resolveTints(chosen, assigned, auto); listeners.forEach((l) => l()); }
recompute();

/** A cada panel nuevo se le asigna un color que no esté repetido; lo que ya no está abierto se olvida. */
export function ensureAssigned(keys: string[]) {
  const open = new Set([...currentPanes(), ...keys]);
  let changed = false;
  for (const k of Object.keys(assigned)) if (!open.has(k)) { delete assigned[k]; changed = true; }
  for (const k of Object.keys(chosen)) if (!open.has(k)) { delete chosen[k]; changed = true; }
  for (const k of keys) {
    if (chosen[k] || assigned[k]) continue;
    const used = [...open].filter((o) => o !== k).map((o) => resolved[o] ?? assigned[o]).filter(Boolean) as string[];
    assigned[k] = leastUsed(used); changed = true;
  }
  if (changed) { write(ASSIGNED, assigned); write(CHOSEN, chosen); recompute(); }
}
export function setTint(key: string, id: string | null) {
  if (id === null) delete chosen[key]; else chosen[key] = id;
  write(CHOSEN, chosen); recompute();
}
export function setAutoTints(on: boolean) { auto = on; write(AUTO, on); recompute(); }
export const usePaneTints = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => resolved);
export const useAutoTints = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => auto);

/** El menú del 🎨: los colores, «crema» y «cada cuadrito con su color». */
export function openTintMenu(anchor: HTMLElement, key: string) {
  const r = anchor.getBoundingClientRect();
  const cur = chosen[key] ?? (auto ? assigned[key] : 'none');
  const items: MenuItem[] = [
    ...PALETTE.map((p) => ({ label: t(p.name), icon: p.dot, hint: cur === p.id ? '✓' : undefined, onSelect: () => setTint(key, p.id) })),
    { label: t('tint.none'), icon: '⚪', hint: cur === 'none' ? '✓' : undefined, onSelect: () => setTint(key, 'none') },
    { divider: true },
    { label: t('tint.auto'), icon: '✦', hint: auto ? '✓' : undefined, onSelect: () => setAutoTints(!auto) },
    ...(chosen[key] ? [{ label: t('tint.reset'), icon: '↺', onSelect: () => setTint(key, null) }] : []),
  ];
  openMenuAt(r.right - 200, r.bottom + 4, items);
}
