/** Isolated Apple provider + real PostgreSQL integration. Never connects to production. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, decodeJwt, exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ publicKey: null as any }));
vi.mock('jose', async (original) => ({ ...await original<typeof import('jose')>(), createRemoteJWKSet: () => async () => provider.publicKey }));
process.env.DATABASE_URL ??= 'postgres://none:none@127.0.0.1:1/tiecoms_test_apple';
process.env.JWT_SECRET ??= 'apple-auth-isolated-test-jwt-secret-over-32';
const { config } = await import('../src/config.ts');
const apple = await import('../src/modules/apple-auth.ts');
const auth = await import('../src/modules/auth.ts');
const { deleteAccount } = await import('../src/modules/account.ts');
const { pool } = await import('../src/db.ts');
const { AppleChallengeInput, AppleCompleteInput } = await import('@tiecoms/contracts');
const { isPublicDomain } = await import('../src/modules/domains.ts');
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let localKeys: ReturnType<typeof createLocalJWKSet>;
let scratch: string;
const issued = new Map<string, { token: string; refresh: string }>();
let tokenCalls = 0;
let revokeCalls = 0;
let revokeFails = false;
let exchangeFails = false;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'chaggu-apple-test-'));
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  provider.publicKey = pair.publicKey;
  localKeys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256' }] });
  const secretPair = await generateKeyPair('ES256', { extractable: true });
  config.apple.teamId = 'TESTTEAM01'; config.apple.keyId = 'TESTKEY001'; config.apple.clientId = 'com.chaggu.app';
  config.apple.tokenEncryptionKey = randomBytes(32).toString('hex');
  config.apple.privateKeyPath = join(scratch, 'AuthKey-test.p8');
  await writeFile(config.apple.privateKeyPath, await exportPKCS8(secretPair.privateKey), { mode: 0o600 });
});
beforeEach(() => {
  tokenCalls = 0; revokeCalls = 0; revokeFails = false; exchangeFails = false;
  vi.stubGlobal('fetch', async (url: string, opts: RequestInit) => {
    const form = new URLSearchParams(String(opts.body));
    expect(form.get('client_id')).toBe('com.chaggu.app');
    const secret = decodeJwt(form.get('client_secret')!);
    expect(secret).toMatchObject({ iss: 'TESTTEAM01', sub: 'com.chaggu.app', aud: 'https://appleid.apple.com' });
    if (String(url).endsWith('/token')) {
      tokenCalls++;
      const response = issued.get(form.get('code')!);
      if (!response || exchangeFails) return new Response('{"error":"provider failure with private content"}', { status: 400 });
      issued.delete(form.get('code')!);
      return Response.json({ id_token: response.token, refresh_token: response.refresh });
    }
    if (String(url).endsWith('/revoke')) {
      revokeCalls++;
      expect(form.get('token_type_hint')).toBe('refresh_token');
      return new Response('', { status: revokeFails ? 503 : 200 });
    }
    throw new Error('Unexpected network call');
  });
});
afterAll(async () => { vi.unstubAllGlobals(); await pool.end(); await rm(scratch, { recursive: true, force: true }); });

const device = () => ({ deviceId: randomUUID(), name: 'Test iPhone', platform: 'ios' as const, contract: '2026-09-29.2' });
const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
async function token(claims: Record<string, any> = {}, algorithm = 'RS256') {
  return new SignJWT({ iss: 'https://appleid.apple.com', aud: 'com.chaggu.app', sub: 'apple-subject', nonce: 'nonce',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...claims })
    .setProtectedHeader({ alg: algorithm, kid: 'test-key' }).sign(signingKey);
}

describe('Apple cryptographic and contract rules', () => {
  it('valid signed claims and private relay email', async () => {
    expect(await apple.verifyAppleToken(await token({ email: 'Person@privaterelay.appleid.com', email_verified: 'true' }), 'nonce', new Date(), localKeys))
      .toMatchObject({ subject: 'apple-subject', email: 'person@privaterelay.appleid.com', emailVerified: true });
    expect(isPublicDomain('privaterelay.appleid.com')).toBe(true);
  });
  it.each([
    ['issuer', { iss: 'https://attacker.invalid' }], ['audience', { aud: 'com.tiecoms.app' }],
    ['audience list', { aud: ['com.chaggu.app', 'evil'] }], ['nonce', { nonce: 'other' }],
    ['expired', { exp: 1 }], ['future issuance', { iat: Math.floor(Date.now() / 1000) + 3600 }],
    ['old issuance', { iat: Math.floor(Date.now() / 1000) - 301 }], ['missing sub', { sub: undefined }],
    ['missing expiry', { exp: undefined }], ['missing issuance', { iat: undefined }], ['missing nonce', { nonce: undefined }],
  ])('rejects %s', async (_label, claims) => {
    await expect(apple.verifyAppleToken(await token(claims), 'nonce', new Date(), localKeys)).rejects.toMatchObject({ code: 'apple_invalid_credential' });
  });
  it('rejects tampered signature, wrong key, and token issued before challenge', async () => {
    const jwt = await token();
    const [head, payload, signature] = jwt.split('.');
    const altered = `${head}.${Buffer.from(JSON.stringify({ ...decodeJwt(jwt), sub: 'attacker' })).toString('base64url')}.${signature}`;
    await expect(apple.verifyAppleToken(altered, 'nonce', new Date(), localKeys)).rejects.toThrow();
    const other = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(other.publicKey), kid: 'test-key' }] });
    await expect(apple.verifyAppleToken(jwt, 'nonce', new Date(), keys)).rejects.toThrow();
    await expect(apple.verifyAppleToken(jwt, 'nonce', new Date(Date.now() + 60_000), localKeys)).rejects.toThrow();
  });
  it('encrypts with fresh IV and authenticates ciphertext and record id', () => {
    const id = randomUUID();
    const encrypted = apple.encryptAppleToken('private-refresh-value', id);
    expect(encrypted).not.toContain('private-refresh-value');
    expect(apple.decryptAppleToken(encrypted, id)).toBe('private-refresh-value');
    expect(apple.encryptAppleToken('private-refresh-value', id)).not.toBe(encrypted);
    expect(() => apple.decryptAppleToken(encrypted, randomUUID())).toThrow();
    const chunks = encrypted.split('.'); chunks[2] = Buffer.from('tampered').toString('base64url');
    expect(() => apple.decryptAppleToken(chunks.join('.'), id)).toThrow();
  });
  it('accepts only iOS, bounded credentials and S256 proofs', () => {
    const p = pkce();
    expect(AppleChallengeInput.parse({ codeChallenge: p.challenge, device: device() }).device.platform).toBe('ios');
    expect(() => AppleChallengeInput.parse({ codeChallenge: p.challenge, device: { ...device(), platform: 'android' } })).toThrow();
    expect(() => AppleChallengeInput.parse({ codeChallenge: 'short', device: device() })).toThrow();
    expect(() => AppleCompleteInput.parse({ challengeId: p.verifier, codeVerifier: 'short', identityToken: 'x'.repeat(30), authorizationCode: 'code', device: device() })).toThrow();
  });
  it('missing encryption key or signing key fail closed before a DB write or Apple request', async () => {
    const oldKey = config.apple.tokenEncryptionKey;
    config.apple.tokenEncryptionKey = '';
    await expect(apple.challenge({ codeChallenge: pkce().challenge, device: device() })).rejects.toMatchObject({ code: 'apple_unavailable' });
    config.apple.tokenEncryptionKey = oldKey;
    const oldPath = config.apple.privateKeyPath;
    config.apple.privateKeyPath = '/missing-sign-in-with-apple-key';
    await expect(apple.challenge({ codeChallenge: pkce().challenge, device: device() })).rejects.toMatchObject({ code: 'apple_unavailable' });
    config.apple.privateKeyPath = oldPath;
    const oldClient = config.apple.clientId; config.apple.clientId = 'com.other.app';
    await expect(apple.challenge({ codeChallenge: pkce().challenge, device: device() })).rejects.toMatchObject({ code: 'apple_unavailable' });
    config.apple.clientId = oldClient;
    expect(tokenCalls).toBe(0);
  });
});

// Refuse production or any non-loopback DB, even when someone exports DATABASE_URL accidentally.
const testUrl = new URL(process.env.DATABASE_URL!);
const safeDb = ['127.0.0.1', 'localhost'].includes(testUrl.hostname) && testUrl.pathname === '/tiecoms_test_apple';
const dbUp = safeDb && await pool.query('SELECT 1').then(() => true, () => false);
const integration = dbUp ? describe : describe.skip;

integration('Apple flow with isolated PostgreSQL', () => {
  async function flow(extra: { subject?: string; email?: string; claims?: Record<string, any>; exchangeClaims?: Record<string, any>; actor?: { userId: string; sessionId: string }; orgInviteToken?: string } = {}) {
    const proof = pkce(); const d = device();
    const ch = await apple.challenge({ codeChallenge: proof.challenge, device: d, orgInviteToken: extra.orgInviteToken }, extra.actor);
    const claims = { sub: extra.subject ?? randomUUID(), email: extra.email ?? `${randomUUID()}@privaterelay.appleid.com`, email_verified: true, nonce: ch.nonce, ...extra.claims };
    const nativeToken = await token(claims);
    const code = randomToken(); const refresh = randomToken();
    issued.set(code, { token: await token({ ...claims, ...extra.exchangeClaims }), refresh });
    return { input: { challengeId: ch.challengeId, codeVerifier: proof.verifier, identityToken: nativeToken, authorizationCode: code, device: d, fullName: 'Apple Tester' }, claims, refresh };
  }
  const randomToken = () => randomBytes(32).toString('base64url');
  async function existing(email = `${randomUUID()}@example.com`) {
    return auth.signup({ name: 'Existing Test', email, password: 'isolated-password-123', orgName: 'Existing Test Team', device: device() });
  }
  async function counts(query: string, params: any[] = []) { return Number((await pool.query(query, params)).rows[0].count); }

  it('registers private relay, creates no claimed domain, stores encrypted token; subsequent stable sub works without email/name', async () => {
    const f = await flow(); const signed = await apple.complete(f.input);
    expect(signed.user.email).toBe(f.claims.email);
    expect(await counts('SELECT count(*) FROM org_domains WHERE org_id = $1', [signed.user.primaryOrgId])).toBe(0);
    const vault = (await pool.query('SELECT * FROM apple_auth_tokens WHERE user_id = $1', [signed.user.id])).rows[0];
    expect(vault.encrypted_token).not.toContain(f.refresh);
    expect(apple.decryptAppleToken(vault.encrypted_token, vault.id)).toBe(f.refresh);
    const repeat = await flow({ subject: f.claims.sub, claims: { email: undefined, email_verified: undefined } });
    delete (repeat.input as any).fullName;
    const again = await apple.complete(repeat.input);
    expect(again.user.id).toBe(signed.user.id);
    expect(again.user.name).toBe('Apple Tester');
  });
  it('shared corporate email never claims or automatically joins a domain', async () => {
    const f = await flow({ email: `${randomUUID()}@corp-example.invalid` });
    const signed = await apple.complete(f.input);
    expect(await counts('SELECT count(*) FROM org_domains WHERE org_id = $1', [signed.user.primaryOrgId])).toBe(0);
  });
  it('atomic challenge claim rejects replay and concurrent duplicate completion', async () => {
    const f = await flow();
    const results = await Promise.allSettled([apple.complete(f.input), apple.complete(f.input)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(tokenCalls).toBe(1);
    await expect(apple.complete(f.input)).rejects.toMatchObject({ code: 'apple_invalid_credential' });
  });
  it('concurrent independent challenges for one Apple sub create only one identity/account', async () => {
    const subject = randomUUID(); const email = `${randomUUID()}@privaterelay.appleid.com`;
    const [a, b] = await Promise.all([flow({ subject, email }), flow({ subject, email })]);
    const [first, second] = await Promise.all([apple.complete(a.input), apple.complete(b.input)]);
    expect(first.user.id).toBe(second.user.id);
    expect(await counts("SELECT count(*) FROM user_identities WHERE provider = 'apple' AND subject = $1", [subject])).toBe(1);
  });
  it.each(['proof', 'device', 'expiry', 'nonce'])('rejects %s and cannot reuse the challenge', async (variant) => {
    const f = await flow(); const request = { ...f.input };
    if (variant === 'proof') request.codeVerifier = pkce().verifier;
    if (variant === 'device') request.device = device();
    if (variant === 'expiry') await pool.query("UPDATE apple_auth_challenges SET expires_at = now() - interval '1 second'");
    if (variant === 'nonce') request.identityToken = await token({ ...f.claims, nonce: 'wrong' });
    await expect(apple.complete(request)).rejects.toMatchObject({ code: 'apple_invalid_credential' });
    await expect(apple.complete(f.input)).rejects.toThrow();
    expect(tokenCalls).toBe(0);
  });
  it('code-exchange error stays redacted; mismatched exchange subject/audience/nonce cannot authenticate', async () => {
    const unavailable = await flow(); exchangeFails = true;
    await expect(apple.complete(unavailable.input)).rejects.toMatchObject({ code: 'apple_unavailable' }); exchangeFails = false;
    for (const exchangeClaims of [{ sub: 'wrong' }, { aud: 'com.other' }, { nonce: 'wrong' }]) {
      const f = await flow({ exchangeClaims });
      await expect(apple.complete(f.input)).rejects.toMatchObject({ code: 'apple_invalid_credential' });
      expect(await counts("SELECT count(*) FROM user_identities WHERE provider = 'apple' AND subject = $1", [f.claims.sub])).toBe(0);
    }
  });
  it('matching verified email never silently links; authenticated same-user link then login succeeds', async () => {
    const prior = await existing(); const subject = randomUUID();
    const login = await flow({ subject, email: prior.user.email });
    await expect(apple.complete(login.input)).rejects.toMatchObject({ code: 'apple_link_required' });
    expect(tokenCalls).toBe(0);
    const actor = { userId: prior.user.id, sessionId: prior.sessionId };
    const link = await flow({ subject, email: prior.user.email, actor });
    expect(await apple.complete(link.input, actor)).toEqual({ linked: true });
    const signin = await flow({ subject, email: prior.user.email });
    expect((await apple.complete(signin.input)).user.id).toBe(prior.user.id);
  });
  it('link needs same authenticated actor/session and never replaces an existing Apple identity', async () => {
    const prior = await existing(); const actor = { userId: prior.user.id, sessionId: prior.sessionId };
    const bad = await flow({ actor });
    await expect(apple.complete(bad.input, { ...actor, sessionId: randomUUID() })).rejects.toMatchObject({ code: 'apple_invalid_credential' });
    const first = await flow({ actor }); await apple.complete(first.input, actor);
    const replacement = await flow({ actor });
    await expect(apple.complete(replacement.input, actor)).rejects.toMatchObject({ code: 'apple_identity_linked' });
    expect(await counts("SELECT count(*) FROM user_identities WHERE provider = 'apple' AND user_id = $1", [prior.user.id])).toBe(1);
  });
  it('Apple subject owned by another user cannot be linked to a different user', async () => {
    const first = await flow(); const owner = await apple.complete(first.input);
    const prior = await existing(); const actor = { userId: prior.user.id, sessionId: prior.sessionId };
    const theft = await flow({ actor, subject: first.claims.sub, email: owner.user.email });
    await expect(apple.complete(theft.input, actor)).rejects.toMatchObject({ code: 'apple_identity_linked' });
  });
  it('restricted invitations reject private relay mismatch; unrestricted invitations still work', async () => {
    const owner = await existing(); const restricted = randomToken(); const unrestricted = randomToken();
    await pool.query(`INSERT INTO org_invitations (org_id, invited_by, token_hash, email, role, expires_at) VALUES
      ($1,$2,$3,'invited@example.com','member',now()+interval '1 hour'),($1,$2,$4,NULL,'member',now()+interval '1 hour')`,
      [owner.user.primaryOrgId, owner.user.id, createHash('sha256').update(restricted).digest(), createHash('sha256').update(unrestricted).digest()]);
    const bad = await flow({ orgInviteToken: restricted });
    await expect(apple.complete(bad.input)).rejects.toMatchObject({ code: 'apple_invitation_mismatch' });
    expect(await counts('SELECT count(*) FROM users WHERE email = $1', [bad.claims.email])).toBe(0);
    const good = await flow({ orgInviteToken: unrestricted });
    expect((await apple.complete(good.input)).user.primaryOrgId).toBe(owner.user.primaryOrgId);
  });
  it('deletion commits while Apple is down, queues encrypted-only revocation; retry cleans vault without reviving auth', async () => {
    const f = await flow(); const signed = await apple.complete(f.input);
    const pending = await flow({ subject: f.claims.sub, email: signed.user.email });
    revokeFails = true;
    expect(await deleteAccount(signed.user.id, { confirmEmail: signed.user.email! })).toEqual({ ok: true });
    await expect(auth.refresh(signed.refreshToken!)).rejects.toThrow();
    expect(await counts("SELECT count(*) FROM user_identities WHERE user_id = $1", [signed.user.id])).toBe(0);
    const vault = (await pool.query('SELECT * FROM apple_auth_tokens WHERE subject_hash = $1', [createHash('sha256').update(f.claims.sub).digest()])).rows[0];
    expect(vault).toMatchObject({ user_id: null, revoke_pending: true });
    const job = (await pool.query("SELECT payload FROM jobs WHERE dedupe_key = $1", [`apple-revoke:${vault.id}`])).rows[0];
    expect(job.payload).toEqual({ tokenId: vault.id });
    expect(JSON.stringify(job)).not.toContain(f.refresh);
    await expect(apple.revokeAppleToken(vault.id)).rejects.toMatchObject({ code: 'apple_unavailable' });
    expect(await counts('SELECT count(*) FROM apple_auth_tokens WHERE id = $1', [vault.id])).toBe(1);
    await expect(apple.complete(pending.input)).rejects.toMatchObject({ code: 'apple_unavailable' });
    revokeFails = false;
    await apple.revokeAppleToken(vault.id); await apple.revokeAppleToken(vault.id);
    expect(await counts('SELECT count(*) FROM apple_auth_tokens WHERE id = $1', [vault.id])).toBe(0);
    expect(revokeCalls).toBe(2); // Third invocation observes already-completed deletion.
    expect((await pool.query('SELECT disabled_at FROM users WHERE id = $1', [signed.user.id])).rows[0].disabled_at).not.toBeNull();
    const stale = await flow({ subject: f.claims.sub, email: signed.user.email, claims: { iat: Math.floor(Date.now() / 1000) - 1 } });
    await expect(apple.complete(stale.input)).rejects.toMatchObject({ code: 'apple_invalid_credential' });
  });
  async function waitForLocks(fragment: string, minimum = 1) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const n = await counts("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1", [`%${fragment}%`]);
      if (n >= minimum) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Did not observe expected PostgreSQL lock wait: ${fragment}`);
  }
  it.each(['login', 'link'])('concurrent %s and deletion use one lock order and leave no active session', async (mode) => {
    const first = await flow(); const account = await apple.complete(first.input);
    const actor = { userId: account.user.id, sessionId: account.sessionId };
    const concurrent = await flow({ subject: first.claims.sub, email: account.user.email, ...(mode === 'link' ? { actor } : {}) });
    const barrier = await pool.connect();
    await barrier.query('BEGIN');
    await barrier.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`apple:${first.claims.sub}`]);
    try {
      const signing = mode === 'link' ? apple.complete(concurrent.input, actor) : apple.complete(concurrent.input);
      // Attach rejection immediately while the barrier intentionally holds both operations.
      const observedSign = signing.then((value) => ({ value }), (error) => ({ error }));
      await waitForLocks('pg_advisory_xact_lock');
      const deleting = deleteAccount(account.user.id, { confirmEmail: account.user.email! });
      const observedDelete = deleting.then((value) => ({ value }), (error) => ({ error }));
      await waitForLocks('pg_advisory_xact_lock', 2);
      await barrier.query('COMMIT');
      const results = await Promise.all([observedSign, observedDelete]);
      expect(results[1]).toEqual({ value: { ok: true } });
      expect(await counts('SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [account.user.id])).toBe(0);
      expect(await counts("SELECT count(*) FROM user_identities WHERE provider = 'apple' AND subject = $1", [first.claims.sub])).toBe(0);
      expect((await pool.query('SELECT disabled_at FROM users WHERE id = $1', [account.user.id])).rows[0].disabled_at).not.toBeNull();
    } finally { await barrier.query('ROLLBACK'); barrier.release(); }
  });
  it('a session revocation that wins the race prevents authenticated Apple linking', async () => {
    const account = await existing(); const actor = { userId: account.user.id, sessionId: account.sessionId };
    const linking = await flow({ actor });
    const barrier = await pool.connect();
    await barrier.query('BEGIN');
    await barrier.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [account.sessionId]);
    try {
      const pending = apple.complete(linking.input, actor).then((value) => ({ value }), (error) => ({ error }));
      await waitForLocks('JOIN sessions s ON s.user_id');
      await barrier.query('COMMIT');
      const outcome = await pending;
      expect(outcome).toMatchObject({ error: { code: 'unauthorized' } });
      expect(await counts("SELECT count(*) FROM user_identities WHERE provider = 'apple' AND user_id = $1", [account.user.id])).toBe(0);
      expect(await counts('SELECT count(*) FROM apple_auth_tokens WHERE user_id = $1', [account.user.id])).toBe(0);
    } finally { await barrier.query('ROLLBACK'); barrier.release(); }
  });
  it('a first link racing deletion restarts with its new subject lock, then deletes it without deadlock', async () => {
    const account = await existing(); const actor = { userId: account.user.id, sessionId: account.sessionId };
    const linking = await flow({ actor });
    const barrier = await pool.connect();
    await barrier.query('BEGIN'); await barrier.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [account.user.id]);
    try {
      const linkingResult = apple.complete(linking.input, actor).then((value) => ({ value }), (error) => ({ error }));
      await waitForLocks('JOIN sessions s ON s.user_id');
      const deletingResult = deleteAccount(account.user.id, { confirmEmail: account.user.email!, password: 'isolated-password-123' }).then((value) => ({ value }), (error) => ({ error }));
      await waitForLocks('SELECT id FROM users WHERE id');
      await barrier.query('COMMIT');
      const results = await Promise.all([linkingResult, deletingResult]);
      expect(results[0]).toEqual({ value: { linked: true } });
      expect(results[1]).toEqual({ value: { ok: true } });
      expect(await counts("SELECT count(*) FROM user_identities WHERE user_id = $1", [account.user.id])).toBe(0);
      expect(await counts('SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [account.user.id])).toBe(0);
      const tombstone = await counts('SELECT count(*) FROM apple_auth_deletions WHERE subject_hash = $1', [createHash('sha256').update(linking.claims.sub).digest()]);
      expect(tombstone).toBe(1);
    } finally { await barrier.query('ROLLBACK'); barrier.release(); }
  });
  it('janitor recovers interrupted post-exchange persistence and cleanup is idempotent', async () => {
    const id = randomUUID(); const refresh = randomToken();
    await pool.query("INSERT INTO apple_auth_tokens (id,subject_hash,encrypted_token,created_at) VALUES ($1,$2,$3,now()-interval '11 minutes')",
      [id, randomBytes(32), apple.encryptAppleToken(refresh, id)]);
    await apple.cleanupAppleAuth(); await apple.cleanupAppleAuth();
    expect(await counts('SELECT count(*) FROM jobs WHERE dedupe_key = $1', [`apple-revoke:${id}`])).toBe(1);
    await apple.revokeAppleToken(id);
    expect(await counts('SELECT count(*) FROM apple_auth_tokens WHERE id = $1', [id])).toBe(0);
  });
});

integration('Apple HTTP routes', () => {
  it('route validation, no-store and authenticated linking are enforced at the real HTTP boundary', async () => {
    const { buildHttp } = await import('../src/http.ts');
    const app = await buildHttp();
    try {
      const proof = pkce(); const d = device();
      const challenge = await app.inject({ method: 'POST', url: '/api/v1/auth/apple/challenge', payload: { codeChallenge: proof.challenge, device: d } });
      expect(challenge.statusCode).toBe(200); expect(challenge.headers['cache-control']).toBe('no-store');
      const ch = challenge.json();
      const code = randomUUID();
      const jwt = await token({ sub: randomUUID(), email: `${randomUUID()}@privaterelay.appleid.com`, email_verified: true, nonce: ch.nonce });
      issued.set(code, { token: jwt, refresh: randomBytes(32).toString('base64url') });
      const signed = await app.inject({ method: 'POST', url: '/api/v1/auth/apple/complete', payload: {
        challengeId: ch.challengeId, codeVerifier: proof.verifier, identityToken: jwt, authorizationCode: code, device: d,
      } });
      expect(signed.statusCode).toBe(200); expect(signed.headers['cache-control']).toBe('no-store');
      expect(signed.json().refreshToken).toBeTruthy();
      const denied = await app.inject({ method: 'POST', url: '/api/v1/auth/apple/link/challenge', payload: { codeChallenge: proof.challenge, device: d } });
      expect(denied.statusCode).toBe(401);
      const allowed = await app.inject({ method: 'POST', url: '/api/v1/auth/apple/link/challenge', headers: { authorization: `Bearer ${signed.json().accessToken}` }, payload: { codeChallenge: proof.challenge, device: d } });
      expect(allowed.statusCode).toBe(200); expect(allowed.headers['cache-control']).toBe('no-store');
      const invalid = await app.inject({ method: 'POST', url: '/api/v1/auth/apple/challenge', payload: { codeChallenge: proof.challenge, device: { ...d, platform: 'android' } } });
      expect(invalid.statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
