import { describe, expect, it } from 'vitest';
import { dockPanes, fillColumns, othersOf, visiblePanes } from './grid-collapse.ts';

describe('paneles recogidos', () => {
  it('saca los recogidos del dibujo y los pasa a la barra, en el orden de la cuadrícula', () => {
    expect(visiblePanes(['a', 'b', 'c', 'tasks:'], ['tasks:', 'b'])).toEqual(['a', 'c']);
    expect(dockPanes(['a', 'b', 'c', 'tasks:'], ['tasks:', 'b'])).toEqual(['b', 'tasks:']);
  });
  it('nunca deja la cuadrícula vacía', () => {
    expect(visiblePanes(['a', 'b'], ['a', 'b'])).toEqual(['a']);
    expect(dockPanes(['a', 'b'], ['a', 'b'])).toEqual(['b']);
  });
  it('ignora recogidos que ya no están abiertos', () => {
    expect(dockPanes(['a', 'b'], ['z'])).toEqual([]);
  });
  it('«recoger los demás» deja solo el activo', () => {
    expect(othersOf(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
  it('un panel que queda solo en su columna crece a lo alto; los que comparten columna no', () => {
    const cells = fillColumns({
      a: { column: 1, row: 1, span: 1, width: 1 }, b: { column: 1, row: 2, span: 1, width: 1 },
      c: { column: 2, row: 1, span: 1, width: 1 }, d: { column: 3, row: 1, span: 2, width: 1 },
    });
    expect(cells.a.span).toBe(1);
    expect(cells.b).toEqual({ column: 1, row: 2, span: 1, width: 1 });
    expect(cells.c).toEqual({ column: 2, row: 1, span: 2, width: 1 });
    expect(cells.d.span).toBe(2);
  });
  it('un panel ancho solo crece si toda su anchura está libre abajo', () => {
    const cells = fillColumns({ a: { column: 1, row: 1, span: 1, width: 2 }, b: { column: 2, row: 2, span: 1, width: 1 } });
    expect(cells.a.span).toBe(1);
  });
});
