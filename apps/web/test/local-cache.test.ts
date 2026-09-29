import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage, TieComsClient } from '@tiecoms/client-core';
import {
  CACHE_VERSION, LAST_USER_KEY, bootKey, convKey, conversationsToCache, prefetchCandidates, runLimited, snapshotConversation, usableBoot, usableConversation,
} from '@tiecoms/client-core';
import type { BootstrapDTO, ConversationDTO, MessageDTO } from '@tiecoms/contracts';

// Velocidad (fase 2 de la tanda 1.7): caché local, precarga y GET compartidos.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const msg = (seq: number): MessageDTO => ({ id: `m${seq}`, conversationId: 'chat', seq, authorId: 'bob', clientMessageId: null, kind: 'text', body: `hola ${seq}`, replyTo: null, mergedFrom: null, forwarded: null, createdAt: '2026-09-29T10:00:00Z', editedAt: null, deletedAt: null });
const conv = (id: string, extra: Partial<ConversationDTO> = {}) => ({ id, lastMessageSeq: 10, lastEventSeq: 20, historyFromSeq: 0, lastReadSeq: 10, unread: 0, pinnedAt: null, lastMessageAt: '2026-09-29T10:00:00Z', ...extra }) as ConversationDTO;
const boot = (conversations: ConversationDTO[] = [conv('chat')]) => ({ me: { id: 'alice' }, conversations, organizations: [], workspaces: [], people: [] }) as unknown as BootstrapDTO;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('funciones puras', () => {
  it('guarda las 30 más recientes y los últimos 50 mensajes', () => {
    const d = boot(Array.from({ length: 40 }, (_, i) => conv(`c${i}`, { lastMessageAt: `2026-09-${String(10 + (i % 20)).padStart(2, '0')}T00:00:00Z` })));
    expect(conversationsToCache(d)).toHaveLength(30);
    const snap = snapshotConversation({ messages: Array.from({ length: 70 }, (_, i) => msg(i + 1)), hasMore: false, lastEventSeq: 90 });
    expect(snap.messages).toHaveLength(50);
    expect(snap.messages[0]!.seq).toBe(21);
    expect(snap.hasMore).toBe(true);
    expect(snap.v).toBe(CACHE_VERSION);
  });
  it('descarta caché de otra versión, de otra cuenta o adelantada al servidor, y respeta el historial', () => {
    const c = snapshotConversation({ messages: [msg(1), msg(2), msg(3)], hasMore: false, lastEventSeq: 5 });
    expect(usableConversation({ ...c, v: 999 }, conv('chat'))).toBeNull();
    expect(usableConversation(c, undefined)).toBeNull();
    expect(usableConversation(c, conv('chat', { lastEventSeq: 4 }))).toBeNull();
    expect(usableConversation(c, conv('chat', { historyFromSeq: 2 }))!.messages.map((m) => m.seq)).toEqual([3]);
    expect(usableBoot({ v: CACHE_VERSION, userId: 'alice', savedAt: '', data: boot() }, 'alice')).not.toBeNull();
    expect(usableBoot({ v: CACHE_VERSION, userId: 'alice', savedAt: '', data: boot() }, 'bob')).toBeNull();
  });
  it('precarga no leídas y fijadas, con concurrencia limitada', async () => {
    const d = boot([conv('a'), conv('b', { unread: 3 }), conv('c', { pinnedAt: '2026-09-01T00:00:00Z' }), conv('d', { unread: 1 })]);
    expect(prefetchCandidates(d, (id) => id === 'd')).toEqual(['b', 'c']);
    let running = 0, peak = 0;
    await runLimited([1, 2, 3, 4, 5], 2, async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; });
    expect(peak).toBe(2);
  });
});

