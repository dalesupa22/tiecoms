import type { AccountEvent } from '@tiecoms/contracts';

export type WaPrivacyEvent = Extract<AccountEvent, { type: 'wa.privacy' }>;
export interface WaPrivacyScope { accountId: string; jid?: string }
export interface WaPrivacyState { epoch: number; blockedJids: string[]; ready?: boolean }
const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };

/** Private originals have WA URLs; shared Chaggu copies have their own destination ACL. */
export function waPathScope(path: string): WaPrivacyScope | null {
  const url = new URL(path, 'http://client.invalid');
  const match = url.pathname.replace(/^\/api\/v1/, '').match(/^\/whatsapp\/(?:chats|media)\/([^/]+)\/([^/]+)(?:\/|$)/);
  return match ? { accountId: decode(match[1]!), jid: decode(match[2]!) } : null;
}
export function waSourceScope(source: unknown): WaPrivacyScope | null {
  if (typeof source !== 'string') return null;
  const match = source.match(/^wa:([^:]+):(.+)$/);
  return match ? { accountId: match[1]!, jid: match[2]! } : null;
}
export function waRequestScopes(path: string, json?: unknown): { global: boolean; scopes: WaPrivacyScope[] } | null {
  const url = new URL(path, 'http://client.invalid');
  const pathname = url.pathname.replace(/^\/api\/v1/, '');
  const body = json && typeof json === 'object' ? json as Record<string, unknown> : {};
  const direct = waPathScope(path);
  if (direct) return { global: false, scopes: [direct] };
  if (pathname.startsWith('/whatsapp')) {
    const account = pathname.match(/^\/whatsapp\/accounts\/([^/]+)/)?.[1] ?? url.searchParams.get('accountId') ?? body.accountId;
    const jid = body.jid;
    return typeof account === 'string'
      ? { global: false, scopes: [{ accountId: decode(account), ...(typeof jid === 'string' ? { jid } : {}) }] }
      : { global: true, scopes: [] };
  }
  if (pathname.startsWith('/gg/')) {
    const sources = [url.searchParams.get('source'), body.source, ...(url.searchParams.get('sources') ?? '').split(',')];
    const scopes = sources.map(waSourceScope).filter((x): x is WaPrivacyScope => !!x);
    if (scopes.length) return { global: false, scopes };
  }
  return null;
}
export function matchesWaPrivacy(event: WaPrivacyEvent, scope: WaPrivacyScope): boolean {
  return event.accountId === scope.accountId && (!!event.reset || !scope.jid || !!event.jids?.includes(scope.jid));
}
