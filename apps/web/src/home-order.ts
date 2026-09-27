import type { ConversationDTO } from '@tiecoms/contracts';

// ---------- Orden de Inicio (mismas reglas en web, iOS y Android) ----------
// Módulo puro (sin React ni cliente) para poder probarlo y usarlo desde la búsqueda rápida.
export const isMuted = (c: ConversationDTO) => !!c.mutedUntil && Date.parse(c.mutedUntil) > Date.now();
/** Actividad: el último mensaje de una persona si lo hay; si no, el último mensaje. */
export const activityOf = (c: ConversationDTO) => c.lastHumanPreview?.createdAt ?? c.lastMessageAt ?? '';
/** Con no leídos (no silenciada) cuenta como pendiente; silenciada con no leídos cuenta como leída. */
export const pendingOf = (c: ConversationDTO) => (c.unread > 0 && (!isMuted(c) || (c.unreadMentions ?? 0) > 0) ? c.unread : 0);
/**
 * Primero las que tienen no leídos, luego el resto; en cada bloque las fijadas arriba y después por
 * actividad descendente. Desempate por id para que el orden sea estable.
 */
export function compareConversations(a: ConversationDTO, b: ConversationDTO) {
  // Una mención sin leer sube arriba del todo (aunque la conversación esté silenciada).
  const ma = (a.unreadMentions ?? 0) > 0 ? 1 : 0, mb = (b.unreadMentions ?? 0) > 0 ? 1 : 0;
  if (ma !== mb) return mb - ma;
  const ua = pendingOf(a) > 0 ? 1 : 0, ub = pendingOf(b) > 0 ? 1 : 0;
  if (ua !== ub) return ub - ua;
  const pa = a.pinnedAt ? 1 : 0, pb = b.pinnedAt ? 1 : 0;
  if (pa !== pb) return pb - pa;
  return activityOf(b).localeCompare(activityOf(a)) || a.id.localeCompare(b.id);
}
