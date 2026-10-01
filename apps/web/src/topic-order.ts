// ---------- Temas: orden de la fila y dónde abrir (mismas reglas en web, iOS y Android: docs/TEMAS.md) ----------
// Módulo puro, sin React, para poder probarlo.

/** Filtro «Todo»: todos los mensajes, con y sin tema. */
export const TOPIC_ALL = '__all';

/** Lo mínimo de un tema que hace falta aquí. */
export interface OrderTopic { id: string; position: number; archivedAt?: string | null }
/** Lo mínimo de un mensaje que hace falta aquí. */
export interface TopicMessage { seq: number; kind: string; authorId: string | null; deletedAt?: string | null; topicId?: string | null }

/** ¿Cuenta como «sin leer» para mí? Solo texto de otra persona, sin borrar (los propios y los de sistema no cuentan). */
export const countsAsUnread = (m: TopicMessage, readFrom: number, meId: string | null | undefined) =>
  m.seq > readFrom && !m.deletedAt && m.kind === 'text' && m.authorId !== meId;

/**
 * Sin leer por tema, con los mensajes que tiene el cliente (seq > lo leído). La clave '' es «sin tema»
 * (incluye los de temas archivados o que ya no existen), que es lo que muestra «General».
 */
export function topicUnreadCounts(messages: readonly TopicMessage[], readFrom: number, meId: string | null | undefined, activeIds: ReadonlySet<string>): Record<string, number> {
  const n: Record<string, number> = {};
  for (const m of messages) {
    if (!countsAsUnread(m, readFrom, meId)) continue;
    const k = m.topicId && activeIds.has(m.topicId) ? m.topicId : '';
    n[k] = (n[k] ?? 0) + 1;
  }
  return n;
}

/**
 * Orden de las banderitas de temas (pedido de Danny, 30-sep-2026). «General» y «Todo» no están aquí: siempre van
 * primera y segunda, fuera de esta lista. Después van los temas con algo sin leer para mí y luego el resto,
 * los dos grupos en el orden guardado del chat (arrastre; por defecto, orden de llegada). Un tema nunca sale dos
 * veces y los archivados no salen. El bloque de no leídos es solo presentación: el arrastre usa el orden guardado.
 */
export function orderTopicsForDock<T extends OrderTopic>(topics: readonly T[], unread: Readonly<Record<string, number>>): T[] {
  const seen = new Set<string>();
  const saved = topics
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => !x.archivedAt && !seen.has(x.id) && !!seen.add(x.id))
    .sort((a, b) => a.x.position - b.x.position || a.i - b.i)
    .map(({ x }) => x);
  const hot = saved.filter((x) => (unread[x.id] ?? 0) > 0);
  const rest = saved.filter((x) => !((unread[x.id] ?? 0) > 0));
  return [...hot, ...rest];
}

/**
 * Filtro al saltar a un mensaje concreto (burbuja, notificación, mención, búsqueda o enlace): el tema del mensaje
 * si tiene uno activo; si no tiene, «Todo» (así se ve en su contexto). Si el chat no tiene temas activos no hay
 * filtro (null). `current` es el filtro que ya estaba: si es «Todo», el mensaje ya se ve y no cambia.
 */
export function filterForMessage(m: Pick<TopicMessage, 'topicId'>, activeIds: ReadonlySet<string>, current: string | null = null): string | null {
  if (!activeIds.size) return null;
  if (current === TOPIC_ALL) return TOPIC_ALL;
  return m.topicId && activeIds.has(m.topicId) ? m.topicId : TOPIC_ALL;
}

/**
 * Filtro al abrir el chat desde la lista (sin mensaje concreto) con no leídos: el tema del primer no leído.
 * Si ese primer no leído no tiene tema, «General» (null), que es donde se ve. Sin no leídos, null (como antes).
 */
export function filterForEntry(messages: readonly TopicMessage[], readFrom: number, meId: string | null | undefined, activeIds: ReadonlySet<string>): string | null {
  const first = messages.find((m) => countsAsUnread(m, readFrom, meId));
  return first?.topicId && activeIds.has(first.topicId) ? first.topicId : null;
}
