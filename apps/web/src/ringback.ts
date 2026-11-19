/**
 * CH038: quien llama oye «tuuu… tuuu…» mientras está sola en la llamada que empezó (antes no sonaba nada y parecía
 * que no estaba llamando). Se calla en cuanto alguien entra, al colgar o a los 45 s (cuando el otro deja de sonar).
 */
import { client } from './app-client.ts';
import { currentCall, subscribeCall } from './call.ts';
import { RINGBACK_MAX_MS, shouldRingback } from './ringback-rules.ts';
import { startRingback, stopRingback } from './sound.ts';

let stopAt: ReturnType<typeof setTimeout> | null = null;
function sync() {
  const v = currentCall();
  const on = shouldRingback(v, client.getState().data?.me.id, Date.now());
  if (stopAt) { clearTimeout(stopAt); stopAt = null; }
  if (!on) { stopRingback(); return; }
  startRingback();
  // Revisa otra vez al vencer los 45 s aunque no cambie nada más.
  const left = RINGBACK_MAX_MS - (Date.now() - Date.parse(v!.call.startedAt));
  if (left > 0) stopAt = setTimeout(sync, left + 50);
}

export function installRingback() {
  subscribeCall(sync);
  client.subscribe(sync);
}
