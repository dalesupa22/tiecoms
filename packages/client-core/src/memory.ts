/**
 * Topes de memoria del cliente (docs/MEMORIA.md). Funciones puras para probarlas sin red ni almacenamiento.
 *
 * - Chats «calientes»: como mucho HOT_CONVERSATIONS conversaciones con mensajes en memoria. Al pasarse se sueltan las
 *   usadas hace más tiempo (LRU), nunca una que esté a la vista (retenida). Al volver a abrirla se pinta desde la caché
 *   local (IndexedDB) y se pone al día con los eventos, o se pide la página de mensajes.
 * - Mensajes por chat: una conversación que no está a la vista guarda solo los últimos MAX_MESSAGES_PER_CONVERSATION
 *   (lo más antiguo se vuelve a pedir al subir, igual que la primera vez).
 */
export const HOT_CONVERSATIONS = 15;
export const MAX_MESSAGES_PER_CONVERSATION = 300;
/** GET compartidos: más de esto y se barren los vencidos. */
export const SHARED_GETS_SWEEP_AT = 40;

/** Deja los últimos `max` (la lista va ordenada por seq). trimmed = se quitó algo del principio. */
export function trimToLatest<T>(messages: T[], max = MAX_MESSAGES_PER_CONVERSATION): { messages: T[]; trimmed: boolean } {
  if (messages.length <= max) return { messages, trimmed: false };
  return { messages: messages.slice(-max), trimmed: true };
}

/**
 * Qué conversaciones soltar para quedar en `max`: las de uso más viejo primero, sin tocar las retenidas (a la vista)
 * ni las ocupadas (abriéndose o poniéndose al día). Las retenidas cuentan dentro del tope.
 */
export function conversationsToEvict(
  inMemory: string[], lastUse: ReadonlyMap<string, number>, keep: (id: string) => boolean, max = HOT_CONVERSATIONS,
): string[] {
  if (inMemory.length <= max) return [];
  const candidates = inMemory.filter((id) => !keep(id)).sort((a, b) => (lastUse.get(a) ?? 0) - (lastUse.get(b) ?? 0));
  return candidates.slice(0, Math.max(0, inMemory.length - max));
}

/** «Escribiendo…» sin las entradas vencidas; devuelve el mismo objeto si no había nada que quitar. */
export function pruneTyping<T extends { until: number }>(typing: Record<string, T[]>, now: number): Record<string, T[]> {
  let changed = false;
  const next: Record<string, T[]> = {};
  for (const [id, list] of Object.entries(typing)) {
    const live = list.filter((t) => t.until > now);
    if (live.length !== list.length) changed = true;
    if (live.length) next[id] = live;
  }
  return changed ? next : typing;
}
