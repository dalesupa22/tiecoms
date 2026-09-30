import type { ConversationDTO } from '@tiecoms/contracts';

// ---------- Orden de Inicio (mismas reglas en web, iOS y Android) ----------
// Módulo puro (sin React ni cliente) para poder probarlo y usarlo desde la búsqueda rápida.
export const isMuted = (c: ConversationDTO) => !!c.mutedUntil && Date.parse(c.mutedUntil) > Date.now();
/** Actividad: el último mensaje de una persona si lo hay; si no, el último mensaje. */
export const activityOf = (c: ConversationDTO) => c.lastHumanPreview?.createdAt ?? c.lastMessageAt ?? '';
/** Con no leídos (no silenciada) cuenta como pendiente; silenciada con no leídos cuenta como leída. */
export const pendingOf = (c: ConversationDTO) => (c.unread > 0 && (!isMuted(c) || (c.unreadMentions ?? 0) > 0) ? c.unread : 0);
const hasMention = (c: ConversationDTO) => (c.unreadMentions ?? 0) > 0;

/**
 * Pendientes del árbol (docs/TANDA-LECTURA-REUNIONES.md): el grupo más sus derivadas (hilos, ramas,
 * internas; no sidechats, que van en DMs). Devuelve una copia del grupo con unread y unreadMentions
 * sumados, para ordenar, separar y filtrar la fila igual que si el pendiente fuera del grupo.
 */
export const isTreeChild = (x: ConversationDTO, rootId: string) => x.parentId === rootId && x.deriveKind !== 'side';
export function withTree(c: ConversationDTO, derived: ConversationDTO[]): ConversationDTO {
  if (!derived.length) return c;
  const kids = derived.filter((x) => isTreeChild(x, c.id));
  return {
    ...c,
    unread: pendingOf(c) + kids.reduce((n, x) => n + pendingOf(x), 0),
    unreadMentions: (c.unreadMentions ?? 0) + kids.reduce((n, x) => n + (x.unreadMentions ?? 0), 0),
  };
}
/** Solo lo que está en las derivadas (la cifra del chip ⑂). */
export const treeOnlyPending = (c: ConversationDTO, derived: ConversationDTO[]) =>
  derived.filter((x) => isTreeChild(x, c.id)).reduce((n, x) => n + pendingOf(x), 0);

/**
 * Orden único de la bandeja (docs/GRUPOS.md › «Bandeja ordenada…», 27-sep-2026):
 * 1. Fijadas primero (pinnedAt). Entre fijadas, el mismo criterio de abajo.
 * 2. Una mención sin leer (aunque esté silenciada).
 * 3. No leídos pendientes (no silenciada).
 * 4. El resto por actividad descendente. Desempate por id para que el orden sea estable.
 */
export function compareConversations(a: ConversationDTO, b: ConversationDTO) {
  const pa = a.pinnedAt ? 1 : 0, pb = b.pinnedAt ? 1 : 0;
  if (pa !== pb) return pb - pa;
  const ma = hasMention(a) ? 1 : 0, mb = hasMention(b) ? 1 : 0;
  if (ma !== mb) return mb - ma;
  const ua = pendingOf(a) > 0 ? 1 : 0, ub = pendingOf(b) > 0 ? 1 : 0;
  if (ua !== ub) return ub - ua;
  return activityOf(b).localeCompare(activityOf(a)) || a.id.localeCompare(b.id);
}

// ---------- Separadores «Fijados · Sin leer · Recientes» ----------
export type InboxBucket = 'pinned' | 'unread' | 'recent';
export const bucketOf = (c: ConversationDTO): InboxBucket => (c.pinnedAt ? 'pinned' : hasMention(c) || pendingOf(c) > 0 ? 'unread' : 'recent');
/**
 * Parte una lista ya ordenada con compareConversations en bloques con su separador.
 * Un bloque vacío no sale. `convOf` saca la conversación de cada elemento.
 */
export function withSeparators<T>(items: T[], convOf: (x: T) => ConversationDTO): { bucket: InboxBucket; items: T[] }[] {
  const out: { bucket: InboxBucket; items: T[] }[] = [];
  for (const x of items) {
    const b = bucketOf(convOf(x));
    const last = out[out.length - 1];
    if (last && last.bucket === b) last.items.push(x); else out.push({ bucket: b, items: [x] });
  }
  return out;
}

// ---------- Empresa bajo el nombre (1.7.1: web, iOS y Android) ----------
const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
/**
 * La línea pequeña y gris bajo el nombre del grupo o la persona: la empresa. Si el nombre ya empieza por la
 * empresa («Xertify - Xertiflow») no se repite y devuelve null; sin empresa también null.
 */
export function companyUnder(company: string | null | undefined, title: string): string | null {
  const c = (company ?? '').trim();
  if (!c) return null;
  if (fold(title).startsWith(fold(c))) return null;
  return c;
}
