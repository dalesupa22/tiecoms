import { describe, expect, it } from 'vitest';
import { TOPIC_ALL, filterForEntry, filterForMessage, firstPendingIn, nextTopicWithPending, orderTopicsForDock, pendingInView, topicUnreadCounts } from '../src/topic-order.ts';

const tp = (id: string, position: number, archivedAt: string | null = null) => ({ id, position, archivedAt });
// Orden guardado (arrastre): C, A, D, B. Llegan desordenados a propósito.
const topics = [tp('A', 1), tp('B', 3), tp('C', 0), tp('D', 2), tp('X', 4, '2026-09-01')];
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const msg = (seq: number, topicId: string | null, authorId = 'ana', kind = 'text', deletedAt: string | null = null) => ({ seq, topicId, authorId, kind, deletedAt });

describe('orden de la fila de temas', () => {
  it('sin no leídos: el orden guardado del cliente (arrastre), sin archivados', () => {
    expect(ids(orderTopicsForDock(topics, {}))).toEqual(['C', 'A', 'D', 'B']);
  });
  it('con no leídos: primero esos (en el orden guardado, no por hora) y luego el resto', () => {
    expect(ids(orderTopicsForDock(topics, { B: 2, A: 5 }))).toEqual(['A', 'B', 'C', 'D']);
    expect(ids(orderTopicsForDock(topics, { D: 1 }))).toEqual(['D', 'C', 'A', 'B']);
    // «General» ('') no entra en esta lista: va siempre primera y «Todo» segunda, fuera de ella.
    expect(ids(orderTopicsForDock(topics, { '': 3, X: 4 }))).toEqual(['C', 'A', 'D', 'B']);
  });
  it('al leerse, el tema vuelve a su lugar', () => {
    expect(ids(orderTopicsForDock(topics, { B: 1 }))).toEqual(['B', 'C', 'A', 'D']);
    expect(ids(orderTopicsForDock(topics, { B: 0 }))).toEqual(['C', 'A', 'D', 'B']);
  });
  it('nunca repite un tema aunque venga dos veces', () => {
    const dup = [...topics, tp('A', 9), tp('C', 0)];
    const out = ids(orderTopicsForDock(dup, { A: 1, C: 1 }));
    expect(out).toEqual(['C', 'A', 'D', 'B']);
    expect(new Set(out).size).toBe(out.length);
  });
  it('empate de posición: se conserva el orden de llegada', () => {
    expect(ids(orderTopicsForDock([tp('P', 0), tp('Q', 0), tp('R', 0)], { R: 1 }))).toEqual(['R', 'P', 'Q']);
  });
});

describe('sin leer por tema', () => {
  const active = new Set(['A', 'B']);
  it('cuenta solo texto de otros, no borrado, con seq > lo leído; sin tema o archivado va en General', () => {
    const ms = [msg(1, 'A'), msg(2, 'A'), msg(3, 'B'), msg(4, null), msg(5, 'X'), msg(6, 'A', 'danny'), msg(7, 'B', 'ana', 'system'), msg(8, 'B', 'ana', 'text', '2026-09-30')];
    expect(topicUnreadCounts(ms, 1, 'danny', active)).toEqual({ A: 1, B: 1, '': 2 });
    expect(topicUnreadCounts(ms, 8, 'danny', active)).toEqual({});
  });
});

describe('en qué tema abre el chat', () => {
  const active = new Set(['A', 'B']);
  it('con messageId: el tema del mensaje', () => {
    expect(filterForMessage({ topicId: 'B' }, active)).toBe('B');
    expect(filterForMessage({ topicId: 'B' }, active, 'A')).toBe('B');
  });
  it('con messageId sin tema (o de un tema archivado): «Todo», nunca «General»', () => {
    expect(filterForMessage({ topicId: null }, active)).toBe(TOPIC_ALL);
    expect(filterForMessage({ topicId: 'X' }, active)).toBe(TOPIC_ALL);
    expect(filterForMessage({ topicId: null }, active, 'A')).toBe(TOPIC_ALL);
  });
  it('ya en «Todo» se queda en «Todo»; sin temas activos no hay filtro', () => {
    expect(filterForMessage({ topicId: 'A' }, active, TOPIC_ALL)).toBe(TOPIC_ALL);
    expect(filterForMessage({ topicId: 'A' }, new Set())).toBeNull();
  });
  it('desde la lista con no leídos: el tema del primer no leído (sin tema → General)', () => {
    const ms = [msg(1, 'A'), msg(2, 'B', 'danny'), msg(3, 'B'), msg(4, 'A'), msg(5, null)];
    expect(filterForEntry(ms, 1, 'danny', active)).toBe('B');
    expect(filterForEntry(ms, 3, 'danny', active)).toBe('A');
    expect(filterForEntry(ms, 4, 'danny', active)).toBeNull();
    expect(filterForEntry(ms, 5, 'danny', active)).toBeNull();
  });
});

describe('CH028: pendientes en la vista y siguiente tema', () => {
  const dock = [tp('C', 0), tp('A', 1), tp('D', 2)];
  it('la píldora cuenta solo lo del tema que veo; «Todo» suma todo', () => {
    const u = { A: 9, D: 80, '': 3 };
    expect(pendingInView(u, 'A')).toBe(9);
    expect(pendingInView(u, 'C')).toBe(0);
    expect(pendingInView(u, '')).toBe(3);
    expect(pendingInView(u, TOPIC_ALL)).toBe(92);
  });
  it('al día aquí: el siguiente tema con pendientes en el orden de la fila, «General» al final', () => {
    expect(nextTopicWithPending(dock, { D: 4, C: 2 }, 'A')).toEqual({ id: 'C', n: 2 });
    expect(nextTopicWithPending(dock, { D: 4, '': 9 }, 'A')).toEqual({ id: 'D', n: 4 });
    expect(nextTopicWithPending(dock, { C: 2 }, 'A')).toEqual({ id: 'C', n: 2 });
    expect(nextTopicWithPending(dock, { '': 5 }, 'D')).toEqual({ id: '', n: 5 });
    expect(nextTopicWithPending(dock, { A: 1 }, '')).toEqual({ id: 'A', n: 1 });
  });
  it('sin sugerencia si aún hay pendientes aquí, si veo «Todo» o si no queda nada', () => {
    expect(nextTopicWithPending(dock, { A: 1, D: 4 }, 'A')).toBeNull();
    expect(nextTopicWithPending(dock, { D: 4 }, TOPIC_ALL)).toBeNull();
    expect(nextTopicWithPending(dock, {}, 'A')).toBeNull();
  });
  it('primer pendiente de un tema, sin contar lo ya visto ni lo mío', () => {
    const active = new Set(['A', 'B']);
    const ms = [msg(2, 'A', 'danny'), msg(3, 'B'), msg(4, 'A'), msg(5, 'A'), msg(6, null)];
    expect(firstPendingIn(ms, 1, 'danny', active, 'A')).toBe(4);
    expect(firstPendingIn(ms, 1, 'danny', active, 'A', new Set([4]))).toBe(5);
    expect(firstPendingIn(ms, 1, 'danny', active, '')).toBe(6);
    expect(firstPendingIn(ms, 6, 'danny', active, 'A')).toBeNull();
  });
});
