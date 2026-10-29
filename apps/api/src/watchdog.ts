/**
 * Vigilante de procesos de fondo (worker, puente de WhatsApp). El ciclo principal llama beat() en cada vuelta;
 * si pasan WATCHDOG_STALL_MS (5 min) sin vueltas, el proceso sale con código 1 y Docker (restart: unless-stopped)
 * lo vuelve a arrancar. Antes, tras la caída de la BD del 26-oct-2026, quedaron vivos y detenidos 2 días.
 * El intervalo corre aunque el ciclo esté esperando un await que no vuelve (el event loop queda libre).
 * Además deja la hora del último latido en /tmp/<nombre>.alive para el healthcheck de Docker.
 */
import { writeFileSync } from 'node:fs';

export function startWatchdog(name: string, stallMs = Number(process.env.WATCHDOG_STALL_MS ?? 300_000)) {
  const file = `/tmp/${name}.alive`;
  let last = Date.now();
  let stopped = false;
  const touch = () => { try { writeFileSync(file, String(last)); } catch {} };
  touch();
  const timer = setInterval(() => {
    if (stopped) return;
    const idle = Date.now() - last;
    if (idle > stallMs) {
      console.error(`[${name}] vigilante: ${Math.round(idle / 1000)} s sin avanzar el ciclo; salgo para que Docker me reinicie`);
      process.exit(1);
    }
  }, Math.max(1000, Math.min(30_000, Math.floor(stallMs / 4))));
  timer.unref();
  return {
    beat() { last = Date.now(); touch(); },
    /** Apagado ordenado: un cierre lento no cuenta como congelado. */
    stop() { stopped = true; clearInterval(timer); },
  };
}
