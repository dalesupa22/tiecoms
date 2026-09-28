/** Provider contract only: fake storage and intercepted HTTP; no real OAuth or database. */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MeetingProvider } from '@tiecoms/contracts';

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/db.ts', () => ({ pool: db, tx: vi.fn() }));
vi.mock('../src/access.ts', () => ({ conversationAccess: vi.fn() }));
vi.mock('../src/modules/calendar.ts', () => ({ createEvent: vi.fn() }));
vi.mock('../src/modules/messages.ts', () => ({ sendMessage: vi.fn() }));
vi.mock('../src/config.ts', () => ({ config: {
  jwtSecret: 'local-provider-contract-test-only-key', publicOrigin: 'https://app.example.test', apiPublicOrigin: 'https://api.example.test',
  google: { clientId: 'local-google', clientSecret: 'local-google-secret' },
  microsoft: { clientId: 'local-microsoft', clientSecret: 'local-microsoft-secret' },
} }));
import { finishConnect, startConnect } from '../src/modules/meetings.ts';

beforeEach(() => {
  vi.stubEnv('MEETINGS_ENABLED', 'true');
  vi.stubEnv('ZOOM_CLIENT_ID', 'local-zoom');
  vi.stubEnv('ZOOM_CLIENT_SECRET', 'local-zoom-secret');
  // Fixed invalid-domain endpoints ensure no environment override can reach a real provider.
  for (const provider of ['GOOGLE', 'MS', 'ZOOM']) {
    vi.stubEnv(`MEETINGS_${provider}_AUTH`, `https://${provider.toLowerCase()}.example.test/authorize`);
    vi.stubEnv(`MEETINGS_${provider}_TOKEN`, `https://${provider.toLowerCase()}.example.test/token`);
  }
  db.query.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// Zoom requires the verifier with the token request, including confidential clients:
// https://developers.zoom.us/blog/pcke-oauth-with-postman-rest-api/
it.each<MeetingProvider>(['google', 'microsoft', 'zoom'])('%s exchanges the same S256 verifier it authorized', async (provider) => {
  let flow: any;
  db.query.mockImplementation(async (sql: string, params: any[] = []) => {
    if (sql.startsWith('INSERT INTO meeting_flows')) {
      flow = { state_hash: params[0], user_id: params[1], provider: params[2], verifier: params[3], platform: params[4], native_scheme: params[5], proof_challenge: params[7], expires_at: new Date(Date.now() + 60_000) };
    }
    if (sql.startsWith('DELETE FROM meeting_flows')) {
      expect(params[0]).toEqual(flow.state_hash); expect(params[1]).toBe(provider);
      return { rows: [flow] };
    }
    return { rows: [] };
  });
  const auth = new URL((await startConnect('local-user', provider, { platform: 'web', proofChallenge: 'a'.repeat(43) })).url);
  const tokenRequest = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(`https://${provider === 'microsoft' ? 'ms' : provider}.example.test/token`);
    expect(init.method).toBe('POST');
    const form = new URLSearchParams(init.body as URLSearchParams);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('local-code');
    expect(form.get('redirect_uri')).toBe(auth.searchParams.get('redirect_uri'));
    const verifier = form.get('code_verifier');
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(createHash('sha256').update(verifier!).digest('base64url')).toBe(auth.searchParams.get('code_challenge'));
    if (provider === 'zoom') expect(new Headers(init.headers).get('authorization')).toBe(`Basic ${Buffer.from('local-zoom:local-zoom-secret').toString('base64')}`);
    return new Response(JSON.stringify({ access_token: 'local-access', refresh_token: 'local-refresh', expires_in: 3600 }), { status: 200 });
  });
  vi.stubGlobal('fetch', tokenRequest);
  const result = new URL(await finishConnect({ state: auth.searchParams.get('state')!, code: 'local-code' }, provider));
  expect(tokenRequest).toHaveBeenCalledOnce();
  expect(result.searchParams.get('receipt')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.searchParams.has('error')).toBe(false);
  expect(db.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO meeting_connections'))).toBe(false);
});
