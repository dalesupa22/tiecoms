import { describe, expect, it, vi } from 'vitest';
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, readSidebarWidth, saveSidebarWidth, SIDEBAR_WIDTH_KEY, sidebarBounds, sidebarWidthGesture } from '../src/sidebar-resize.ts';

function storage(value: string | null = null) {
  let saved = value;
  return { getItem: vi.fn(() => saved), setItem: vi.fn((_key: string, v: string) => { saved = v; }) };
}
describe('provider sidebar width', () => {
  it('clamps a desktop gesture and preserves usable workspace at large text sizes', () => {
    for (const zoom of [1, 1.3, 1.8]) for (const viewport of [861, 1000, 1440, 2400]) {
      const bounds = sidebarBounds(viewport, 68 * zoom, zoom);
      expect(clampSidebarWidth(-100, bounds)).toBe(bounds.min);
      expect(clampSidebarWidth(10000, bounds)).toBe(bounds.max);
      expect(bounds.max).toBeLessThanOrEqual((viewport - 68 * zoom) * .62);
      expect(bounds.min).toBeLessThanOrEqual(bounds.max);
    }
  });
  it('recovers safely from invalid dimensions and blocked/malformed storage', () => {
    expect(sidebarBounds(0, 68, NaN)).toEqual({ min: 0, max: 0, zoom: 1 });
    expect(clampSidebarWidth(NaN, sidebarBounds(1400, 68, 1))).toBe(DEFAULT_SIDEBAR_WIDTH);
    for (const bad of ['null', '[]', '{', '{"mail":-1,"whatsapp":"wide"}']) expect(readSidebarWidth(storage(bad), 'mail')).toBe(DEFAULT_SIDEBAR_WIDTH);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readSidebarWidth(blocked, 'mail')).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(() => saveSidebarWidth(blocked, 'mail', 400)).not.toThrow();
  });
  it('keeps separate saved widths for WhatsApp and Mail without storing viewport clamps', () => {
    const s = storage(); saveSidebarWidth(s, 'mail', 580); saveSidebarWidth(s, 'whatsapp', 340);
    expect(readSidebarWidth(s, 'mail')).toBe(580); expect(readSidebarWidth(s, 'whatsapp')).toBe(340);
    expect(s.setItem.mock.lastCall?.[0]).toBe(SIDEBAR_WIDTH_KEY);
    expect(JSON.parse(s.setItem.mock.lastCall![1])).toEqual({ whatsapp: 340, mail: 580 });
    const narrower = sidebarBounds(861, 68, 1);
    expect(clampSidebarWidth(readSidebarWidth(s, 'mail'), narrower)).toBeLessThan(580);
    expect(readSidebarWidth(s, 'mail')).toBe(580);
  });
  it('previews many moves, persists once on release, ignores later capture loss', () => {
    const preview = vi.fn(), commit = vi.fn(), gesture = sidebarWidthGesture(272, preview, commit);
    gesture.update(350); gesture.update(500); expect(commit).not.toHaveBeenCalled();
    gesture.finish(); gesture.cancel(); gesture.finish(); gesture.update(600);
    expect(commit).toHaveBeenCalledExactlyOnceWith(500); expect(preview).toHaveBeenCalledTimes(2);
  });
  it('Escape/pointer cancellation restores the original preference without persisting', () => {
    const preview = vi.fn(), commit = vi.fn(), gesture = sidebarWidthGesture(650, preview, commit);
    gesture.update(360); gesture.cancel(); gesture.finish();
    expect(preview).toHaveBeenLastCalledWith(650); expect(commit).not.toHaveBeenCalled();
  });
  it('an unchanged or invalid gesture does not write storage', () => {
    const commit = vi.fn(), gesture = sidebarWidthGesture(272, vi.fn(), commit);
    gesture.update(NaN); gesture.update(272); gesture.finish(); expect(commit).not.toHaveBeenCalled();
  });
});
