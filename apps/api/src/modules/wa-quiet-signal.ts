/**
 * libsignal (lo usa Baileys) imprime con console.info/warn la sesión de cifrado completa
 * («Closing session: SessionEntry { … privKey … rootKey … }»). Eso no puede quedar en los logs:
 * con esas llaves se descifran los mensajes de la cuenta. Aquí se reemplaza cualquier argumento
 * que sea una sesión de libsignal por un texto fijo antes de escribirlo.
 */
const HIDDEN = '[sesión de cifrado oculta]';

/** ¿Es un objeto de sesión de libsignal (SessionEntry o algo con sus llaves)? */
export function isSignalSession(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  if ((v as any).constructor?.name === 'SessionEntry') return true;
  const o = v as Record<string, unknown>;
  return 'currentRatchet' in o || 'indexInfo' in o || ('_chains' in o && 'registrationId' in o);
}

export function redactSignalArgs(args: unknown[]): unknown[] {
  return args.some(isSignalSession) ? args.map((a) => (isSignalSession(a) ? HIDDEN : a)) : args;
}

let installed = false;
export function installSignalLogGuard() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => original(...redactSignalArgs(args));
  }
}
