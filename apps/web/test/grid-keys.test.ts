import { describe, expect, it } from 'vitest';
import { isChatKey, mailKey, parseKey, placeInto, replaceIndex, slots, waKey } from '../src/grid-keys.ts';

describe('claves de la cuadrícula', () => {
  it('un chat conserva su id a secas y un correo o WhatsApp llevan prefijo', () => {
    expect(parseKey('0b9c')).toEqual({ kind: 'chat', id: '0b9c' });
    expect(parseKey(mailKey('google', '18f3a'))).toEqual({ kind: 'mail', provider: 'google', id: '18f3a' });
    expect(parseKey(waKey('acc1', '573001112233:4@s.whatsapp.net'))).toEqual({ kind: 'wa', accountId: 'acc1', jid: '573001112233:4@s.whatsapp.net' });
    expect(isChatKey('0b9c')).toBe(true);
    expect(isChatKey(mailKey('microsoft', 'AAMk='))).toBe(false);
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
  it('si ya estaba abierto se queda donde estaba', () => {
    expect(placeInto(['a', 'x'], 'x', 0, none, 4)).toEqual({ panes: ['a', 'x'], at: 1, replaced: null });
  });
  it('con 4 llenos y un hueco más allá no entra', () => {
    expect(placeInto(['a', 'b', 'c', 'd'], 'x', 4, none, 4)).toBeNull();
  });
});
