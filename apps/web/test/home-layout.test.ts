import { describe, expect, it } from 'vitest';
import {
  BLOCK_IDS, GUIDE_IDS, applyTemplate, defaultLayout, dismissGuide, emptyGuide, gridRows, guideKey, guideView, layoutKey, loadGuide, loadLayout,
  moveBy, moveTo, normalizeGuide, normalizeLayout, resetLayout, restoreDismissed, saveGuide, saveLayout, setCompactStats, setFavorites, setSize,
  setVisible, templateLayout, touchGuide, visibleBlocks, type KV,
} from '../src/home-layout.ts';

const ids = (l: ReturnType<typeof defaultLayout>) => visibleBlocks(l).map((b) => b.id);
function memory(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

describe('plantillas del inicio', () => {
  it('por defecto: la pantalla de siempre más la guía, números grandes', () => {
    const l = defaultLayout();
    expect(ids(l)).toEqual(['stats', 'guide', 'waiting', 'agenda', 'reminders', 'tasks', 'recent']);
    expect(l.compactStats).toBe(false);
    expect(l.template).toBe('default');
  });
  it('enfoque, gerente y soporte muestran solo lo suyo', () => {
    expect(ids(templateLayout('focus'))).toEqual(['waiting', 'tasks']);
    expect(ids(templateLayout('manager'))).toEqual(['stats', 'mentions', 'agenda']);
    expect(ids(templateLayout('support'))).toEqual(['mail', 'whatsapp', 'waiting']);
    expect(templateLayout('focus').compactStats).toBe(true);
  });
  it('toda plantilla trae los 14 bloques una sola vez (los ocultos guardan su lugar)', () => {
    for (const t of ['default', 'focus', 'manager', 'support'] as const) {
      const l = templateLayout(t);
      expect(l.blocks.map((b) => b.id).sort()).toEqual([...BLOCK_IDS].sort());
    }
  });
  it('aplicar una plantilla conserva los favoritos', () => {
    const l = applyTemplate(setFavorites(defaultLayout(), ['a', 'b', 'a']), 'support');
    expect(l.favorites).toEqual(['a', 'b']);
    expect(l.template).toBe('support');
  });
});

describe('orden, visibilidad y tamaño', () => {
  it('mover con flechas salta los ocultos y no se sale de los bordes', () => {
    let l = setVisible(defaultLayout(), 'agenda', false);
    l = moveBy(l, 'waiting', 1); // waiting pasa detrás de reminders (agenda está oculta)
    expect(ids(l)).toEqual(['stats', 'guide', 'reminders', 'waiting', 'tasks', 'recent']);
    expect(moveBy(l, 'stats', -1)).toBe(l);
    expect(moveBy(l, 'recent', 5)).toBe(l);
    expect(l.template).toBe('custom');
  });
  it('arrastrar deja el bloque antes o después del destino', () => {
    const l = defaultLayout();
    expect(ids(moveTo(l, 'tasks', 'stats', 'before')).slice(0, 2)).toEqual(['tasks', 'stats']);
    expect(ids(moveTo(l, 'stats', 'recent', 'after')).at(-1)).toBe('stats');
    expect(moveTo(l, 'stats', 'stats', 'after')).toBe(l);
  });
  it('ocultar, mostrar, cambiar tamaño y números compactos', () => {
    let l = setVisible(defaultLayout(), 'note', true);
    expect(ids(l).at(-1)).toBe('note'); // aparece en su lugar guardado (los ocultos van detrás)
    l = setSize(l, 'waiting', 'wide');
    expect(l.blocks.find((b) => b.id === 'waiting')!.size).toBe('wide');
    l = setCompactStats(l, true);
    expect(l.compactStats).toBe(true);
  });
});

describe('cuadrícula', () => {
  it('los anchos van solos en su fila; los angostos se reparten a la columna más corta', () => {
    const w = (id: string) => (id === 'waiting' ? 9 : 2);
    const rows = gridRows(defaultLayout().blocks, 2, w as never);
    expect(rows[0]).toEqual({ kind: 'wide', id: 'stats' });
    expect(rows[1]).toEqual({ kind: 'wide', id: 'guide' });
    expect(rows[2]).toEqual({ kind: 'cols', cols: [['waiting'], ['agenda', 'reminders', 'tasks', 'recent']] });
  });
  it('con 3 columnas y pesos iguales va en orden de lectura; con 1 todo es una fila', () => {
    const l = templateLayout('support');
    expect(gridRows(l.blocks, 3)).toEqual([{ kind: 'cols', cols: [['mail'], ['whatsapp'], ['waiting']] }]);
    expect(gridRows(l.blocks, 1).map((r) => r.kind)).toEqual(['wide', 'wide', 'wide']);
  });
});

describe('guardado', () => {
  it('guarda por usuario y restablece', () => {
    const s = memory();
    const l = setCompactStats(moveBy(defaultLayout(), 'tasks', -3), true);
    saveLayout('u1', l, s);
    expect(s.data.has(layoutKey('u1'))).toBe(true);
    expect(loadLayout('u1', s)).toEqual(l);
    expect(loadLayout('u2', s)).toEqual(defaultLayout());
    expect(resetLayout('u1', s)).toEqual(defaultLayout());
    expect(s.data.has(layoutKey('u1'))).toBe(false);
  });
  it('tolera basura, versiones viejas y bloques desconocidos', () => {
    const s = memory();
    s.setItem(layoutKey('u'), '{no es json');
    expect(loadLayout('u', s)).toEqual(defaultLayout());
    expect(normalizeLayout({ v: 2, blocks: [] })).toEqual(defaultLayout());
    const n = normalizeLayout({ v: 1, template: 'x', blocks: [{ id: 'tasks', visible: true, size: 'huge' }, { id: 'nuevo' }, { id: 'tasks', visible: false }], favorites: [1, 'c'] });
    expect(n.template).toBe('custom');
    expect(ids(n)).toEqual(['tasks']);
    expect(n.blocks[0]).toEqual({ id: 'tasks', visible: true, size: 'narrow' });
    expect(n.blocks).toHaveLength(BLOCK_IDS.length);
    expect(n.favorites).toEqual(['c']);
  });
  it('sin almacenamiento (null o que lanza) no rompe', () => {
    const boom: KV = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(loadLayout('u', boom)).toEqual(defaultLayout());
    expect(() => saveLayout('u', defaultLayout(), boom)).not.toThrow();
    expect(loadLayout('u', null)).toEqual(defaultLayout());
    expect(loadGuide('u', boom)).toEqual(emptyGuide());
  });
});

describe('guía: lo no usado primero', () => {
  it('ordena no usadas antes que usadas y cuenta descubiertas', () => {
    const v = guideView(emptyGuide(), { whatsapp: true, dark: true, mail: false, call: undefined });
    expect(v.items.slice(-2)).toEqual([{ id: 'whatsapp', used: true }, { id: 'dark', used: true }]);
    expect(v.items[0]).toEqual({ id: 'call', used: false });
    expect(v.discovered).toBe(2);
    expect(v.total).toBe(GUIDE_IDS.length);
  });
  it('lo tocado cuenta cuando los datos no lo saben; lo descartado sale', () => {
    let g = touchGuide(emptyGuide(), 'shortcuts');
    g = touchGuide(g, 'shortcuts');
    g = dismissGuide(g, 'gg');
    const v = guideView(g, {});
    expect(g.touched).toEqual(['shortcuts']);
    expect(v.items.find((x) => x.id === 'gg')).toBeUndefined();
    expect(v.items.at(-1)).toEqual({ id: 'shortcuts', used: true });
    expect(v.discovered).toBe(1);
    expect(v.dismissed).toBe(1);
    expect(guideView(restoreDismissed(g), {}).items).toHaveLength(GUIDE_IDS.length);
  });
  it('guarda y lee el estado de la guía con tolerancia', () => {
    const s = memory();
    saveGuide('u', dismissGuide(touchGuide(emptyGuide(), 'call'), 'dark'), s);
    expect(JSON.parse(s.getItem(guideKey('u'))!)).toEqual({ v: 1, touched: ['call'], dismissed: ['dark'] });
    expect(loadGuide('u', s).touched).toEqual(['call']);
    expect(normalizeGuide({ touched: ['call', 'nope', 'call'], dismissed: 'x' })).toEqual({ v: 1, touched: ['call'], dismissed: [] });
  });
});
