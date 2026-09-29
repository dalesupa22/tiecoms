import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage, TieComsClient } from '@tiecoms/client-core';
import type { BootstrapDTO, ConversationDTO } from '@tiecoms/contracts';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = () => json({ messages: [], hasMore: false, lastEventSeq: 0 });
function fixture() {
  const client = new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'test', storage: new MemoryStorage() });
  (client as any).state = { ...client.getState(), status: 'ready', data: { me: { id: 'alice' }, conversations: [{ id: 'chat', lastReadSeq: 2, lastMessageSeq: 10, historyFromSeq: 0, unread: 8 } as ConversationDTO] } as BootstrapDTO };
  return client;
}
afterEach(() => vi.unstubAllGlobals());

describe('one history load per chat and session', () => {
  it('a follower stays pending while loading, shares the real error and does not advance reads', async () => {
    const client = fixture(), response = deferred<Response>(); let followerDone = false;
    const fetcher = vi.fn(() => response.promise); vi.stubGlobal('fetch', fetcher);
    const first = client.openConversation('chat');
    const firstRejected = expect(first).rejects.toMatchObject({ status: 502 });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const second = client.openConversation('chat').finally(() => { followerDone = true; });
    const secondRejected = expect(second).rejects.toMatchObject({ status: 502 });
    await Promise.resolve(); expect(followerDone).toBe(false);
    response.resolve(new Response('Bad Gateway', { status: 502 }));
    await Promise.all([firstRejected, secondRejected]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(client.getState().conversations.chat).toMatchObject({ loading: false, loaded: false });
    expect(client.getState().data!.conversations[0]).toMatchObject({ lastReadSeq: 2, unread: 8 });
  });
  it('passes cancellation to fetch and surfaces abort instead of success', async () => {
    const client = fixture(), controller = new AbortController(); let passed!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      passed = init.signal as AbortSignal;
      passed.addEventListener('abort', () => reject(passed.reason), { once: true });
    })));
    const opening = client.openConversation('chat', false, controller.signal);
    const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(passed).toBe(controller.signal)); controller.abort(); await rejected;
    expect(client.getState().conversations.chat).toMatchObject({ loading: false, loaded: false });
  });
  it('an aborted old request cannot clear or replace a newer successful load', async () => {
    const client = fixture(), old = deferred<Response>(), fresh = deferred<Response>(), controller = new AbortController();
    const fetcher = vi.fn((url: string) => url.includes('/events?') ? Promise.resolve(json({ events: [] })) : fetcher.mock.calls.filter(([path]) => String(path).includes('/messages?')).length === 1 ? old.promise : fresh.promise);
    vi.stubGlobal('fetch', fetcher);
    const first = client.openConversation('chat', false, controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); controller.abort();
    const second = client.openConversation('chat');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); fresh.resolve(page()); await second;
    old.resolve(json({ messages: [{ id: 'old-data' }], hasMore: true, lastEventSeq: 9 })); await rejected;
    expect(client.getState().conversations.chat).toMatchObject({ loaded: true, loading: false, messages: [], lastEventSeq: 0 });
  });
  it('cancelling a follower does not cancel the owner or convert an incomplete load into success', async () => {
    const client = fixture(), response = deferred<Response>(), controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/events?') ? Promise.resolve(json({ events: [] })) : response.promise));
    const owner = client.openConversation('chat');
    const follower = client.openConversation('chat', false, controller.signal);
    const rejected = expect(follower).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await rejected;
    response.resolve(page()); await owner;
    expect(client.getState().conversations.chat?.loaded).toBe(true);
  });
  it('a late old-account failure cannot write loading state into the new account', async () => {
    const client = fixture(), response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/auth/logout') ? Promise.resolve(json({ ok: true })) : response.promise));
    const opening = client.openConversation('chat');
    const rejected = expect(opening).rejects.toMatchObject({ code: 'session_changed' });
    await vi.waitFor(() => expect(client.getState().conversations.chat?.loading).toBe(true));
    await client.logout();
    (client as any).state = { ...client.getState(), status: 'ready', data: { me: { id: 'bob' }, conversations: [] } };
    response.resolve(new Response('Bad Gateway', { status: 502 })); await rejected;
    expect(client.getState().conversations).toEqual({});
  });
});
