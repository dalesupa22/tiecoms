import type { WaChatDTO } from '@tiecoms/contracts';
/** Same ordering as the paginated API: explicit pins, newest timestamp, stable identity. */
export function sortWaChats(chats: readonly WaChatDTO[]): WaChatDTO[] {
  const time = (value: string | null) => {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  return [...chats].sort((a, b) => {
    const pinned = Number(b.pinned) - Number(a.pinned);
    if (pinned) return pinned;
    const at = time(a.lastMessageAt), bt = time(b.lastMessageAt);
    if (at !== bt) return at > bt ? -1 : 1;
    const keyA = `${a.accountId}\0${a.jid}`, keyB = `${b.accountId}\0${b.jid}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
}
