import type { AccountEvent } from '@tiecoms/contracts';

export type WaPrivacyEvent = Extract<AccountEvent, { type: 'wa.privacy' }>;
export interface WaPrivacyScope { accountId: string; jid?: string }
export interface WaPrivacyClient {
  getSessionIdentity(): string;
  getWaPrivacyIdentity(accountId: string, jid?: string): string;
  isWaChatVisible(accountId: string, jid?: string): boolean;
}

/** A JID revocation affects that chat only; a reset affects its account. */
export function waPrivacyAffected(event: WaPrivacyEvent, scope: WaPrivacyScope) {
  return event.accountId === scope.accountId && (event.reset === true || !scope.jid || event.jids?.includes(scope.jid) === true);
}

export function waSourceScope(source: string): WaPrivacyScope | null {
  if (!source.startsWith('wa:')) return null;
  const rest = source.slice(3), at = rest.indexOf(':');
  return at > 0 && rest.length > at + 1 ? { accountId: rest.slice(0, at), jid: rest.slice(at + 1) } : null;
}

/** Capture before starting an async operation, then check before every UI write or next request. */
export function waPrivacyLease(client: WaPrivacyClient, scope?: WaPrivacyScope, allAccountsRevision?: () => number) {
  const session = client.getSessionIdentity();
  const identity = scope && client.getWaPrivacyIdentity(scope.accountId, scope.jid);
  const revision = allAccountsRevision?.();
  return () => client.getSessionIdentity() === session
    && (!scope || (client.getWaPrivacyIdentity(scope.accountId, scope.jid) === identity && client.isWaChatVisible(scope.accountId, scope.jid)))
    && (!allAccountsRevision || allAccountsRevision() === revision);
}
