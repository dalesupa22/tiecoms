import { expect, it } from 'vitest';
import type { ConversationDTO, WaChatDTO } from '@tiecoms/contracts';
import { bucketOf, compareConversations, waAsConversation, waInboxFor, waKey, withSeparators } from './home-order.ts';

const wa = (jid: string, p: Partial<WaChatDTO> = {}): WaChatDTO => ({
  accountId: 'acc', accountLabel: 'Personal', accountKind: 'personal', jid, name: jid, isGroup: jid.endsWith('@g.us'), participants: null, description: null,
  lastMessageAt: null, lastPreview: null, unread: 0, category: 'otros', categoryManual: false, pinned: false, hidden: false, archivedInWhatsApp: false,
  linkedConversationId: null, inboxPlace: jid.endsWith('@g.us') ? 'groups' : 'dms', inboxPinnedAt: null, ...p,
});
const conv = (id: string, p: Partial<ConversationDTO> = {}) => ({ id, unread: 0, unreadMentions: 0, pinnedAt: null, mutedUntil: null, lastMessageAt: null, lastHumanPreview: null, ...p }) as unknown as ConversationDTO;

it('WhatsApp en la bandeja: mismo orden y separadores que las conversaciones de chaggu', () => {
  const items = [
    conv('c-old', { lastMessageAt: '2026-10-01T08:00:00Z' }),
    waAsConversation(wa('1@g.us', { lastMessageAt: '2026-10-01T09:00:00Z' })),
    waAsConversation(wa('2@g.us', { unread: 3, lastMessageAt: '2026-09-30T09:00:00Z' })),
    conv('c-pin', { pinnedAt: '2026-09-01T00:00:00Z' }),
    waAsConversation(wa('57@s.whatsapp.net', { inboxPinnedAt: '2026-09-02T00:00:00Z' })),
  ].sort(compareConversations);
  expect(items.map((c) => c.id)).toEqual(['c-pin', 'wa:acc:57@s.whatsapp.net', 'wa:acc:2@g.us', 'wa:acc:1@g.us', 'c-old']);
  expect(withSeparators(items, (c) => c).map((b) => [b.bucket, b.items.length])).toEqual([['pinned', 2], ['unread', 1], ['recent', 2]]);
  expect(bucketOf(waAsConversation(wa('3@g.us', { unread: 1 })))).toBe('unread');
});

it('cada fila va solo en su sección; oculta o sacada no sale', () => {
  const list = [wa('1@g.us'), wa('57@s.whatsapp.net'), wa('9@g.us', { hidden: true }), wa('8@g.us', { inboxPlace: null })];
  expect(waInboxFor(list, 'groups').map(waKey)).toEqual(['wa:acc:1@g.us']);
  expect(waInboxFor(list, 'dms').map(waKey)).toEqual(['wa:acc:57@s.whatsapp.net']);
  expect(waInboxFor(list, 'all')).toHaveLength(2);
  expect(waInboxFor(undefined, 'all')).toEqual([]);
});
