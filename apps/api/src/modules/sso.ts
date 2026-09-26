/**
 * Inicio de sesión con Google y Microsoft (OIDC, código de autorización + PKCE).
 *
 * El servidor es el único que habla con el proveedor y guarda sus secretos; los
 * clientes (web, iOS, Android, escritorio) solo abren /start en el navegador del
 * sistema, reciben un código de un solo uso y lo canjean con su propio PKCE.
 */
import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { Platform, type AuthResult, type SsoExchangeInput, type SsoProvider } from '@tiecoms/contracts';
import { config } from '../config.ts';
import { audit, pool, tx } from '../db.ts';
import { ApiError, badRequest, unauthorized } from '../errors.ts';
import { randomToken, sha256 } from '../security.ts';
import { createSession, insertUser, placeNewUser, result, type DomainProof } from './auth.ts';
import { emailDomain, isPublicDomain } from './domains.ts';

const FLOW_TTL_MIN = 10;
const CODE_TTL_SEC = 60;
/** Tenant de las cuentas personales de Microsoft (outlook.com, hotmail…). Solo aceptamos cuentas de empresa. */
const MS_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

export interface ExternalIdentity {
  provider: SsoProvider;
  subject: string;
  tenant: string | null;
  email: string;
  /** El proveedor garantiza que la persona controla ese correo. */
  emailVerified: boolean;
  /** El proveedor garantiza además que el dominio del correo es de su organización. */
  domainProof: DomainProof | null;
  name: string;
}

interface ProviderDef {
  authorizeUrl: string;
  scope: string;
  extraParams?: Record<string, string>;
  configured(): boolean;
  clientId(): string;
  jwks: JWTVerifyGetKey;
  /** Cambia el código del proveedor por el id_token. Reemplazable en pruebas. */
  exchange(code: string, verifier: string, redirectUri: string): Promise<string>;
  identity(p: JWTPayload): ExternalIdentity;
}

async function tokenRequest(url: string, form: Record<string, string>): Promise<string> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || typeof json.id_token !== 'string') throw new ApiError(502, 'sso_token_failed', 'El proveedor no confirmó el inicio de sesión');
  return json.id_token;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

export const providers: Record<SsoProvider, ProviderDef> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email profile',
    extraParams: { prompt: 'select_account' },
    configured: () => !!(config.google.clientId && config.google.clientSecret),
    clientId: () => config.google.clientId,
    jwks: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
    exchange: (code, verifier, redirectUri) => tokenRequest('https://oauth2.googleapis.com/token', {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
      client_id: config.google.clientId, client_secret: config.google.clientSecret,
    }),
    identity(p) {
      if (p.iss !== 'https://accounts.google.com' && p.iss !== 'accounts.google.com') throw unauthorized('Emisor inesperado');
      const email = str(p.email)?.toLowerCase();
      if (!p.sub || !email) throw new ApiError(400, 'sso_no_email', 'Google no entregó un correo para esta cuenta');
      const verified = truthy(p.email_verified);
      const hd = str(p.hd)?.toLowerCase() ?? null;
      return {
        provider: 'google', subject: p.sub, tenant: hd, email, emailVerified: verified,
        // hd solo existe en cuentas de Google Workspace: la organización administra ese dominio.
        domainProof: verified && hd && emailDomain(email) === hd ? { provider: 'google', tenant: hd } : null,
        name: str(p.name) ?? email.split('@')[0]!,
      };
    },
  },
  microsoft: {
    // /organizations: solo cuentas de trabajo o escuela, de cualquier empresa.
    authorizeUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    scope: 'openid email profile',
    extraParams: { prompt: 'select_account' },
    configured: () => !!(config.microsoft.clientId && config.microsoft.clientSecret),
    clientId: () => config.microsoft.clientId,
    jwks: createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys')),
    exchange: (code, verifier, redirectUri) => tokenRequest('https://login.microsoftonline.com/organizations/oauth2/v2.0/token', {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, scope: 'openid email profile',
      client_id: config.microsoft.clientId, client_secret: config.microsoft.clientSecret,
    }),
    identity(p) {
      const tid = str(p.tid);
      const oid = str(p.oid);
      // Multi-tenant: el emisor debe corresponder al tenant del propio token.
      if (!tid || !oid || p.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) throw unauthorized('Emisor inesperado');
      if (tid === MS_CONSUMER_TENANT) throw new ApiError(400, 'sso_personal_account', 'Usa tu cuenta de Microsoft de trabajo; las cuentas personales no están habilitadas');
      // `email` solo es confiable con xms_edov (el dueño del dominio lo verificó en Entra). Sin él, el correo
      // lo puede escribir cualquiera en su tenant (ataque «nOAuth»), así que no sirve para vincular ni reclamar.
      const email = (str(p.email) ?? (str(p.preferred_username)?.includes('@') ? str(p.preferred_username) : null))?.toLowerCase();
      if (!email) throw new ApiError(400, 'sso_no_email', 'Microsoft no entregó un correo para esta cuenta');
      const verified = !!str(p.email) && truthy(p.xms_edov);
      return {
        provider: 'microsoft', subject: `${tid}:${oid}`, tenant: tid, email, emailVerified: verified,
        domainProof: verified ? { provider: 'microsoft', tenant: tid } : null,
        name: str(p.name) ?? email.split('@')[0]!,
      };
    },
  },
};

