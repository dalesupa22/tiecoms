import { describe, expect, it } from 'vitest';
import { imageFit, imagePan, imageZoom, imageZoomAt } from '../src/image-view.ts';

describe('image viewer geometry', () => {
  it('fits wide, tall and tiny originals in the measured area without upscaling', () => {
    expect(imageFit({ width: 4000, height: 1000 }, { width: 1000, height: 600 })).toBe(.25);
    expect(imageFit({ width: 1000, height: 4000 }, { width: 1000, height: 600 })).toBe(.15);
    expect(imageFit({ width: 20, height: 10 }, { width: 1000, height: 600 })).toBe(1);
  });
  it('allows very large images to fit below 10% and bounds magnification', () => {
    expect(imageZoom(.01, .025)).toBe(.025);
    expect(imageZoom(100, .025)).toBe(8);
  });
  it('keeps images reachable and centers axes that fit after resizing', () => {
    expect(imagePan({ x: 9999, y: -9999 }, { width: 4000, height: 500 }, { width: 1000, height: 600 }, .5)).toEqual({ x: 500, y: 0 });
    expect(imagePan({ x: 9999, y: -9999 }, { width: 4000, height: 500 }, { width: 1000, height: 600 }, .25)).toEqual({ x: 0, y: 0 });
  });
  it('keeps the cursor over the same image pixel when changing scale', () => {
    expect(imageZoomAt({ x: 20, y: -30 }, { x: 100, y: 60 }, .5, 1)).toEqual({ x: -60, y: -120 });
  });
});
