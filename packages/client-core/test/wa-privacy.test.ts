import { describe, expect, it, vi } from 'vitest';
import { TieComsClient } from '../src/client.ts';
import { MemoryStorage } from '../src/storage.ts';
import { bootKey, CACHE_VERSION, LAST_USER_KEY } from '../src/local-cache.ts';
import { waPathScope, waRequestScopes } from '../src/wa-privacy.ts';

const chat = (accountId = 'account-a', jid = 'locked@s.whatsapp.net') => ({ accountId, jid, inboxPlace: 'dms', hidden: false, name: 'Private fixture' });
const boot = (waInbox: unknown[] = []) => ({ me: { id: 'fixture', dndUntil: null }, conversations: [], waInbox });
const make = () => {
  const storage = new MemoryStorage();
  const client: any = new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'fixture', storage });
  client.state = { ...client.state, status: 'ready', data: boot([chat(), chat('account-b')]) };
  client.schedulePersist = () => {};
  return { client, storage };
};
const held = () => { let resolve!: (value: any) => void; const promise = new Promise<any>((r) => { resolve = r; }); return { promise, resolve }; };

describe('WA privacy revocation races', () => {
  it('drops only revoked JIDs, rejects a held message response, and preserves another chat/account', async () => {
    const { client } = make(), response = held(); client.raw = vi.fn(() => response.promise);
    const other = client.getWaPrivacyIdentity('account-a', 'other@s.whatsapp.net');
    const otherAccount = client.getWaPrivacyIdentity('account-b', 'locked@s.whatsapp.net');
    const request = client.request('/whatsapp/chats/account-a/locked%40s.whatsapp.net/messages');
    const rejected = expect(request).rejects.toMatchObject({ code: 'wa_privacy_changed' });
    client.onAccountEvent({ type: 'wa.privacy', accountId: 'account-a', jids: ['locked@s.whatsapp.net'] });
    response.resolve(Response.json({ messages: [{ body: 'private delayed text' }] })); await rejected;
    expect(client.state.data.waInbox).toEqual([chat('account-b')]);
    expect(client.getWaPrivacyIdentity('account-a', 'other@s.whatsapp.net')).toBe(other);
    expect(client.getWaPrivacyIdentity('account-b', 'locked@s.whatsapp.net')).toBe(otherAccount);
    client.putWaInbox(chat()); expect(client.state.data.waInbox).toEqual([chat('account-b')]);
  });
  it('blocks delayed GG replies and media streaming after a scoped lock', async () => {
    const { client } = make(), gg = held(), media = held(); let streaming!: () => void;
    const started = new Promise<void>((r) => { streaming = r; });
    client.raw = (path: string) => path.startsWith('/gg/') ? gg.promise : Promise.resolve({ status: 200, ok: true, blob: () => { streaming(); return media.promise; } });
    const reply = client.ggSideAsk('wa:account-a:locked@s.whatsapp.net', 'Fixture');
    const replyRejected = expect(reply).rejects.toMatchObject({ code: 'wa_privacy_changed' });
    const blob = client.fetchBlob('/api/v1/whatsapp/media/account-a/locked%40s.whatsapp.net/media');
    const blobRejected = expect(blob).rejects.toMatchObject({ code: 'wa_privacy_changed' });
    await started; client.invalidateWaPrivacy({ type: 'wa.privacy', accountId: 'account-a', jids: ['locked@s.whatsapp.net'] });
    gg.resolve(Response.json({ message: { body: 'private answer' } })); media.resolve(new Blob(['private bytes']));
    await Promise.all([replyRejected, blobRejected]);
  });
  it('preserves unrelated Chaggu shared GET caches during a WA revocation', async () => {
    const { client } = make(); client.raw = vi.fn(async () => Response.json({ title: 'Ordinary event' }));
    const first = await client.sharedGet('/events/ordinary');
    client.invalidateWaPrivacy({ type: 'wa.privacy', accountId: 'account-a', reset: true });
    expect(await client.sharedGet('/events/ordinary')).toBe(first); expect(client.raw).toHaveBeenCalledTimes(1);
  });
  it('filters held bootstrap WA data while retaining ordinary Chaggu data', async () => {
    const { client } = make(), response = held(); client.request = () => response.promise;
    const load = client.loadBootstrap(); client.invalidateWaPrivacy({ type: 'wa.privacy', accountId: 'account-a', reset: true });
    response.resolve({ ...boot([chat(), chat('account-b')]), people: [{ id: 'ordinary' }] }); await load;
    expect(client.state.data.waInbox).toEqual([chat('account-b')]); expect(client.state.data.people).toEqual([{ id: 'ordinary' }]);
  });
  it('does not interpret an empty list as ready or accept a pre-reset ready response', async () => {
    const { client } = make(), response = held(); client.raw = () => response.promise;
    const accounts = client.request('/whatsapp/accounts'); const rejected = expect(accounts).rejects.toMatchObject({ code: 'wa_privacy_changed' });
    client.invalidateWaPrivacy({ type: 'wa.privacy', accountId: 'account-a', reset: true });
    response.resolve(Response.json({ accounts: [{ id: 'account-a', privacyReady: true }] })); await rejected;
    client.raw = async () => Response.json({ chats: [] }); await client.request('/whatsapp/chats?accountId=account-a');
    expect(client.isWaChatVisible('account-a')).toBe(false);
    client.raw = async () => Response.json({ accounts: [{ id: 'account-a', privacyReady: true }] }); await client.request('/whatsapp/accounts');
    expect(client.isWaChatVisible('account-a')).toBe(true);
  });
  it('allows an unlocked chat only after a fresh authoritative list and rejects old lists', async () => {
    const { client } = make(), response = held(); client.raw = () => response.promise;
    const list = client.request('/whatsapp/chats?accountId=account-a'); const rejected = expect(list).rejects.toMatchObject({ code: 'wa_privacy_changed' });
    client.invalidateWaPrivacy({ type: 'wa.privacy', accountId: 'account-a', jids: ['locked@s.whatsapp.net'] });
    response.resolve(Response.json({ chats: [chat()] })); await rejected; expect(client.isWaChatVisible('account-a', chat().jid)).toBe(false);
    client.raw = async () => Response.json({ chats: [chat()] }); await client.request('/whatsapp/chats?accountId=account-a');
    expect(client.isWaChatVisible('account-a', chat().jid)).toBe(true);
  });
  it('a denied open chat removes its cached name and notifies scoped subscribers', async () => {
    const { client } = make(), listener = vi.fn(); client.subscribeWaPrivacy(listener);
    client.raw = async () => Response.json({ error: { code: 'not_found', message: 'Unavailable' } }, { status: 404 });
    await expect(client.request('/whatsapp/chats/account-a/locked%40s.whatsapp.net/messages')).rejects.toMatchObject({ status: 404 });
    expect(listener).toHaveBeenCalledWith({ type: 'wa.privacy', accountId: 'account-a', jids: [chat().jid] });
    expect(client.state.data.waInbox).toEqual([chat('account-b')]);
  });
  it('a fresh accounts response revokes only an omitted linked account', async () => {
    const { client } = make(), listener = vi.fn(); client.subscribeWaPrivacy(listener);
    client.raw = async () => Response.json({ accounts: [{ id: 'account-b', privacyReady: true }] });
    await client.request('/whatsapp/accounts');
    expect(client.state.data.waInbox).toEqual([chat('account-b')]);
    expect(client.isWaChatVisible('account-a')).toBe(false); expect(client.isWaChatVisible('account-b')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenCalledWith({ type: 'wa.privacy', accountId: 'account-a', reset: true });
  });
  it('never paints private WA inbox from offline boot cache and never persists it again', async () => {
    const { client, storage } = make(); await storage.set(LAST_USER_KEY, 'fixture');
    await storage.set(bootKey('fixture'), { v: CACHE_VERSION, userId: 'fixture', savedAt: 'fixture', data: boot([chat()]) });
    client.refresh = async () => { client.refreshNetworkError = true; return false; };
    await client.start(); expect(client.state.data.waInbox).toEqual([]);
    client.state.data = boot([chat()]); client.bootDirty = true; await client.persist();
    expect((await storage.get<any>(bootKey('fixture'))).data.waInbox).toEqual([]);
  });
  it('a held boot cache cannot replace a later signed-in account', async () => {
    const { client } = make(), cached = held(); client.readBootCache = () => cached.promise; client.refresh = vi.fn();
    const start = client.start(); client.sessionGeneration++;
    client.state = { ...client.state, status: 'ready', data: { ...boot(), me: { id: 'other-user' } } };
    cached.resolve({ data: boot([chat()]) }); await start;
    expect(client.state.data.me.id).toBe('other-user'); expect(client.refresh).not.toHaveBeenCalled();
  });
  it('scopes URL decoding, GG and explicit share while leaving destination attachments alone', () => {
    expect(waPathScope('/api/v1/whatsapp/media/a/person%40lid/file')).toEqual({ accountId: 'a', jid: 'person@lid' });
    expect(waRequestScopes('/gg/side', { source: 'wa:a:person@lid' })?.scopes).toEqual([{ accountId: 'a', jid: 'person@lid' }]);
    expect(waRequestScopes('/whatsapp/share', { accountId: 'a', jid: 'person@lid' })?.scopes).toEqual([{ accountId: 'a', jid: 'person@lid' }]);
    expect(waPathScope('/api/v1/attachments/chaggu-copy')).toBeNull();
  });
});
