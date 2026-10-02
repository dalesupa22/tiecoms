import { describe, expect, it, vi } from 'vitest';
import { invalidateWaBlobCache } from '../src/wa-blob-cache.ts';
describe('private WA media cache', () => {
  it('revokes a loaded original, forgets pending media, and preserves other account/chat and canonical copies', () => {
    const original = (account: string, jid: string, url?: string) => ({ path: `/api/v1/whatsapp/media/${account}/${encodeURIComponent(jid)}/file`, url });
    const cache = new Map([
      ['revoked', original('a', 'person@lid', 'blob:private')], ['pending', original('a', 'person@lid')],
      ['same-account', original('a', 'other@lid', 'blob:other')], ['other-account', original('b', 'person@lid', 'blob:b')],
      ['shared-copy', { path: '/api/v1/attachments/copy', url: 'blob:canonical' }],
    ]), revoke = vi.fn();
    invalidateWaBlobCache(cache, { type: 'wa.privacy', accountId: 'a', jids: ['person@lid'] }, revoke);
    expect([...cache.keys()]).toEqual(['same-account', 'other-account', 'shared-copy']); expect(revoke.mock.calls).toEqual([['blob:private']]);
    invalidateWaBlobCache(cache, { type: 'wa.privacy', accountId: 'a', reset: true }, revoke);
    expect([...cache.keys()]).toEqual(['other-account', 'shared-copy']); expect(revoke.mock.calls).toEqual([['blob:private'], ['blob:other']]);
  });
});
