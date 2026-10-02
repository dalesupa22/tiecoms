import { matchesWaPrivacy, waPathScope, type WaPrivacyEvent } from '@tiecoms/client-core';

/** Revocation ignores leases: an open private original must disappear immediately. */
export function invalidateWaBlobCache<T extends { path: string; url?: string }>(cache: Map<string, T>, event: WaPrivacyEvent, revoke: (url: string) => void) {
  for (const [key, entry] of cache) {
    const scope = waPathScope(entry.path);
    if (!scope || !matchesWaPrivacy(event, scope)) continue;
    cache.delete(key);
    if (entry.url) revoke(entry.url);
  }
}
