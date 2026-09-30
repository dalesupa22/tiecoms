import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatRecovery, type RecoveryState } from '../src/chat-recovery.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture() {
  let identity = '1:alice', loaded = false;
  const listeners = new Set<() => void>();
  const states: RecoveryState[] = [];
  const open = vi.fn<(signal: AbortSignal) => Promise<void>>();
  const recovery = createChatRecovery({
    identity: () => identity, loaded: () => loaded, open,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    change: (state) => states.push(state),
  });
  return { recovery, open, states, listeners, load: () => { loaded = true; },
    switchAccount: () => { identity = '2:bob'; listeners.forEach((listener) => listener()); } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('chat recovery owner', () => {
  it('joins a reconnect while the retry GET is in flight and keeps retrying after its failure', async () => {
    const f = fixture(), second = deferred<void>();
    f.open.mockRejectedValueOnce({ status: 502 }).mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(async () => { f.load(); });
    const run = f.recovery.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.recovery.start()).toBe(run);
    expect(f.states.some((s) => s.status === 'ready')).toBe(false);
    second.reject({ status: 502 });
    await vi.advanceTimersByTimeAsync(2000);
    await run;
    expect(f.open).toHaveBeenCalledTimes(3);
    expect(f.states.at(-1)?.status).toBe('ready');
    f.recovery.dispose();
  });
  it('does not mistake an early loading return for a successful load', async () => {
    const f = fixture();
    f.open.mockResolvedValueOnce().mockImplementationOnce(async () => { f.load(); });
    const run = f.recovery.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.states.at(-1)?.status).toBe('retrying');
    await vi.advanceTimersByTimeAsync(1000); await run;
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.states.at(-1)?.status).toBe('ready'); f.recovery.dispose();
  });
  it.each(['unmount', 'account'] as const)('cancels waiting timers on %s without another GET or state update', async (event) => {
    const f = fixture(); f.open.mockRejectedValue(new TypeError('Failed to fetch'));
    const run = f.recovery.start(); await vi.advanceTimersByTimeAsync(0);
    const count = f.states.length;
    if (event === 'unmount') f.recovery.dispose(); else f.switchAccount();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000); await run;
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.states).toHaveLength(count); expect(f.listeners.size).toBe(0);
  });
  it('aborts an in-flight fetch and ignores a late completion', async () => {
    const f = fixture(), response = deferred<void>(); let signal!: AbortSignal;
    f.open.mockImplementation((s) => { signal = s; return response.promise; });
    const run = f.recovery.start(); await vi.advanceTimersByTimeAsync(0);
    const count = f.states.length; f.recovery.dispose();
    expect(signal.aborted).toBe(true);
    f.load(); response.resolve(); await run;
    expect(f.states).toHaveLength(count); expect(f.open).toHaveBeenCalledTimes(1);
  });
  it.each([403, 404])('does not retry permanent HTTP%s and preserves the error', async (status) => {
    const f = fixture(), error = { status, code: 'forbidden' }; f.open.mockRejectedValue(error);
    await f.recovery.start(); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.states.at(-1)).toEqual({ status: 'failed', error });
    f.recovery.dispose();
  });
  it('bounds attempts and allows an explicit new recovery after exhaustion', async () => {
    const f = fixture(); f.open.mockRejectedValue({ status: 504 });
    const run = f.recovery.start(); await vi.advanceTimersByTimeAsync(30_000); await run;
    expect(f.open).toHaveBeenCalledTimes(6); expect(f.states.at(-1)).toEqual({ status: 'failed' });
    f.open.mockImplementationOnce(async () => { f.load(); }); await f.recovery.start();
    expect(f.states.at(-1)?.status).toBe('ready'); f.recovery.dispose();
  });
});
