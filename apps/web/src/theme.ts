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
const ACCENT_KEY = 'chaggu:accent';
/** Color de fondo (--paper) de cada tema: barra del navegador y ventana de escritorio. */
export const THEME_BG: Record<Theme, string> = { light: '#f4f1ea', dark: '#151413' };

const listeners = new Set<() => void>();
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function read(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}
let pref = read();
function readAccent() { try { const color = localStorage.getItem(ACCENT_KEY); return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null; } catch { return null; } }
let accent = readAccent();
export const accentPreference = () => accent;

const luminance = (hex: string) => {
  const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
};
export const colorContrast = (a: string, b: string) => { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0]! + 0.05) / (values[1]! + 0.05); };
function mixColor(color: string, target: number, amount: number) {
  return `#${[1, 3, 5].map((offset) => Math.round(parseInt(color.slice(offset, offset + 2), 16) * (1 - amount) + target * amount).toString(16).padStart(2, '0')).join('')}`;
}
/** Derive readable text and button colors for any custom accent, including white, black and neon colors. */
export function customAccentTokens(color: string, theme: Theme): Record<string, string> {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return {};
  const paper = THEME_BG[theme];
  const soft = mixColor(color, theme === 'dark' ? 20 : 255, 0.88);
  let ink = color;
  for (let step = 1; step <= 20 && (colorContrast(ink, paper) < 4.5 || colorContrast(ink, soft) < 4.5); step++) ink = mixColor(color, theme === 'dark' ? 255 : 0, step / 20);
  return { accent: ink, 'accent-ink': ink, 'accent-fill': color, 'on-accent': colorContrast('#ffffff', color) >= 4.5 ? '#ffffff' : '#000000', 'accent-soft': soft, 'accent-soft-2': soft, 'accent-line': mixColor(color, theme === 'dark' ? 20 : 255, 0.6) };
}

export const themePreference = () => pref;
export const resolveTheme = (p: ThemePref = pref, systemDark = media?.matches ?? false): Theme => (p === 'system' ? (systemDark ? 'dark' : 'light') : p);
export const currentTheme = () => resolveTheme();

export function applyTheme() {
  const theme = resolveTheme();
  const root = document.documentElement;
  if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  root.style.removeProperty('background-color'); // lo puso theme-init.js; desde aquí manda la hoja (html { background: var(--paper) })
  for (const key of ['accent', 'accent-ink', 'accent-fill', 'on-accent', 'accent-soft', 'accent-soft-2', 'accent-line']) root.style.removeProperty(`--${key}`);
  if (accent) for (const [key, value] of Object.entries(customAccentTokens(accent, theme))) root.style.setProperty(`--${key}`, value);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = THEME_BG[theme];
  listeners.forEach((l) => l());
}

export function setThemePreference(p: ThemePref) {
  pref = p;
  try { if (p === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, p); } catch { /* sin almacenamiento */ }
  applyTheme();
}

export function setAccentPreference(color: string | null) {
  accent = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
  try { if (accent) localStorage.setItem(ACCENT_KEY, accent); else localStorage.removeItem(ACCENT_KEY); } catch { /* no storage */ }
  applyTheme();
}

/** Arranque: aplica el tema y sigue al sistema mientras la preferencia sea «Automático». */
export function initTheme() {
  applyTheme();
  const onChange = () => { if (pref === 'system') applyTheme(); };
  if (media?.addEventListener) media.addEventListener('change', onChange);
  else media?.addListener?.(onChange);
  // Otra pestaña cambió la preferencia.
  window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === ACCENT_KEY || e.key === null) { pref = read(); accent = readAccent(); applyTheme(); } });
}

export const subscribeTheme = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useThemePreference = () => useSyncExternalStore(subscribeTheme, () => pref);
export const useAccentPreference = () => useSyncExternalStore(subscribeTheme, () => accent);
