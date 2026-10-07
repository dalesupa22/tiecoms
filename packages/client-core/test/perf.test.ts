import { describe, expect, it, vi } from 'vitest';
import { TieComsClient } from '../src/client.ts';
import { MemoryStorage } from '../src/storage.ts';

const conv = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'group', memberIds: ['me', 'ana'], lastMessageSeq: 1, lastEventSeq: 1, lastReadSeq: 1, historyFromSeq: 0, lastMessageAt: at, unread: 0, ...extra,
});
const make = () => {
  const client: any = new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'fixture', storage: new MemoryStorage() });
  client.state = { ...client.state, status: 'ready', connection: 'online', data: {
    me: { id: 'me', dndUntil: null }, people: [{ id: 'me' }, { id: 'ana' }], organizations: [], workspaces: [],
    conversations: [conv('a', '2026-10-01T00:00:00Z'), conv('b', '2026-10-02T00:00:00Z')], waInbox: [],
  } };
  client.state.conversations = { a: { messages: [], lastEventSeq: 1, hasMore: false, loaded: true, loading: false } };
  client.schedulePersist = () => {};
  client.scheduleBootstrap = vi.fn();
  return client;
};
const message = (conversationId: string, seq: number) => ({
  id: `m${seq}`, conversationId, seq, authorId: 'ana', kind: 'text', body: 'hola', createdAt: '2026-10-03T00:00:00Z', attachments: [],
});

describe('rendimiento del cliente', () => {
  it('un mensaje nuevo actualiza y reordena la lista con un solo cambio de estado', () => {
    const client = make();
    const listener = vi.fn(); client.subscribe(listener);
    client.bumpMeta(message('a', 2));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(client.state.data.conversations.map((c: any) => c.id)).toEqual(['a', 'b']);
    expect(client.state.data.conversations[0]).toMatchObject({ lastMessageSeq: 2, unread: 1 });
  });

  it('members.changed solo pide el snapshot si entra alguien que no está en mi directorio', () => {
    const client = make();
    client.applyEvent({ type: 'members.changed', conversationId: 'a', eventSeq: 2, memberIds: ['me', 'ana'] });
    expect(client.scheduleBootstrap).not.toHaveBeenCalled();
    expect(client.state.data.conversations.find((c: any) => c.id === 'a').memberIds).toEqual(['me', 'ana']);
    client.applyEvent({ type: 'members.changed', conversationId: 'a', eventSeq: 3, memberIds: ['me', 'ana', 'nuevo'] });
    expect(client.scheduleBootstrap).toHaveBeenCalledTimes(1);
  });

  it('«escribiendo» se emite como mucho una vez cada 1,5 s por conversación', () => {
    vi.useFakeTimers();
    try {
      const client = make();
      const emit = vi.fn(); client.socket = { emit };
      client.typing('a'); client.typing('a'); client.typing('a'); client.typing('b');
      expect(emit).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1600);
      client.typing('a');
      expect(emit).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});
