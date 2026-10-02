import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage, TieComsClient } from '@tiecoms/client-core';
import { waPrivacyAffected, waPrivacyLease, waSourceScope } from '../src/wa-privacy.ts';

const makeClient = () => new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'privacy-fixture', storage: new MemoryStorage() });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('WhatsApp UI callbacks across privacy changes', () => {
  it('drops delayed chat/history/quote writes, while another JID and account remain valid', async () => {
    const client = makeClient();
    const locked = waPrivacyLease(client, { accountId: 'a', jid: 'private:7@s.whatsapp.net' });
    const sibling = waPrivacyLease(client, { accountId: 'a', jid: 'allowed@s.whatsapp.net' });
    const otherAccount = waPrivacyLease(client, { accountId: 'b', jid: 'private:7@s.whatsapp.net' });
    const result = deferred<{ messages: string[]; quote: string }>();
    const write = vi.fn();
    const pending = result.promise.then((value) => { if (locked()) write(value); });
    client.invalidateWaPrivacy({ type: 'wa.privacy', accountId: 'a', jids: ['private:7@s.whatsapp.net'] });
    result.resolve({ messages: ['private body'], quote: 'private author' });
    await pending;
    expect(write).not.toHaveBeenCalled();
    expect(sibling()).toBe(true);
    expect(otherAccount()).toBe(true);
    expect(waSourceScope('wa:a:private:7@s.whatsapp.net')).toEqual({ accountId: 'a', jid: 'private:7@s.whatsapp.net' });
  });

  it('does not resurrect an old GG callback after a later authoritative unlock', async () => {
    const client = makeClient(), result = deferred<string>();
    const valid = waPrivacyLease(client, waSourceScope('wa:a:secret@g.us')!);
    const draft = vi.fn();
    const pending = result.promise.then((value) => { if (valid()) draft(value); });
    client.invalidateWaPrivacy({ type: 'wa.privacy', accountId: 'a', jids: ['secret@g.us'] });
    vi.stubGlobal('fetch', vi.fn(async () => json({ chats: [{ accountId: 'a', jid: 'secret@g.us' }] })));
    await client.request('/whatsapp/chats?accountId=a');
    expect(client.isWaChatVisible('a', 'secret@g.us')).toBe(true);
    result.resolve('old private GG draft');
    await pending;
    expect(draft).not.toHaveBeenCalled();
    expect(waPrivacyLease(client, { accountId: 'a', jid: 'secret@g.us' })()).toBe(true);
  });

  it('keeps the reset account closed until a fresh accounts response reports ready', async () => {
    const client = makeClient();
    const oldA = waPrivacyLease(client, { accountId: 'a', jid: 'x@g.us' });
    const stableB = waPrivacyLease(client, { accountId: 'b', jid: 'x@g.us' });
    client.invalidateWaPrivacy({ type: 'wa.privacy', accountId: 'a', reset: true });
    expect(waPrivacyLease(client, { accountId: 'a', jid: 'x@g.us' })()).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => json({ accounts: [{ id: 'a', privacyReady: true }, { id: 'b', privacyReady: true }] })));
    await client.request('/whatsapp/accounts');
    expect(oldA()).toBe(false);
    expect(stableB()).toBe(true);
    expect(waPrivacyLease(client, { accountId: 'a', jid: 'x@g.us' })()).toBe(true);
  });

  it('rejects delayed mixed-account lists/counts while a list for an unaffected account survives', async () => {
    const client = makeClient(); let revision = 0;
    client.subscribeWaPrivacy(() => revision++);
    const all = waPrivacyLease(client, undefined, () => revision);
    const onlyB = waPrivacyLease(client, { accountId: 'b' });
    const result = deferred<unknown>(); const setList = vi.fn();
    const pending = result.promise.then((value) => { if (all()) setList(value); });
    client.invalidateWaPrivacy({ type: 'wa.privacy', accountId: 'a', reset: true });
    result.resolve({ chats: [{ accountId: 'a', name: 'Private title' }], categories: { trabajo: { total: 9 } } });
    await pending;
    expect(setList).not.toHaveBeenCalled(); expect(onlyB()).toBe(true);
  });

  it('matches resets and locks exactly, preserving canonical Chaggu and mail sources', () => {
    const lock = { type: 'wa.privacy', accountId: 'a', jids: ['secret@g.us'] } as const;
    expect(waPrivacyAffected({ ...lock, jids: [...lock.jids] }, { accountId: 'a', jid: 'secret@g.us' })).toBe(true);
    expect(waPrivacyAffected({ ...lock, jids: [...lock.jids] }, { accountId: 'a', jid: 'allowed@g.us' })).toBe(false);
    expect(waPrivacyAffected({ type: 'wa.privacy', accountId: 'a', reset: true }, { accountId: 'b', jid: 'secret@g.us' })).toBe(false);
    expect(waSourceScope('c:canonical-copy')).toBeNull(); expect(waSourceScope('mail:google:copy')).toBeNull();
  });

  it('invalidates a resolved response callback when the session changes before its UI microtask', async () => {
    const client = makeClient(), valid = waPrivacyLease(client, { accountId: 'a', jid: 'secret@g.us' });
    const write = vi.fn();
    const callback = Promise.resolve('private body').then((value) => { if (valid()) write(value); });
    (client as unknown as { sessionGeneration: number }).sessionGeneration++;
    await callback; expect(write).not.toHaveBeenCalled();
  });
});
