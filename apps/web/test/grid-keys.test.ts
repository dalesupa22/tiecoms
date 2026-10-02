import { describe, expect, it } from 'vitest';
import { SECTIONS, TASKS_KEY, isChatKey, mailKey, parseKey, placeInto, placeIntoGrid, replaceIndex, sectionKey, slots, splitMain, waKey } from '../src/grid-keys.ts';

describe('claves de la cuadrícula', () => {
  it('un chat conserva su id a secas y un correo o WhatsApp llevan prefijo', () => {
    expect(parseKey('0b9c')).toEqual({ kind: 'chat', id: '0b9c' });
    expect(parseKey(mailKey('google', '18f3a'))).toEqual({ kind: 'mail', provider: 'google', id: '18f3a' });
    expect(parseKey(waKey('acc1', '573001112233:4@s.whatsapp.net'))).toEqual({ kind: 'wa', accountId: 'acc1', jid: '573001112233:4@s.whatsapp.net' });
    expect(isChatKey('0b9c')).toBe(true);
    expect(isChatKey(mailKey('microsoft', 'AAMk='))).toBe(false);
  });
  it('las secciones enteras (tareas, bandeja, todas las conversaciones de WhatsApp) tienen su clave', () => {
    for (const k of SECTIONS) { expect(parseKey(sectionKey(k))).toEqual({ kind: k }); expect(isChatKey(sectionKey(k))).toBe(false); }
    expect(parseKey('inbox').kind).toBe('chat'); // sin los dos puntos no es una sección
  });
  it('un prefijo mal formado se trata como chat (lo guardado antes no se rompe)', () => {
    expect(parseKey('mail:yahoo:1').kind).toBe('chat');
    expect(parseKey('wa:solo').kind).toBe('chat');
  });
  it('los 4 cuaditos en orden, con huecos libres', () => {
    expect(slots(['a', 'b'], 4)).toEqual(['a', 'b', null, null]);
  });
});

describe('qué panel cede su lugar', () => {
  it('el pedido si no está fijado; si no, el último sin fijar', () => {
    const panes = ['a', 'b', 'c', 'd'];
    expect(replaceIndex(panes, new Set(), 'b')).toBe(1);
    expect(replaceIndex(panes, new Set(['b']), 'b')).toBe(-1);
    expect(replaceIndex(panes, new Set(['d']), null)).toBe(2);
    expect(replaceIndex(panes, new Set(['a', 'b', 'c', 'd']), null)).toBe(-1);
  });
});

describe('fijar en un cuadrito', () => {
  const none = new Set<string>();
  it('un hueco libre agrega al final, aunque se elija un cuadrito más allá', () => {
    expect(placeInto(['a'], 'x', 3, none, 4)).toEqual({ panes: ['a', 'x'], at: 1, replaced: null });
    expect(placeInto([], 'x', 0, none, 4)).toEqual({ panes: ['x'], at: 0, replaced: null });
  });
  it('un cuadrito ocupado se reemplaza, salvo que esté fijado', () => {
    expect(placeInto(['a', 'b'], 'x', 1, none, 4)).toEqual({ panes: ['a', 'x'], at: 1, replaced: 'b' });
    expect(placeInto(['a', 'b'], 'x', 1, new Set(['b']), 4)).toBeNull();
  });
  it('mueve un panel abierto al destino conservando ambos paneles', () => {
    expect(placeInto(['a', 'x'], 'x', 0, none, 4)).toEqual({ panes: ['x', 'a'], at: 0, replaced: null });
    expect(placeInto(['a', 'x'], 'x', 1, none, 4)).toEqual({ panes: ['a', 'x'], at: 1, replaced: null });
    expect(placeInto(['a', 'x'], 'x', 0, new Set(['a']), 4)).toBeNull();
    expect(placeInto(['x', 'a', 'b'], 'x', 3, new Set(['x', 'b']), 4)).toEqual({ panes: ['a', 'b', 'x'], at: 2, replaced: null });
    expect(placeInto(['x', 'a'], 'x', 3, new Set(['a']), 4)).toEqual({ panes: ['a', 'x'], at: 1, replaced: null });
  });
  it('rechaza destinos inválidos sin alterar la cuadrícula', () => {
    for (const at of [-1, NaN, 1.5, 4]) expect(placeInto(['x'], 'x', at, none, 4)).toBeNull();
  });
  it('con 4 llenos y un hueco más allá no entra', () => {
    expect(placeInto(['a', 'b', 'c', 'd'], 'x', 4, none, 4)).toBeNull();
  });
});

describe('la tercera columna: Tareas aparte de los 4 cuaditos', () => {
  const none = new Set<string>();
  it('Tareas no cuenta entre los cuaditos', () => {
    expect(splitMain(['a', 'b', TASKS_KEY])).toEqual({ main: ['a', 'b'], tasks: true });
    expect(slots(['a', TASKS_KEY], 4)).toEqual(['a', null, null, null]);
  });
  it('con los 4 cuaditos llenos todavía cabe Tareas en su columna', () => {
    expect(placeIntoGrid(['a', 'b', 'c', 'd'], TASKS_KEY, 0, none, 4)).toEqual({ panes: ['a', 'b', 'c', 'd', TASKS_KEY], at: 4, replaced: null });
  });
  it('Tareas se queda al final aunque entren otros paneles', () => {
    expect(placeIntoGrid(['a', TASKS_KEY], 'x', 3, none, 4)).toEqual({ panes: ['a', 'x', TASKS_KEY], at: 1, replaced: null });
  });
  it('un cuadrito ocupado se reemplaza sin tocar la columna de Tareas, y uno fijado no', () => {
    expect(placeIntoGrid(['a', 'b', TASKS_KEY], 'x', 0, none, 4)).toEqual({ panes: ['x', 'b', TASKS_KEY], at: 0, replaced: 'a' });
    expect(placeIntoGrid(['a', 'b', TASKS_KEY], 'x', 0, new Set(['a']), 4)).toBeNull();
  });
  it('con 4 llenos más Tareas no entra un quinto cuadrito', () => {
    expect(placeIntoGrid(['a', 'b', 'c', 'd', TASKS_KEY], 'x', 4, none, 4)).toBeNull();
  });
  it('si Tareas ya estaba, se queda donde estaba', () => {
    const r = placeIntoGrid(['a', TASKS_KEY], TASKS_KEY, 4, none, 4)!;
    expect(r.panes).toEqual(['a', TASKS_KEY]);
  });
});
