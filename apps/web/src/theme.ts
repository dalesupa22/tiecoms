import { useSyncExternalStore } from 'react';

/**
 * Tema de la interfaz: «Automático» (sigue al sistema, por defecto), «Claro» u «Oscuro».
 * Se guarda solo en este dispositivo. public/theme-init.js aplica lo mismo antes del primer pintado
 * (sin parpadeo blanco); aquí se mantiene al día y se escucha el cambio del sistema en vivo.
 */
export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];
const KEY = 'chaggu:theme';
/** Color de fondo (--paper) de cada tema: barra del navegador y ventana de escritorio. */
export const THEME_BG: Record<Theme, string> = { light: '#f4f1ea', dark: '#151413' };

const listeners = new Set<() => void>();
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function read(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}
let pref = read();

export const themePreference = () => pref;
export const resolveTheme = (p: ThemePref = pref, systemDark = media?.matches ?? false): Theme => (p === 'system' ? (systemDark ? 'dark' : 'light') : p);
export const currentTheme = () => resolveTheme();

export function applyTheme() {
  const theme = resolveTheme();
  const root = document.documentElement;
  if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  root.style.removeProperty('background-color'); // lo puso theme-init.js; desde aquí manda la hoja (html { background: var(--paper) })
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = THEME_BG[theme];
  listeners.forEach((l) => l());
}

export function setThemePreference(p: ThemePref) {
  pref = p;
  try { if (p === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, p); } catch { /* sin almacenamiento */ }
  applyTheme();
}

/** Arranque: aplica el tema y sigue al sistema mientras la preferencia sea «Automático». */
export function initTheme() {
  applyTheme();
  const onChange = () => { if (pref === 'system') applyTheme(); };
  if (media?.addEventListener) media.addEventListener('change', onChange);
  else media?.addListener?.(onChange);
  // Otra pestaña cambió la preferencia.
  window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) { pref = read(); applyTheme(); } });
}

export const subscribeTheme = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useThemePreference = () => useSyncExternalStore(subscribeTheme, () => pref);
