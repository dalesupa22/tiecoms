/**
 * Vigilante de memoria del API (incidente 11/12-oct-2026: tres caídas por «JavaScript heap out of memory»).
 * - Cada 5 min deja en el log el heap y cuántas peticiones hubo por ruta (el patrón, nunca la URL) y por herramienta MCP,
 *   para ubicar qué hace crecer la memoria.
 * - Si el heap pasa del 85 % del tope durante 3 minutos seguidos, cierra el proceso de forma ordenada antes de que V8 lo
 *   mate a mitad de una petición; Docker lo levanta de nuevo (restart: unless-stopped).
 */
import { getHeapStatistics } from 'node:v8';

const counts = new Map<string, number>();
const MAX_KEYS = 300;
export function countHit(key: string) {
  if (!counts.has(key) && counts.size >= MAX_KEYS) key = 'otras';
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

const mb = (n: number) => Math.round(n / 1048576);

export function startMemoryWatch(onCritical: (reason: string) => void, opts: { logEveryMs?: number; checkEveryMs?: number; limitRatio?: number; strikes?: number } = {}) {
  const logEvery = opts.logEveryMs ?? 5 * 60_000;
  const checkEvery = opts.checkEveryMs ?? 60_000;
  const ratio = opts.limitRatio ?? Number(process.env.HEAP_RESTART_RATIO ?? 0.85);
  const strikesNeeded = opts.strikes ?? 3;
  let strikes = 0;
  let lastLog = Date.now();
  let triggered = false;

  const tick = () => {
    const h = getHeapStatistics();
    const used = h.used_heap_size / h.heap_size_limit;
    const now = Date.now();
    if (now - lastLog >= logEvery) {
      const m = process.memoryUsage();
      const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25);
      console.log(JSON.stringify({ msg: '[mem]', heapMb: mb(h.used_heap_size), limitMb: mb(h.heap_size_limit), rssMb: mb(m.rss), externalMb: mb(m.external), uptimeMin: Math.round(process.uptime() / 60), hits: Object.fromEntries(top) }));
      counts.clear();
      lastLog = now;
    }
    strikes = used >= ratio ? strikes + 1 : 0;
    if (strikes >= strikesNeeded && !triggered) {
      triggered = true;
      const reason = `heap ${mb(h.used_heap_size)} MB de ${mb(h.heap_size_limit)} MB durante ${strikes} min`;
      console.error(`[mem] reinicio ordenado: ${reason}`);
      onCritical(reason);
    }
  };
  const timer = setInterval(tick, checkEvery);
  timer.unref();
  return () => clearInterval(timer);
}
