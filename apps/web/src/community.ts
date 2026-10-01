import type { ConversationDTO, MessageDTO } from '@tiecoms/contracts';

/** A community feed keeps the exact audience and file permissions of its group. */
export const communityGroups = (conversations: ConversationDTO[]) => conversations.filter((c) => c.kind === 'group' || c.kind === 'internal');
export const communityPosts = (messages: MessageDTO[]) => messages.filter((m) => m.kind === 'text' && !m.deletedAt && !m.viewOnce).sort((a, b) => b.seq - a.seq);
export function suggestedCommunity(conversations: ConversationDTO[]) {
  return communityGroups(conversations).find((c) => /novedades|comunidad|announcements|community/i.test(c.name ?? ''))?.id ?? '';
}
