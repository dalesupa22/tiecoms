// ---------- Navegar un chat largo (mismas reglas en web, iOS y Android: docs/GRUPOS.md) ----------
// Módulo puro: dónde abrir un chat con no leídos.

/** Lo mínimo de un mensaje que hace falta aquí. */
export interface SeqMessage { seq: number }

/**
 * Primer no leído al abrir. `readFrom` es lo último que ya leí (max(lastReadSeq, historyFromSeq)); el primer no leído
 * es el primer mensaje con seq mayor. Respuesta:
 * - `null`: no hay no leídos (abrir al final).
 * - `'older'`: el primero no está cargado y hay más antiguos (cargar otra página y volver a preguntar).
 * - `{ seq }`: el mensaje sobre el que va la línea «N mensajes nuevos».
 * Si `readFrom` no se conoce, se usan los últimos `unread` mensajes.
 */
export function firstUnread(messages: SeqMessage[], readFrom: number | null, unread: number, hasMore: boolean): { seq: number } | 'older' | null {
  if (unread <= 0 || !messages.length) return null;
  if (readFrom == null) {
    const m = messages[Math.max(0, messages.length - unread)]!;
    return { seq: m.seq };
  }
  const first = messages[0]!;
  if (first.seq > readFrom + 1 && hasMore) return 'older';
  const m = messages.find((x) => x.seq > readFrom);
  return m ? { seq: m.seq } : null;
}

/** Cuántas páginas antiguas se cargan como mucho para encontrar el primer no leído; si no aparece, se abre al final. */
export const MAX_OLDER_PAGES = 3;
