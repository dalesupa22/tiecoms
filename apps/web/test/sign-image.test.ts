import { describe, expect, it } from 'vitest';
import { inkBounds, inkify, otsuThreshold } from '../src/sign-image.ts';

/** Imagen RGBA de w×h rellena con fill(x, y) → [r, g, b, a]. */
function img(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(fill(x, y), (y * w + x) * 4);
  return d;
}

describe('firmas como PNG', () => {
  it('encuentra la caja del trazo y nada en un lienzo vacío', () => {
    const d = img(20, 10, (x, y) => (x >= 4 && x <= 9 && y >= 2 && y <= 5 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    expect(inkBounds(d, 20, 10)).toEqual({ x: 4, y: 2, w: 6, h: 4 });
    expect(inkBounds(img(5, 5, () => [0, 0, 0, 0]), 5, 5)).toBeNull();
  });
  it('separa la tinta del papel en una foto y deja el fondo transparente', () => {
    // Papel grisáceo (≈ 215) con un trazo oscuro (≈ 40).
    const d = img(30, 30, (x, y) => (Math.abs(x - y) < 2 ? [40, 45, 60, 255] : [212, 214, 218, 255]));
    const t = otsuThreshold(d);
    expect(t).toBeGreaterThan(40); expect(t).toBeLessThan(212);
    const out = inkify(d, t + 10, [23, 42, 138]);
    expect(out[3]).toBe(255); // (0,0) está sobre el trazo
    expect([...out.subarray(0, 3)]).toEqual([23, 42, 138]);
    const paper = (0 * 30 + 20) * 4; // (20, 0) es papel
    expect(out[paper + 3]).toBe(0);
  });
});
