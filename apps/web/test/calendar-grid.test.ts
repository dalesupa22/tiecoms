import { describe, expect, it } from 'vitest';
import { monthGrid, viewRange } from '../src/calendar-grid.ts';
import { withTree, treeOnlyPending } from '../src/home-order.ts';

describe('cuadrícula del mes', () => {
  for (const [y, m, len] of [[2026, 1, 28], [2028, 1, 29], [2026, 3, 30], [2026, 9, 31], [2026, 2, 31]] as const) {
    it(`${y}-${m + 1}: 42 días, empieza en lunes y contiene los ${len} días del mes`, () => {
      const g = monthGrid(new Date(y, m, 15));
      expect(g).toHaveLength(42);
      expect(g[0]!.getDay()).toBe(1);
      const inMonth = g.filter((d) => d.getMonth() === m);
      expect(inMonth).toHaveLength(len);
      expect(inMonth[0]!.getDate()).toBe(1);
      // Días consecutivos aunque haya cambio de horario.
      for (let i = 1; i < 42; i++) expect(Math.round((g[i]!.getTime() - g[i - 1]!.getTime()) / 3_600_000)).toBeGreaterThanOrEqual(23);
    });
  }
  it('vistas: día = 1, semana = 7 desde el lunes, mes = 42', () => {
    const at = new Date(2026, 8, 30, 15);
    expect(viewRange('day', at).days).toHaveLength(1);
    const w = viewRange('week', at);
    expect(w.days).toHaveLength(7);
    expect(w.from.getDay()).toBe(1);
    expect(viewRange('month', at).days).toHaveLength(42);
  });
});

describe('pendientes del árbol', () => {
  const c = (id: string, extra: object = {}) => ({ id, unread: 0, unreadMentions: 0, parentId: null, deriveKind: null, mutedUntil: null, ...extra }) as any;
  it('el caso de Danny: grupo leído, 11 en dos derivadas; los sidechats no cuentan', () => {
    const g = c('g');
    const kids = [c('a', { parentId: 'g', deriveKind: 'internal', unread: 5 }), c('b', { parentId: 'g', deriveKind: 'directive', unread: 6, unreadMentions: 1 }), c('s', { parentId: 'g', deriveKind: 'side', unread: 9 })];
    expect(withTree(g, kids).unread).toBe(11);
    expect(withTree(g, kids).unreadMentions).toBe(1);
    expect(treeOnlyPending(g, kids)).toBe(11);
    expect(withTree(g, []).unread).toBe(0);
  });
});
