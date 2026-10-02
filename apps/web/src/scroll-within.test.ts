import { describe, expect, it, vi } from 'vitest';
import { scrollWithin } from './scroll-within.ts';

describe('scroll only the owning viewport', () => {
  const fixture = () => {
    const scrollTo = vi.fn();
    const container = { contains: () => true, getBoundingClientRect: () => ({ top: 100, left: 100, width: 200, height: 200 }), offsetWidth: 400, offsetHeight: 400, clientWidth: 400, clientHeight: 400, clientTop: 0, clientLeft: 0, scrollTop: 300, scrollLeft: 50, scrollTo } as unknown as HTMLElement;
    const target = { getBoundingClientRect: () => ({ top: 200, left: 250, height: 20, width: 40 }) } as unknown as HTMLElement;
    return { container, target, scrollTo };
  };
  it('centers a message vertically at CSS zoom without altering horizontal ancestors', () => {
    const f = fixture(); scrollWithin(f.container, f.target, 'vertical');
    expect(f.scrollTo).toHaveBeenCalledWith({ top: 320, behavior: 'instant' });
  });
  it('aligns the unread divider at the top and centers a topic only horizontally', () => {
    const f = fixture(); scrollWithin(f.container, f.target, 'vertical', 'start');
    expect(f.scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'instant' });
    scrollWithin(f.container, f.target, 'horizontal', 'center', 'smooth');
    expect(f.scrollTo).toHaveBeenLastCalledWith({ left: 190, behavior: 'smooth' });
  });
  it('ignores elements outside the owning viewport', () => {
    const f = fixture(); f.container.contains = () => false;
    scrollWithin(f.container, f.target, 'vertical'); expect(f.scrollTo).not.toHaveBeenCalled();
  });
});
