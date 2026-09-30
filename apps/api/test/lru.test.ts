/** Caché LRU de fotos y miniaturas (fase de velocidad): tope por cantidad y bytes, TTL y una sola carga por clave. */
import { describe, expect, it, vi } from 'vitest';
import { ByteLru } from '../src/lru.ts';

const v = (n: number) => ({ body: Buffer.alloc(n), contentType: 'image/png' });
describe('ByteLru', () => {
  it('saca el menos usado al pasarse de cantidad o de bytes', () => {
    const c = new ByteLru<ReturnType<typeof v>>(2, 1000);
    c.set('a', v(10)); c.set('b', v(10));
    expect(c.get('a')).toBeTruthy(); // a pasa a ser el más reciente
    c.set('c', v(10));
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeTruthy();
    const big = new ByteLru<ReturnType<typeof v>>(10, 900);
    big.set('x', v(300)); big.set('y', v(300)); big.set('z', v(300));
    expect(big.totalBytes).toBeLessThanOrEqual(900);
    big.set('huge', v(400)); // más de un tercio: no se guarda
    expect(big.get('huge')).toBeUndefined();
  });
  it('vence por TTL', () => {
    vi.useFakeTimers();
    const c = new ByteLru<ReturnType<typeof v>>(10, 1000, 1000);
    c.set('a', v(1));
    vi.advanceTimersByTime(1500);
    expect(c.get('a')).toBeUndefined();
    vi.useRealTimers();
  });
  it('through carga una sola vez por clave aunque lleguen varias peticiones juntas', async () => {
    const c = new ByteLru<ReturnType<typeof v>>();
    const load = vi.fn(async () => v(5));
    const [a, b] = await Promise.all([c.through('k', load), c.through('k', load)]);
    await c.through('k', load);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
    expect(c.hits).toBe(1);
  });
});