describe('cliente con caché', () => {
  it('abre desde la caché (pinta antes del bootstrap) y la reemplaza al llegar el real', async () => {
    const storage = new MemoryStorage();
    await storage.set(LAST_USER_KEY, 'alice');
    await storage.set(bootKey('alice'), { v: CACHE_VERSION, userId: 'alice', savedAt: '', data: boot([conv('viejo')]) });
    let releaseRefresh!: () => void;
    const gate = new Promise<void>((r) => { releaseRefresh = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) { await gate; return json({ accessToken: 't', accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(), sessionId: 's', user: { id: 'alice' } }); }
      if (url.endsWith('/bootstrap')) return json(boot([conv('nuevo')]));
      return json({ reminders: [], scheduled: [], issues: [] });
    }));
    const client = new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'test', storage });
    (client as any).connect = () => {};
    const started = client.start();
    await vi.waitFor(() => expect(client.getState().status).toBe('ready'));
    expect(client.getState().data!.conversations.map((c) => c.id)).toEqual(['viejo']);
    releaseRefresh();
    await started;
    expect(client.getState().data!.conversations.map((c) => c.id)).toEqual(['nuevo']);
  });

  it('una sesión rechazada borra la caché y queda anónima', async () => {
    const storage = new MemoryStorage();
    await storage.set(LAST_USER_KEY, 'alice');
    await storage.set(bootKey('alice'), { v: CACHE_VERSION, userId: 'alice', savedAt: '', data: boot() });
    await storage.set(convKey('alice', 'chat'), snapshotConversation({ messages: [msg(1)], hasMore: false, lastEventSeq: 1 }));
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'unauthorized', message: 'x' } }, 401)));
    const client = new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'test', storage });
    await client.start();
    expect(client.getState().status).toBe('anonymous');
    expect(client.getState().data).toBeNull();
    expect(await storage.get(bootKey('alice'))).toBeUndefined();
    expect(await storage.get(convKey('alice', 'chat'))).toBeUndefined();
    expect(await storage.get(LAST_USER_KEY)).toBeUndefined();
  });

  it('un chat en caché se pinta y se pone al día con eventos, sin pedir la página de mensajes', async () => {
    const storage = new MemoryStorage();
    await storage.set(convKey('alice', 'chat'), snapshotConversation({ messages: [msg(8), msg(9)], hasMore: true, lastEventSeq: 18 }));
    const newer = msg(10);
    const fetcher = vi.fn(async (url: string) => url.includes('/events?after=18')
      ? json({ events: [{ type: 'message.created', conversationId: 'chat', eventSeq: 19, message: newer }], resetRequired: false, lastEventSeq: 19 })
      : url.includes('/events?') ? json({ events: [], resetRequired: false, lastEventSeq: 19 }) : json({ messages: [], hasMore: false, lastEventSeq: 0 }));
    vi.stubGlobal('fetch', fetcher);
    const client = new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'test', storage });
    (client as any).state = { ...client.getState(), status: 'ready', data: boot() };
    await client.openConversation('chat');
    expect(client.getState().conversations.chat).toMatchObject({ loaded: true, lastEventSeq: 19, hasMore: true });
    expect(client.getState().conversations.chat!.messages.map((m) => m.seq)).toEqual([8, 9, 10]);
    expect(fetcher.mock.calls.some(([u]) => String(u).includes('/messages?'))).toBe(false);
  });

  it('si el cursor guardado es muy viejo (resetRequired), pide la página normal', async () => {
    const storage = new MemoryStorage();
    await storage.set(convKey('alice', 'chat'), snapshotConversation({ messages: [msg(1)], hasMore: false, lastEventSeq: 1 }));
    const fetcher = vi.fn(async (url: string) => url.includes('/events?')
      ? json({ events: [], resetRequired: url.includes('after=1&'), lastEventSeq: 20 })
      : json({ messages: [msg(9), msg(10)], hasMore: true, lastEventSeq: 20 }));
    vi.stubGlobal('fetch', fetcher);
    const client = new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'test', storage });
    (client as any).state = { ...client.getState(), status: 'ready', data: boot() };
    await client.openConversation('chat');
    expect(client.getState().conversations.chat!.messages.map((m) => m.seq)).toEqual([9, 10]);
    expect(fetcher.mock.calls.some(([u]) => String(u).includes('/messages?limit=50'))).toBe(true);
  });

  it('GET repetidos salen una sola vez (tareas, eventos, bloqueos)', async () => {
    const fetcher = vi.fn(async (url: string) => json(url.includes('/blocks') ? { userIds: ['x'] } : url.includes('/issues') ? { issues: [] } : { events: [] }));
    vi.stubGlobal('fetch', fetcher);
    const client = new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'test', storage: new MemoryStorage() });
    (client as any).state = { ...client.getState(), status: 'ready', data: boot() };
    await Promise.all([client.loadIssues({ conversationId: 'chat' }), client.loadIssues({ conversationId: 'chat' }), client.loadIssues({ conversationId: 'chat' })]);
    await client.loadIssues({ conversationId: 'chat' });
    const from = new Date('2026-09-29T00:00:00Z'), to = new Date('2026-10-29T00:00:00Z');
    await Promise.all([client.loadEvents(from, to, 'chat'), client.loadEvents(from, to, 'chat')]);
    expect(await client.loadBlocks()).toEqual(['x']);
    await client.loadBlocks();
    const paths = fetcher.mock.calls.map(([u]) => new URL(String(u), 'http://x').pathname);
    expect(paths.filter((p) => p === '/api/v1/issues')).toHaveLength(1);
    expect(paths.filter((p) => p === '/api/v1/events')).toHaveLength(1);
    expect(paths.filter((p) => p === '/api/v1/blocks')).toHaveLength(1);
  });
});
