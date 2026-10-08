/** Native Apple authentication. Apple credentials never pass through browser SSO. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { AppleChallengeDTO, AppleChallengeInput, AppleCompleteInput, AuthResult } from '@tiecoms/contracts';
import { config } from '../config.ts';
import { audit, pool, tx, type Tx } from '../db.ts';
import { ApiError, unauthorized } from '../errors.ts';
import { randomToken, sha256 } from '../security.ts';
import { createSession, insertUser, placeNewUser, result } from './auth.ts';

const ISSUER = 'https://appleid.apple.com';
const CLIENT_ID = 'com.chaggu.app';
const TTL_SECONDS = 300;
const appleKeys = createRemoteJWKSet(new URL(`${ISSUER}/auth/keys`));
const s256 = (value: string) => createHash('sha256').update(value).digest('base64url');
type LinkActor = { userId: string; sessionId: string };
type AppleIdentity = { subject: string; email: string | null; emailVerified: boolean; issuedAt: number };
const unavailable = () => new ApiError(503, 'apple_unavailable', 'El inicio de sesión con Apple no está disponible temporalmente. Inténtalo de nuevo.');
const invalid = () => new ApiError(401, 'apple_invalid_credential', 'No pudimos confirmar el inicio de sesión con Apple. Inténtalo de nuevo.');
const linkRequired = () => new ApiError(409, 'apple_link_required', 'Entra con tu método actual y vincula Apple desde Tú > Cuenta.');

function encryptionKey(): Buffer {
  if (!/^[a-fA-F0-9]{64}$/.test(config.apple.tokenEncryptionKey)) throw unavailable();
  return Buffer.from(config.apple.tokenEncryptionKey, 'hex');
}

async function clientSecret(): Promise<string> {
  const a = config.apple;
  if (a.clientId !== CLIENT_ID || !/^[A-Z0-9]{10}$/.test(a.teamId) || !/^[A-Z0-9]{10}$/.test(a.keyId) || !a.privateKeyPath) throw unavailable();
  encryptionKey();
  try {
    const key = await importPKCS8(await readFile(a.privateKeyPath, 'utf8'), 'ES256');
    return await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: a.keyId })
      .setIssuer(a.teamId).setSubject(CLIENT_ID).setAudience(ISSUER).setIssuedAt().setExpirationTime('5m').sign(key);
  } catch { throw unavailable(); }
}

/** Each record authenticates its id too, so ciphertext cannot be moved between accounts. */
export function encryptAppleToken(token: string, recordId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`chaggu.apple.v1:${recordId}`));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}
export function decryptAppleToken(value: string, recordId: string): string {
  try {
    const [version, iv, body, tag, extra] = value.split('.');
    if (version !== 'v1' || !iv || !body || !tag || extra) throw unavailable();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`chaggu.apple.v1:${recordId}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch { throw unavailable(); }
}

/** Cryptographic verification applies to BOTH the native token and Apple's code-exchange token. */
export async function verifyAppleToken(token: string, nonce: string, createdAt: Date, keys: JWTVerifyGetKey = appleKeys): Promise<AppleIdentity> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'], issuer: ISSUER, audience: CLIENT_ID, requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
      maxTokenAge: '5m', clockTolerance: 10,
    });
    if (payload.aud !== CLIENT_ID || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255
      || payload.nonce !== nonce || !Number.isSafeInteger(payload.iat) || payload.iat! * 1000 < createdAt.getTime() - 30_000) throw invalid();
    let email: string | null = null;
    if (payload.email !== undefined) email = z.email().max(254).parse(payload.email).toLowerCase();
    return { subject: payload.sub, email, emailVerified: payload.email_verified === true || payload.email_verified === 'true', issuedAt: payload.iat! };
  } catch { throw invalid(); }
}

async function applePost(path: 'token' | 'revoke', form: Record<string, string>): Promise<any> {
  try {
    const response = await fetch(`${ISSUER}/auth/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form), signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!response.ok) throw unavailable();
    if (path === 'revoke') return {};
    return await response.json();
  } catch { throw unavailable(); } // Never surface provider bodies, authorization codes or tokens in logs/errors.
}

