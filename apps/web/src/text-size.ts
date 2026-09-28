import { useSyncExternalStore } from 'react';

/**
 * Tamaño del texto (Ajustes): escala la barra lateral, el contenido y los diálogos con CSS `zoom`
 * (la hoja usa px). Los menús flotantes no se escalan porque se ubican con coordenadas de pantalla.
 * Se guarda solo en este dispositivo.
 */
export const TEXT_SIZES = [0.9, 1, 1.12, 1.25, 1.4] as const;
const KEY = 'chaggu:textSize';
const listeners = new Set<() => void>();

function read(): number {
  try { const v = Number(localStorage.getItem(KEY)); return (TEXT_SIZES as readonly number[]).includes(v) ? v : 1; } catch { return 1; }
}
let current = read();

export function applyTextSize(v = current) { document.documentElement.style.setProperty('--ui-zoom', String(v)); }
export function setTextSize(v: number) {
  current = v;
  try { localStorage.setItem(KEY, String(v)); } catch { /* sin almacenamiento */ }
  applyTextSize(v);
  listeners.forEach((l) => l());
}
export const useTextSize = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
