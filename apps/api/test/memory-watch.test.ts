import { describe, it, expect, vi, afterEach } from 'vitest';
import { countHit, startMemoryWatch } from '../src/memory-watch.ts';

afterEach(() => vi.useRealTimers());

describe('vigilante de memoria', () => {
  it('pide reinicio ordenado solo tras varias lecturas seguidas sobre el tope', () => {
    vi.useFakeTimers();
    const onCritical = vi.fn();
    const stop = startMemoryWatch(onCritical, { checkEveryMs: 1000, logEveryMs: 1e9, limitRatio: 0, strikes: 3 });
    vi.advanceTimersByTime(2000); expect(onCritical).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); expect(onCritical).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000); expect(onCritical).toHaveBeenCalledTimes(1);
    stop();
  });
  it('no reinicia por debajo del tope y registra conteos por ruta', () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const onCritical = vi.fn();
    countHit('GET /api/v1/bootstrap'); countHit('GET /api/v1/bootstrap'); countHit('mcp:whoami');
    const stop = startMemoryWatch(onCritical, { checkEveryMs: 1000, logEveryMs: 1000, limitRatio: 1.1 });
    vi.advanceTimersByTime(1000);
    expect(onCritical).not.toHaveBeenCalled();
    const line = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(line.hits).toEqual({ 'GET /api/v1/bootstrap': 2, 'mcp:whoami': 1 });
    expect(line.heapMb).toBeGreaterThan(0);
    stop(); log.mockRestore();
  });
});
