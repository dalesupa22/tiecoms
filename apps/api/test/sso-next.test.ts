/** Real SSO validation and callbacks with local signing keys and mocked storage; no DB or provider traffic. */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SsoProvider } from '@tiecoms/contracts';

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/db.ts', () => ({ pool: db, tx: (fn: (c: typeof db) => unknown) => fn(db), audit: vi.fn() }));
vi.mock('../src/modules/auth.ts', () => ({ createSession: vi.fn(), insertUser: vi.fn(), placeNewUser: vi.fn(), result: vi.fn() }));
vi.mock('../src/config.ts', () => ({ config: {
  jwtSecret: 'local-sso-continuation-test-only-key', publicOrigin: 'https://app.example.test', apiPublicOrigin: 'https://api.example.test',
  nativeRedirect: 'tiecoms://auth/callback',
  google: { clientId: 'local-google', clientSecret: 'local-google-secret' },
  microsoft: { clientId: 'local-microsoft', clientSecret: 'local-microsoft-secret' },
} }));
import { callback, providers, start } from '../src/modules/sso.ts';

let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let flow: Record<string, any>;
const tenant = '11111111-2222-3333-4444-555555555555';
const query = { platform: 'web', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  key = pair.privateKey;
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'local', alg: 'RS256' };
  for (const provider of Object.values(providers)) provider.jwks = createLocalJWKSet({ keys: [jwk] });
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
  db.query.mockReset().mockImplementation(async (sql: string, params: any[] = []) => {
    if (sql.startsWith('INSERT INTO sso_flows')) {
      flow = { state_hash: params[0], provider: params[1], nonce: params[2], idp_verifier: params[3], client_challenge: params[4], platform: params[5], next_path: params[8], native_scheme: params[9], expires_at: new Date(Date.now() + 60_000) };
    }
    if (sql.startsWith('DELETE FROM sso_flows')) {
      expect(params).toEqual([flow.state_hash, flow.provider]);
      return { rows: [flow] };
    }
    if (sql.startsWith('SELECT i.user_id')) return { rows: [{ user_id: 'local-user' }] };
    return { rows: [] };
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const continuation = `/autorizar-ia?${new URLSearchParams({
  response_type: 'code', client_id: 'local-chatgpt', redirect_uri: 'https://chatgpt.com/connector/oauth/local-chatgpt',
  code_challenge: 'b'.repeat(43), code_challenge_method: 'S256', state: 's'.repeat(1024), scope: 'read write',
})}`;

describe.each<SsoProvider>(['google', 'microsoft'])('%s SSO continuation', (provider) => {
  it.each(['/autorizar-ia?client_id=local-claude', continuation, `/${'x'.repeat(4095)}`])('preserves the complete relative next (%#)', async (next) => {
    const { url, state } = await start(provider, { ...query, next });
    expect(flow.next_path).toBe(next);
    const authorize = new URL(url);
    vi.spyOn(providers[provider], 'exchange').mockImplementation(async () => new SignJWT({
      iss: provider === 'google' ? 'https://accounts.google.com' : `https://login.microsoftonline.com/${tenant}/v2.0`,
      sub: 'local-subject', tid: tenant, oid: 'local-object', email: 'local@example.test', email_verified: true, xms_edov: true,
      aud: `local-${provider}`, nonce: authorize.searchParams.get('nonce'),
    }).setProtectedHeader({ alg: 'RS256', kid: 'local' }).setIssuedAt().setExpirationTime('5m').sign(key));
    const target = new URL(await callback(provider, { code: 'local-provider-code', state }, state));
    expect(target.origin + target.pathname).toBe('https://app.example.test/auth/sso');
    expect(target.searchParams.get('next')).toBe(next);
    expect(target.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(target.searchParams.has('error')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://evil.example', '//evil.example', '/\\evil.example', '/path\\other',
    '/with space', '/with\ttab', '/with\nnewline', `/${'x'.repeat(4096)}`,
  ])('rejects unsafe or oversized next before storage (%#)', async (next) => {
    await expect(start(provider, { ...query, next })).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: ['next'] })]) });
    expect(db.query).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
