/**
 * Caché local entre visitas (fase de velocidad, docs/TANDA-1.7.md › Velocidad): el último bootstrap y los últimos
 * 50 mensajes de las ~30 conversaciones más recientes, por cuenta y con versión. Al abrir la app se pinta desde
 * aquí y se revalida (stale-while-revalidate); al cerrar sesión se borra con el resto de `u:<id>:`.
 * Funciones puras (sin almacenamiento) para probarlas.
 */
import type { BootstrapDTO, ConversationDTO, MessageDTO } from '@tiecoms/contracts';

/** Subir la versión invalida todo lo guardado (cambió la forma de los DTO o de la caché). */
export const CACHE_VERSION = 1;
export const CACHE_MAX_CONVERSATIONS = 30;
export const CACHE_MAX_MESSAGES = 50;
/** Precarga en segundo plano: conversaciones con no leídos o fijadas. */
export const PREFETCH_MAX = 8;
export const PREFETCH_CONCURRENCY = 2;

/** Quién fue la última cuenta en este dispositivo (sin prefijo de cuenta: se lee antes de saber quién es). */
export const LAST_USER_KEY = 'cache:lastUser';
export const bootKey = (userId: string) => `u:${userId}:cache:v${CACHE_VERSION}:boot`;
export const convKey = (userId: string, conversationId: string) => `u:${userId}:cache:v${CACHE_VERSION}:conv:${conversationId}`;
export const convIndexKey = (userId: string) => `u:${userId}:cache:v${CACHE_VERSION}:convs`;

export interface CachedBoot { v: number; userId: string; savedAt: string; data: BootstrapDTO }
export interface CachedConversation { v: number; savedAt: string; messages: MessageDTO[]; hasMore: boolean; lastEventSeq: number }

const activity = (c: ConversationDTO) => c.lastMessageAt ?? '';

/** Las conversaciones que vale la pena guardar: las más recientes. */
export function conversationsToCache(data: BootstrapDTO, max = CACHE_MAX_CONVERSATIONS): string[] {
  return [...data.conversations].sort((a, b) => activity(b).localeCompare(activity(a))).slice(0, max).map((c) => c.id);
}

/** Lo que se guarda de una conversación abierta: los últimos N mensajes y el cursor de eventos. */
export function snapshotConversation(s: { messages: MessageDTO[]; hasMore: boolean; lastEventSeq: number }, now = new Date(), max = CACHE_MAX_MESSAGES): CachedConversation {
  const messages = s.messages.slice(-max);
  return { v: CACHE_VERSION, savedAt: now.toISOString(), messages, hasMore: s.hasMore || s.messages.length > messages.length, lastEventSeq: s.lastEventSeq };
}

/**
 * ¿Sirve lo guardado para esta conversación? Misma versión, la conversación sigue en mi alcance y solo los
 * mensajes dentro de mi historial visible. null si no sirve.
 */
export function usableConversation(cached: CachedConversation | undefined | null, meta: ConversationDTO | undefined): CachedConversation | null {
  if (!cached || cached.v !== CACHE_VERSION || !meta || !Array.isArray(cached.messages)) return null;
  if (cached.lastEventSeq > meta.lastEventSeq) return null; // la caché no puede ir por delante del servidor
  const messages = cached.messages.filter((m) => m.seq > meta.historyFromSeq);
  return { ...cached, messages };
}

export function usableBoot(cached: CachedBoot | undefined | null, userId: string | null | undefined): CachedBoot | null {
  if (!cached || cached.v !== CACHE_VERSION || !userId || cached.userId !== userId || cached.data?.me?.id !== userId) return null;
  return cached;
}

/** Candidatas a precargar: con no leídos o fijadas (las no leídas primero, luego las más recientes). */
export function prefetchCandidates(data: BootstrapDTO, loaded: (id: string) => boolean, max = PREFETCH_MAX): string[] {
  return data.conversations
    .filter((c) => !loaded(c.id) && (c.unread > 0 || !!c.pinnedAt))
    .sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || activity(b).localeCompare(activity(a)))
    .slice(0, max).map((c) => c.id);
}

/** Corre tareas con concurrencia limitada. */
export async function runLimited<T>(items: T[], limit: number, fn: (x: T) => Promise<unknown>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) { try { await fn(x); } catch { /* una falla no detiene las demás */ } }
  });
  await Promise.all(workers);
}
