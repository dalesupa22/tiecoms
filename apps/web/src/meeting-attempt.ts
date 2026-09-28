import type { MeetingProvider } from '@tiecoms/contracts';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface MeetingAttempt {
  provider: MeetingProvider; conversationId?: string | null; idempotencyKey: string; title: string;
  startsAt?: string | null; durationMin: number; timezone: string; share: boolean;
}
const KEY = 'chaggu:meeting-attempts';
type Saved = { userId: string; attempts: Record<string, MeetingAttempt> };
function read(storage: Store, userId: string): Saved {
  const raw = storage.getItem(KEY);
  if (raw) {
    const saved = JSON.parse(raw) as Saved;
    if (!saved || typeof saved.userId !== 'string' || !saved.attempts || typeof saved.attempts !== 'object') throw new Error('meeting_storage_invalid');
    if (saved.userId === userId) return saved;
  }
  return { userId, attempts: {} };
}
export function clearForeignMeetingAttempts(storage: Store, userId: string | null) {
  if (!userId) { storage.removeItem(KEY); return; }
  // Corrupt storage may contain an ambiguous operation: keep it so the dialog fails closed.
  try { const saved = JSON.parse(storage.getItem(KEY) ?? 'null'); if (typeof saved?.userId === 'string' && saved.userId !== userId) storage.removeItem(KEY); } catch {}
}
export function findMeetingAttempt(storage: Store, userId: string, conversationId: string): MeetingAttempt | null {
  return read(storage, userId).attempts[conversationId] ?? null;
}
export function saveMeetingAttempt(storage: Store, userId: string, conversationId: string, attempt: MeetingAttempt | null) {
  const saved = read(storage, userId);
  if (attempt) saved.attempts[conversationId] = attempt; else delete saved.attempts[conversationId];
  storage.setItem(KEY, JSON.stringify(saved));
}