export async function challenge(input: AppleChallengeInput, actor?: LinkActor): Promise<AppleChallengeDTO> {
  await clientSecret(); // Fail closed on missing/invalid credentials before opening Apple's authorization sheet.
  const challengeId = randomToken(32);
  const nonce = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
  await pool.query(
    `INSERT INTO apple_auth_challenges (challenge_hash, nonce, client_challenge, device_id, link_user_id, link_session_id, org_invite_token, org_name, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [sha256(challengeId), nonce, input.codeChallenge, input.device.deviceId, actor?.userId ?? null, actor?.sessionId ?? null,
      actor ? null : input.orgInviteToken ?? null, actor ? null : input.orgName ?? null, expiresAt],
  );
  return { challengeId, nonce, expiresAt };
}

async function resolveAppleUser(c: Tx, identity: AppleIdentity, flow: any, input: AppleCompleteInput, actor?: LinkActor): Promise<string> {
  // Serialize by stable subject, including a concurrent first login and explicit link.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`apple:${identity.subject}`]);
  const deleted = await c.query('SELECT deleted_at FROM apple_auth_deletions WHERE subject_hash = $1', [sha256(identity.subject)]);
  if (deleted.rows[0] && identity.issuedAt * 1000 <= new Date(deleted.rows[0].deleted_at).getTime()) throw invalid();
  const revoking = await c.query('SELECT 1 FROM apple_auth_tokens WHERE subject_hash = $1 AND revoke_pending = true LIMIT 1', [sha256(identity.subject)]);
  if (revoking.rows.length) throw unavailable();
  const known = await c.query(
    `SELECT i.user_id, u.disabled_at FROM user_identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = 'apple' AND i.subject = $1`, [identity.subject],
  );
  if (actor && known.rows[0] && known.rows[0].user_id !== actor.userId) throw new ApiError(409, 'apple_identity_linked', 'Esta cuenta de Apple ya está vinculada a otra cuenta de Chaggu.');
  // Every path uses subject advisory -> user row. Deletion acquires the same
  // order before anonymizing, so a login/link cannot revive the deleted account.
  if (actor) {
    const active = await c.query(`SELECT u.id FROM users u JOIN sessions s ON s.user_id = u.id
      WHERE u.id = $1 AND s.id = $2 AND u.disabled_at IS NULL AND s.revoked_at IS NULL AND s.expires_at > now()
      FOR NO KEY UPDATE OF u FOR UPDATE OF s`, [actor.userId, actor.sessionId]);
    if (!active.rows.length) throw unauthorized();
  } else if (known.rows[0]) {
    const active = await c.query('SELECT id FROM users WHERE id = $1 AND disabled_at IS NULL FOR NO KEY UPDATE', [known.rows[0].user_id]);
    if (!active.rows.length) throw unauthorized();
  }
  if (known.rows[0]) {
    if (known.rows[0].disabled_at) throw unauthorized();
    await c.query("UPDATE user_identities SET last_login_at = now() WHERE provider = 'apple' AND subject = $1", [identity.subject]);
    return known.rows[0].user_id;
  }
  if (!identity.email || !identity.emailVerified) throw new ApiError(403, 'apple_email_unverified', 'Apple no confirmó el correo. Autoriza compartir tu correo o usar Ocultar mi correo.');
  // Separate subject and email locks avoid concurrent duplicate accounts, but email is NEVER authority to link.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`apple-email:${identity.email}`]);
  const existing = await c.query("SELECT id FROM users WHERE email = $1 AND kind = 'human'", [identity.email]);
  let userId: string;
  if (actor) {
    if (existing.rows[0] && existing.rows[0].id !== actor.userId) throw linkRequired();
    const other = await c.query("SELECT subject FROM user_identities WHERE provider = 'apple' AND user_id = $1", [actor.userId]);
    if (other.rows.length) throw new ApiError(409, 'apple_identity_linked', 'Tu cuenta ya tiene una cuenta de Apple vinculada.');
    userId = actor.userId;
  } else {
    if (existing.rows.length) throw linkRequired();
    const name = input.fullName || 'Usuario de Chaggu'; // Apple returns the name only on first consent; it is display data, never identity proof.
    let place: Awaited<ReturnType<typeof placeNewUser>>;
    try {
      place = await placeNewUser(c, identity.email, { orgInviteToken: flow.org_invite_token ?? undefined,
        orgName: flow.org_name ?? undefined, fallbackOrgName: input.fullName ? `Equipo de ${input.fullName}` : 'Mi equipo', skipDomainPlacement: true });
    } catch (error) {
      if (flow.org_invite_token && error instanceof ApiError) throw new ApiError(403, 'apple_invitation_mismatch', 'No pudimos usar esta invitación con la cuenta de Apple. Usa el correo invitado o solicita una invitación compatible.');
      throw error;
    }
    userId = await insertUser(c, { email: identity.email, name, passwordHash: null, emailVerified: true }, place);
  }
  await c.query("INSERT INTO user_identities (provider, subject, user_id, email, last_login_at) VALUES ('apple',$1,$2,$3,now())", [identity.subject, userId, identity.email]);
  await audit(c, userId, actor ? 'auth.apple_linked' : 'auth.apple_signup', { type: 'user', id: userId });
  return userId;
}

export async function complete(input: AppleCompleteInput): Promise<AuthResult>;
export async function complete(input: AppleCompleteInput, actor: LinkActor): Promise<{ linked: true }>;
export async function complete(input: AppleCompleteInput, actor?: LinkActor): Promise<AuthResult | { linked: true }> {
  const secret = await clientSecret();
  // Burn exactly once BEFORE any provider network operation. Invalid proof is burned too.
  const claimed = await pool.query('DELETE FROM apple_auth_challenges WHERE challenge_hash = $1 AND expires_at > now() RETURNING *', [sha256(input.challengeId)]);
  const flow = claimed.rows[0];
  if (!flow || flow.device_id !== input.device.deviceId || input.device.platform !== 'ios'
    || flow.link_user_id !== (actor?.userId ?? null) || flow.link_session_id !== (actor?.sessionId ?? null)
    || !timingSafeEqual(Buffer.from(s256(input.codeVerifier)), Buffer.from(flow.client_challenge))) throw invalid();
  const native = await verifyAppleToken(input.identityToken, flow.nonce, new Date(flow.created_at));
  const revoking = await pool.query('SELECT 1 FROM apple_auth_tokens WHERE subject_hash = $1 AND revoke_pending = true LIMIT 1', [sha256(native.subject)]);
  if (revoking.rows.length) throw unavailable();
  // Reject obvious collisions before exchanging Apple's one-use authorization code.
  // Verified email alone never links; even the error text discloses no other account details.
  const owner = (await pool.query("SELECT user_id FROM user_identities WHERE provider = 'apple' AND subject = $1", [native.subject])).rows[0];
  if (owner && actor && owner.user_id !== actor.userId) throw new ApiError(409, 'apple_identity_linked', 'Esta cuenta de Apple ya está vinculada a otra cuenta de Chaggu.');
  if (!owner && native.email) {
    const match = (await pool.query("SELECT id FROM users WHERE email = $1 AND kind = 'human'", [native.email])).rows[0];
    if (match && match.id !== actor?.userId) throw linkRequired();
  }
  const exchanged = await applePost('token', { grant_type: 'authorization_code', code: input.authorizationCode, client_id: CLIENT_ID, client_secret: secret });
  if (typeof exchanged.id_token !== 'string' || typeof exchanged.refresh_token !== 'string' || !exchanged.refresh_token || exchanged.refresh_token.length > 16384) throw invalid();
  const verified = await verifyAppleToken(exchanged.id_token, flow.nonce, new Date(flow.created_at));
  if (verified.subject !== native.subject) throw invalid();
  // Persist before account creation so process interruption cannot lose the token's revocation obligation.
  const tokenId = randomUUID();
  await pool.query('INSERT INTO apple_auth_tokens (id, subject_hash, encrypted_token) VALUES ($1,$2,$3)',
    [tokenId, sha256(verified.subject), encryptAppleToken(exchanged.refresh_token, tokenId)]);
  try {
    return await tx(async (c) => {
      const userId = await resolveAppleUser(c, verified, flow, input, actor);
      await c.query('UPDATE apple_auth_tokens SET user_id = $2 WHERE id = $1', [tokenId, userId]);
      if (actor) return { linked: true as const };
      const session = await createSession(c, userId, input.device);
      await audit(c, userId, 'auth.login', { type: 'session', id: session.sessionId }, { platform: 'ios', provider: 'apple' });
      return result(c, userId, session.sessionId, session.refreshToken);
    });
  } catch (error: any) {
    // The janitor also handles an interruption before this transaction can enqueue revocation.
    await tx(async (c) => { await enqueueAppleRevocations(c, [tokenId]); });
    if (error instanceof ApiError) throw error;
    if (error?.code === '23505') throw linkRequired();
    throw unavailable();
  }
}

async function enqueueAppleRevocations(c: Tx, ids: string[]) {
  for (const id of ids) {
    await c.query('UPDATE apple_auth_tokens SET user_id = NULL, revoke_pending = true WHERE id = $1', [id]);
    await c.query(`INSERT INTO jobs (kind, payload, dedupe_key, max_attempts) VALUES ('apple.revoke', $1, $2, 100)
      ON CONFLICT (dedupe_key) DO NOTHING`, [JSON.stringify({ tokenId: id }), `apple-revoke:${id}`]);
  }
}

/** Acquire BEFORE the user row, matching login/link's subject -> user order. */
export async function lockAppleAccountForDeletion(c: Tx, userId: string) {
  const identities = await c.query("SELECT subject FROM user_identities WHERE provider = 'apple' AND user_id = $1", [userId]);
  for (const identity of identities.rows) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`apple:${identity.subject}`]);
  }
  return identities.rows.map((identity) => identity.subject as string);
}

/** Runs INSIDE account deletion after locking the user: both operations commit atomically. */
export async function queueAppleAccountRevocation(c: Tx, userId: string, lockedSubjects: string[]) {
  const identities = await c.query("SELECT subject FROM user_identities WHERE provider = 'apple' AND user_id = $1", [userId]);
  // A first link can commit between the initial identity lookup and the user lock.
  // Restart instead of acquiring its subject lock in the inverse order.
  if (identities.rows.some((identity) => !lockedSubjects.includes(identity.subject))) {
    throw Object.assign(new Error('Apple identity changed during account deletion'), { code: '40001' });
  }
  for (const identity of identities.rows) {
    await c.query(`INSERT INTO apple_auth_deletions (subject_hash) VALUES ($1)
      ON CONFLICT (subject_hash) DO UPDATE SET deleted_at = now()`, [sha256(identity.subject)]);
  }
  const tokens = await c.query('SELECT id FROM apple_auth_tokens WHERE user_id = $1 FOR UPDATE', [userId]);
  await enqueueAppleRevocations(c, tokens.rows.map((r) => r.id));
  await c.query('DELETE FROM apple_auth_challenges WHERE link_user_id = $1', [userId]);
}

/** Provider revocation is idempotent; a crash after success retries safely before removing ciphertext. */
export async function revokeAppleToken(tokenId: string) {
  if (!z.uuid().safeParse(tokenId).success) throw unavailable();
  const row = (await pool.query('SELECT encrypted_token FROM apple_auth_tokens WHERE id = $1 AND revoke_pending = true AND user_id IS NULL', [tokenId])).rows[0];
  if (!row) return;
  const secret = await clientSecret();
  await applePost('revoke', { client_id: CLIENT_ID, client_secret: secret, token: decryptAppleToken(row.encrypted_token, tokenId), token_type_hint: 'refresh_token' });
  await pool.query('DELETE FROM apple_auth_tokens WHERE id = $1 AND revoke_pending = true AND user_id IS NULL', [tokenId]);
}

export async function cleanupAppleAuth() {
  await pool.query('DELETE FROM apple_auth_challenges WHERE expires_at < now()');
  await pool.query("DELETE FROM apple_auth_deletions WHERE deleted_at < now() - interval '10 minutes'");
  await tx(async (c) => {
    const orphaned = await c.query("SELECT id FROM apple_auth_tokens WHERE user_id IS NULL AND revoke_pending = false AND created_at < now() - interval '10 minutes' FOR UPDATE SKIP LOCKED");
    await enqueueAppleRevocations(c, orphaned.rows.map((r) => r.id));
  });
}
