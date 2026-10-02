import { useSyncExternalStore } from 'react';
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let minute = Math.floor(Date.now() / 60_000);
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) timer = setInterval(() => { minute = Math.floor(Date.now() / 60_000); listeners.forEach((l) => l()); }, 60_000);
  return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = null; } };
}
export const useMinuteClock = () => useSyncExternalStore(subscribe, () => minute);