const StartQuery = z.object({
  platform: Platform.exclude(['agent']).default('web'),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal('S256'),
  org: z.string().min(16).max(200).optional(),
  org_name: z.string().trim().min(2).max(120).optional(),
  next: z.string().max(300).regex(/^\/(?!\/)[^\s\\]*$/).optional(),
  device_id: z.string().max(64).optional(),
  /** Apps nuevas: 'chaggu' (chaggu://auth/callback). Sin valor: config.nativeRedirect (apps anteriores). */
  redirect_scheme: z.enum(['chaggu', 'tiecoms']).optional(),
});

const redirectUri = (p: SsoProvider) => `${config.apiPublicOrigin}/api/v1/auth/${p}/callback`;
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

function clientTarget(platform: string, params: Record<string, string>, scheme?: string | null) {
  const base = platform === 'web' ? `${config.publicOrigin}/auth/sso` : scheme ? `${scheme}://auth/callback` : config.nativeRedirect;
  return `${base}?${new URLSearchParams(params)}`;
}

export function parseProvider(p: string): SsoProvider {
  if (p !== 'google' && p !== 'microsoft') throw badRequest('Proveedor desconocido');
  return p;
}

/** Paso 1: guarda el vuelo y devuelve la URL del proveedor más el `state` para la cookie del navegador. */
export async function start(provider: SsoProvider, query: unknown): Promise<{ url: string; state: string }> {
  const q = StartQuery.parse(query);
  const def = providers[provider];
  if (!def.configured()) throw new ApiError(503, 'sso_unavailable', 'Este inicio de sesión aún no está disponible');
  const state = randomToken(32);
  const nonce = randomToken(16);
  const verifier = randomToken(48);
  await pool.query(
    `INSERT INTO sso_flows (state_hash, provider, nonce, idp_verifier, client_challenge, platform, org_invite_token, org_name, next_path, native_scheme, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + make_interval(mins => $11))`,
    [sha256(state), provider, nonce, verifier, q.code_challenge, q.platform, q.org ?? null, q.org_name ?? null, q.next ?? null, q.redirect_scheme ?? null, FLOW_TTL_MIN],
  );
  const params = new URLSearchParams({
    client_id: def.clientId(), response_type: 'code', redirect_uri: redirectUri(provider), scope: def.scope,
    state, nonce, code_challenge: s256(verifier), code_challenge_method: 'S256', ...def.extraParams,
  });
  return { url: `${def.authorizeUrl}?${params}`, state };
}

/** Paso 2: el proveedor vuelve aquí. Siempre responde con una redirección hacia el cliente. */
export async function callback(provider: SsoProvider, query: Record<string, string | undefined>, stateCookie: string | undefined): Promise<string> {
  const state = query.state ?? '';
  const { rows } = await pool.query('DELETE FROM sso_flows WHERE state_hash = $1 AND provider = $2 RETURNING *', [sha256(state), provider]);
  const flow = rows[0];
  if (!flow) return clientTarget('web', { error: 'sso_expired', message: 'El inicio de sesión venció. Inténtalo de nuevo.' });
  const fail = (code: string, message: string) => clientTarget(flow.platform, { error: code, message }, flow.native_scheme);
  if (new Date(flow.expires_at) < new Date()) return fail('sso_expired', 'El inicio de sesión venció. Inténtalo de nuevo.');
  // El vuelo debe terminar en el mismo navegador que lo empezó.
  if (!stateCookie || stateCookie !== state) return fail('sso_state', 'No pudimos confirmar el inicio de sesión en este navegador. Inténtalo de nuevo.');
  if (query.error) return fail('sso_cancelled', query.error === 'access_denied' ? 'Cancelaste el inicio de sesión.' : 'El proveedor rechazó el inicio de sesión.');
  if (!query.code) return fail('sso_failed', 'El proveedor no devolvió un código.');

  try {
    const def = providers[provider];
    const idToken = await def.exchange(query.code, flow.idp_verifier, redirectUri(provider));
    const { payload } = await jwtVerify(idToken, def.jwks, { audience: def.clientId(), clockTolerance: 60 });
    if (payload.nonce !== flow.nonce) throw unauthorized('Nonce inválido');
    const identity = def.identity(payload);
    const userId = await resolveUser(identity, { orgInviteToken: flow.org_invite_token ?? undefined, orgName: flow.org_name ?? undefined });
    const code = randomToken(32);
    await pool.query(
      `INSERT INTO sso_codes (code_hash, user_id, provider, client_challenge, platform, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6))`,
      [sha256(code), userId, provider, flow.client_challenge, flow.platform, CODE_TTL_SEC],
    );
    return clientTarget(flow.platform, { code, ...(flow.next_path ? { next: flow.next_path } : {}) }, flow.native_scheme);
  } catch (e: any) {
    if (e instanceof ApiError) return fail(e.code, e.message);
    console.error('[sso] callback', provider, e?.code ?? e?.message);
    return fail('sso_failed', 'No pudimos completar el inicio de sesión.');
  }
}

