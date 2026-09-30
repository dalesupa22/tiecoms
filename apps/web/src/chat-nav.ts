// ---------- Navegar un chat largo (mismas reglas en web, iOS y Android: docs/GRUPOS.md) ----------
// Módulo puro: dónde abrir un chat con no leídos.

/** Lo mínimo de un mensaje que hace falta aquí. */
export interface SeqMessage { seq: number }

/**
 * Primer no leído al abrir. `readFrom` es lo último que ya leí (max(lastReadSeq, historyFromSeq)); el primer no leído
 * es el primer mensaje con seq mayor. Respuesta:
 * - `null`: no hay no leídos; si el contador aún tiene pendientes, falta historial y se debe mostrar el error de carga.
 * - `'older'`: el primero no está cargado y hay más antiguos (cargar otra página y volver a preguntar).
 * - `{ seq }`: el mensaje sobre el que va la línea «N mensajes nuevos».
 * Si `readFrom` no se conoce, se usan los últimos `unread` mensajes.
 */
export function firstUnread(messages: SeqMessage[], readFrom: number | null, unread: number, hasMore: boolean): { seq: number } | 'older' | null {
  if (unread <= 0) return null;
  if (!messages.length) return hasMore ? 'older' : null;
  if (readFrom == null) {
    const m = messages[Math.max(0, messages.length - unread)]!;
    return { seq: m.seq };
  }
  const first = messages[0]!;
  if (first.seq > readFrom + 1 && hasMore) return 'older';
  const m = messages.find((x) => x.seq > readFrom);
  // The message API includes deleted-message tombstones. A missing sequence after the
  // granted history boundary is an incomplete page, never permission to skip unread content.
  return m?.seq === readFrom + 1 ? { seq: m.seq } : null;
}

/** A jump over unread content must not advance a contiguous read cursor. */
export function readThroughVisible(readFrom: number, seen: Set<number>, visible: number[]): number {
  for (const seq of visible) if (seq > readFrom) seen.add(seq);
  let through = readFrom;
  while (seen.has(through + 1)) { seen.delete(++through); }
  for (const seq of seen) if (seq <= through) seen.delete(seq);
  return through;
}

/** The derived.from event has no message body in the log: its content is the parent's thread chip.
 * This marker does not mark any messages inside that thread as read. */
export function isReadTransparentMessage(m: { kind: string; body: string }): boolean {
  if (m.kind !== 'system') return false;
  try { return JSON.parse(m.body)?.k === 'derived.from'; } catch { return false; }
}
