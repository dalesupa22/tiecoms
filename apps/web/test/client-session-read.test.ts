import { afterEach, describe, expect, it, vi } from 'vitest';
import { TieComsClient, MemoryStorage } from '@tiecoms/client-core';
import type { BootstrapDTO, ConversationDTO, IssueDTO, MessageDTO } from '@tiecoms/contracts';

const conversation = (id: string, extra: Partial<ConversationDTO> = {}) => ({ id, parentId: null, deriveKind: null, lastMessageSeq: 10, lastReadSeq: 2, historyFromSeq: 0, unread: 8, unreadMentions: 1, ...extra }) as ConversationDTO;
function clientWith(userId = 'alice', conversations = [conversation('root')]) {
  const client = new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'test', storage: new MemoryStorage() });
  (client as any).state = { ...client.getState(), status: 'ready', data: { me: { id: userId }, conversations } as BootstrapDTO };
  return client;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('confirmed reads', () => {
  it('retains unread badges and mentions when the server rejects a tree read', async () => {
    const client = clientWith();
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'unavailable', message: 'retry' } }, 503)));
    await expect(client.markTreeRead('root')).rejects.toThrow();
    expect(client.getState().data!.conversations[0]).toMatchObject({ lastReadSeq: 2, unread: 8, unreadMentions: 1 });
  });
  it('uses only confirmed rows, preserving a concurrently arrived message and mention', async () => {
    const response = deferred<Response>();
    const fetcher = vi.fn((_url: string, _init: RequestInit) => response.promise);
    vi.stubGlobal('fetch', fetcher);
    const client = clientWith('alice', [conversation('root'), conversation('thread', { parentId: 'root', deriveKind: 'same' }), conversation('side', { parentId: 'root', deriveKind: 'side' })]);
    const request = client.markTreeRead('root');
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).items).toEqual([{ conversationId: 'root', seq: 10 }, { conversationId: 'thread', seq: 10 }]);
    Object.assign(client.getState().data!.conversations[0]!, { lastMessageSeq: 11, unread: 9, unreadMentions: 2 });
    response.resolve(json({ marked: [{ conversationId: 'root', lastReadSeq: 10 }] }));
    await request;
    expect(client.getState().data!.conversations[0]).toMatchObject({ lastReadSeq: 10, unread: 1, unreadMentions: 2 });
    expect(client.getState().data!.conversations[1]).toMatchObject({ lastReadSeq: 2, unread: 8 });
    expect(client.getState().data!.conversations[2]).toMatchObject({ lastReadSeq: 2, unread: 8 });
  });
});

describe('session isolation', () => {
  it('rejects a late personal Subject creation after logout and account change', async () => {
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/auth/logout') ? Promise.resolve(json({ ok: true })) : response.promise));
    const client = clientWith();
    const creation = client.createPersonalIssue({ title: 'Private Alice' });
    const rejected = expect(creation).rejects.toMatchObject({ code: 'session_changed' });
    await client.logout();
    (client as any).state = { ...client.getState(), status: 'ready', data: { me: { id: 'bob' }, conversations: [] } };
    response.resolve(json({ id: 'private-a', conversationId: null, ownerId: 'alice', title: 'Private Alice' } satisfies Partial<IssueDTO>));
    await rejected;
    expect(client.getState().issues).toEqual({});
  });
  it('rejects a response whose body arrives after logout, even for the same user', async () => {
    const body = deferred<unknown>();
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(url.endsWith('/auth/logout') ? json({ ok: true }) : { ok: true, status: 200, json: () => body.promise })));
    const client = clientWith();
    const creation = client.createPersonalIssue({ title: 'Private Alice' });
    const rejected = expect(creation).rejects.toMatchObject({ code: 'session_changed' });
    await Promise.resolve();
    await client.logout();
    body.resolve({ id: 'private-a', conversationId: null, ownerId: 'alice' });
    await rejected;
    expect(client.getState().issues).toEqual({});
  });
});


describe('own-message read cursor', () => {
  it.each([
    { read: 2, previous: 10, incoming: 11, expected: 2 },
    { read: 10, previous: 10, incoming: 12, expected: 10 },
    { read: 10, previous: 10, incoming: 11, expected: 11 },
  ])('does not consume an unread or missing message gap: $read/$previous -> $incoming', ({read, previous, incoming, expected}) => {
    const c = clientWith('alice', [conversation('root', { lastReadSeq: read, lastMessageSeq: previous })]);
    (c as any).bumpMeta({ id: 'own', conversationId: 'root', authorId: 'alice', seq: incoming, kind: 'text', body: 'mine', createdAt: new Date().toISOString() } as MessageDTO);
    expect(c.getState().data!.conversations[0]!.lastReadSeq).toBe(expected);
    expect(c.getState().data!.conversations[0]!.unread).toBe(incoming-expected);
  });
});