/** Encuentra, vincula o crea a la persona detrás de la identidad externa. */
export async function resolveUser(id: ExternalIdentity, opts: { orgInviteToken?: string; orgName?: string }): Promise<string> {
  return tx(async (c) => {
    const known = await c.query(
      'SELECT i.user_id, u.disabled_at FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = $1 AND i.subject = $2',
      [id.provider, id.subject],
    );
    if (known.rows[0]) {
      if (known.rows[0].disabled_at) throw new ApiError(403, 'account_disabled', 'Esta cuenta está desactivada');
      await c.query('UPDATE user_identities SET last_login_at = now(), email = $3 WHERE provider = $1 AND subject = $2', [id.provider, id.subject, id.email]);
      await audit(c, known.rows[0].user_id, 'auth.sso_login', { type: 'user', id: known.rows[0].user_id }, { provider: id.provider });
      return known.rows[0].user_id as string;
    }
    if (!id.emailVerified) {
      throw new ApiError(403, 'sso_email_unverified', id.provider === 'microsoft'
        ? 'Tu organización no ha verificado el dominio de tu correo en Microsoft. Entra con tu correo y contraseña, o pide a tu administrador que verifique el dominio.'
        : 'Google no ha verificado el correo de esta cuenta.');
    }
    const existing = await c.query("SELECT id, disabled_at FROM users WHERE email = $1 AND kind = 'human'", [id.email]);
    let userId: string;
    if (existing.rows[0]) {
      if (existing.rows[0].disabled_at) throw new ApiError(403, 'account_disabled', 'Esta cuenta está desactivada');
      // El proveedor garantiza el correo: se vincula a la cuenta que ya existía.
      userId = existing.rows[0].id;
      await c.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [userId]);
      await audit(c, userId, 'auth.sso_linked', { type: 'user', id: userId }, { provider: id.provider });
    } else {
      const domain = emailDomain(id.email);
      const fallback = isPublicDomain(domain) ? id.name : domain.split('.')[0]!.replace(/^./, (ch) => ch.toUpperCase());
      const place = await placeNewUser(c, id.email, { orgInviteToken: opts.orgInviteToken, orgName: opts.orgName, fallbackOrgName: fallback, proof: id.domainProof });
      userId = await insertUser(c, { email: id.email, name: id.name, passwordHash: null, emailVerified: true }, place);
      await audit(c, userId, 'auth.sso_signup', { type: 'organization', id: place.orgId }, { provider: id.provider, via: place.via });
    }
    await c.query(
      'INSERT INTO user_identities (provider, subject, user_id, tenant_id, email, last_login_at) VALUES ($1,$2,$3,$4,$5, now())',
      [id.provider, id.subject, userId, id.tenant, id.email],
    );
    return userId;
  });
}

/** Paso 3: el cliente canjea el código con su code_verifier y recibe la sesión. */
export async function exchange(input: SsoExchangeInput): Promise<AuthResult> {
  // Se quema antes de validar: un intento fallido también lo invalida.
  const { rows } = await pool.query(
    'UPDATE sso_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *',
    [sha256(input.code)],
  );
  const row = rows[0];
  if (!row) throw unauthorized('El código de inicio de sesión ya no es válido');
  if (s256(input.codeVerifier) !== row.client_challenge) throw unauthorized('El código no corresponde a este dispositivo');
  if (row.platform !== input.device.platform) throw unauthorized('El código no corresponde a esta plataforma');
  return tx(async (c) => {
    const s = await createSession(c, row.user_id, input.device);
    await audit(c, row.user_id, 'auth.login', { type: 'session', id: s.sessionId }, { platform: input.device.platform, provider: row.provider });
    return result(c, row.user_id, s.sessionId, s.refreshToken);
  });
}

export async function cleanupExpired() {
  await pool.query('DELETE FROM sso_flows WHERE expires_at < now()');
  await pool.query("DELETE FROM sso_codes WHERE expires_at < now() - interval '1 hour'");
}
