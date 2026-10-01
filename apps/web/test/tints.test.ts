import { describe, expect, it } from 'vitest';
import { PALETTE, leastUsed, resolveTints } from '../src/tints-core.ts';

describe('un color por cuadrito', () => {
  it('cada panel nuevo recibe un color que no esté repetido, mientras haya', () => {
    const used: string[] = [];
    for (let i = 0; i < PALETTE.length; i++) used.push(leastUsed(used));
    expect(new Set(used).size).toBe(PALETTE.length);
    expect(leastUsed(['sage', 'sky'])).toBe('lilac');
    expect(leastUsed([])).toBe('sage');
  });
  it('lo que elige la persona gana sobre lo asignado; «none» deja el cuadrito en crema', () => {
    expect(resolveTints({ a: 'rose' }, { a: 'sage', b: 'sky' }, true)).toEqual({ a: 'rose', b: 'sky' });
    expect(resolveTints({ a: 'none' }, { a: 'sage' }, true)).toEqual({});
  });
  it('apagar «cada cuadrito con su color» deja en crema los no elegidos, pero respeta los elegidos', () => {
    expect(resolveTints({ a: 'peach' }, { a: 'sage', b: 'sky' }, false)).toEqual({ a: 'peach' });
  });
  it('un color que ya no existe se ignora', () => {
    expect(resolveTints({ a: 'verde-feo' }, {}, true)).toEqual({});
  });
});
