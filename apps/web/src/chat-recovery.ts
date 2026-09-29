import { isTransient } from './transient.ts';

export type RecoveryState = { status: 'loading' | 'retrying' | 'ready' | 'failed'; error?: unknown };
interface RecoveryOwner {
  identity(): string;
  loaded(): boolean;
  subscribe(listener: () => void): () => void;
  open(signal: AbortSignal): Promise<void>;
  change(state: RecoveryState): void;
}

/** One recovery belongs to one mounted chat and one login generation. */
export function createChatRecovery(owner: RecoveryOwner) {
  const identity = owner.identity();
  const controller = new AbortController();
  const { signal } = controller;
  let pending: Promise<void> | null = null;
  let unsubscribe = () => {};
  const valid = () => !signal.aborted && owner.identity() === identity;
  const dispose = () => { controller.abort(); unsubscribe(); };
  unsubscribe = owner.subscribe(() => { if (owner.identity() !== identity) dispose(); });
  const pause = (ms: number) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  async function recover() {
    if (!valid()) return;
    owner.change({ status: 'loading' });
    for (const wait of [0, 1000, 2000, 4000, 8000, 15000]) {
      try {
        if (wait) await pause(wait);
        if (!valid()) return;
        await owner.open(signal);
        if (!valid()) return;
        // Even a third-party caller returning early is not proof the history loaded.
        if (!owner.loaded()) throw { code: 'history_not_loaded' };
        owner.change({ status: 'ready' });
        return;
      } catch (error) {
        if (!valid()) return;
        if (!isTransient(error) && (error as any)?.code !== 'history_not_loaded') {
          owner.change({ status: 'failed', error });
          return;
        }
        owner.change({ status: 'retrying' });
      }
    }
    if (valid()) owner.change({ status: 'failed' });
  }
  return {
    start(): Promise<void> {
      if (!valid()) return Promise.resolve();
      // Reconnection/manual retry joins the owner; it never invalidates a live GET.
      if (!pending) pending = Promise.resolve().then(recover).finally(() => { pending = null; });
      return pending;
    },
    dispose,
  };
}
