import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { colorContrast, customAccentTokens, resolveTheme } from '../src/theme.ts';

// Modo oscuro (tema de la web y del escritorio): elección y contraste WCAG AA de los tokens de styles.css.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) out[m[1]!] = m[2]!;
  return out;
}
const LIGHT = block(':root');
const DARK = { ...LIGHT, ...block(':root[data-theme="dark"]') };

function lum(hex: string) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const val = (t: Record<string, string>, k: string) => (k.startsWith('#') ? k : t[k] ?? `falta --${k}`);

// Texto normal (≥ 4,5:1) en los pares principales: fondos, tarjetas, texto primario/secundario, acento, chips y avisos.
const PAIRS: [string, string][] = [
  ['ink', 'paper'], ['ink', 'paper-2'], ['ink', 'paper-3'], ['ink', 'card'], ['ink', 'surface'], ['ink', 'pop'], ['ink', 'hover'],
  ['ink-2', 'paper'], ['ink-2', 'paper-2'], ['ink-2', 'paper-3'], ['ink-2', 'card'], ['ink-2', 'hover'],
  ['muted', 'paper'], ['muted', 'paper-2'], ['muted', 'card'], ['muted', 'surface'],
  ['accent', 'paper'], ['accent', 'card'], ['accent-ink', 'accent-soft'], ['on-accent', 'accent-fill'], ['paper', 'ink'],
  ['ok', 'card'], ['danger', 'paper'], ['danger', 'card'], ['#ffffff', 'danger-fill'], ['badge-ink', 'paper-2'],
  ['blue-ink', 'blue-bg'], ['link-blue', 'card'], ['green-ink', 'green-bg'], ['amber-ink', 'amber-bg'], ['amber-strong', 'amber-bg'],
  ['red-ink', 'red-bg'], ['violet-ink', 'violet-bg'], ['teal-ink', 'teal-bg'], ['call-fg', 'call-bg'], ['ink', 'mark-bg'],
];

describe('tema', () => {
  it('keeps custom accents readable in both themes, including extreme colors', () => {
    for (const mode of ['light', 'dark'] as const) for (const color of ['#ffffff', '#000000', '#ffff00', '#0a7c87', '#ff0000', '#0000ff', '#888888']) {
      const tokens = customAccentTokens(color, mode);
      expect(colorContrast(tokens.accent!, mode === 'dark' ? '#151413' : '#f4f1ea')).toBeGreaterThanOrEqual(4.5);
      expect(colorContrast(tokens['accent-ink']!, tokens['accent-soft']!)).toBeGreaterThanOrEqual(4.5);
      expect(colorContrast(tokens['on-accent']!, tokens['accent-fill']!)).toBeGreaterThanOrEqual(4.5);
    }
    expect(customAccentTokens('javascript:alert(1)', 'light')).toEqual({});
  });
  it('Automático sigue al sistema; Claro y Oscuro lo fijan', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  for (const [name, tokens] of [['claro', LIGHT], ['oscuro', DARK]] as const) {
    it(`AA en texto normal, tema ${name}`, () => {
      const bad = PAIRS.map(([f, b]) => [f, b, ratio(val(tokens, f), val(tokens, b))] as const).filter(([, , r]) => !(r >= 4.5));
      expect(bad).toEqual([]);
    });
  }

  it('el nombre de cada persona cumple AA sobre el fondo oscuro (--pc-N)', () => {
    // Los 8 de PERSON_COLORS (ui.tsx).
    Array.from({ length: 8 }, (_, i) => i).forEach((i) => {
      expect(ratio(DARK[`pc-${i}`]!, DARK.paper!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(DARK[`pc-${i}`]!, DARK.card!)).toBeGreaterThanOrEqual(4.5);
    });
  });

  it('los colores de grupo de la Agenda cumplen AA en los dos temas', () => {
    for (let i = 0; i < 10; i++) {
      expect(ratio(LIGHT[`gc-${i}-fg`]!, LIGHT[`gc-${i}-bg`]!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(DARK[`gc-${i}-fg`]!, DARK[`gc-${i}-bg`]!)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
