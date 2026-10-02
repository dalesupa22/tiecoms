/**
 * OAuth 2.1 del conector MCP (2-oct-2026, docs/MCP.md). Claude, Codex o ChatGPT se conectan solo con la URL
 * `https://app.chaggu.com/api/mcp`: descubren este servidor (RFC 9728 / RFC 8414), se registran solos (RFC 7591),
 * abren /autorizar-ia en la web, la persona entra con SU cuenta y aprueba, y la IA recibe un token `chgmcp_` de esa
 * persona. Así cada quien solo ve lo suyo, igual que en la app.
 *
 * Clientes públicos con PKCE S256 obligatorio. El código dura 10 min y sirve una vez. El token de acceso no vence
 * (se revoca en Tú › Conector para IAs); el de refresco rota en cada uso.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.ts';
import { pool, tx } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { randomToken, sha256 } from '../security.ts';

const ACCESS = 'chgmcp_';
const REFRESH = 'chgmcr_';
const CODE_TTL_MIN = 10;

export const resourceUrl = () => `${config.publicOrigin}/api/mcp`;
export const resourceMetadataUrl = () => `${config.publicOrigin}/.well-known/oauth-protected-resource/api/mcp`;

export function protectedResource() {
  return { resource: resourceUrl(), authorization_servers: [config.publicOrigin], bearer_methods_supported: ['header'], scopes_supported: ['chaggu'], resource_name: 'chaggu' };
}

export function authorizationServer() {
  const o = config.publicOrigin;
  return {
    issuer: o,
    authorization_endpoint: `${o}/autorizar-ia`,
    token_endpoint: `${o}/api/mcp/oauth/token`,
    registration_endpoint: `${o}/api/mcp/oauth/register`,
    revocation_endpoint: `${o}/api/mcp/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['chaggu'],
  };
}

export class OAuthError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** https en cualquier host; http solo en la máquina local; esquemas propios de apps (cursor://, vscode://…). */
function okRedirect(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(u.protocol);
}

const RegisterInput = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().max(100).optional(),
}).passthrough();

export async function register(body: unknown) {
  const p = RegisterInput.safeParse(body ?? {});
  if (!p.success) throw new OAuthError(400, 'invalid_client_metadata', 'Faltan redirect_uris');
  const bad = p.data.redirect_uris.find((r) => !okRedirect(r));
  if (bad) throw new OAuthError(400, 'invalid_redirect_uri', `redirect_uri no permitida: ${bad}`);
  const id = `mcpc_${randomToken(18)}`;
  const name = p.data.client_name || 'IA';
  await pool.query('INSERT INTO mcp_oauth_clients (id, name, redirect_uris) VALUES ($1,$2,$3)', [id, name, p.data.redirect_uris]);
  return {
    client_id: id, client_name: name, redirect_uris: p.data.redirect_uris, client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  };
}

async function client(clientId: string, redirectUri: string) {
  const r = (await pool.query('SELECT id, name, redirect_uris FROM mcp_oauth_clients WHERE id = $1', [clientId])).rows[0];
  if (!r) throw notFound('Aplicación');
  if (!(r.redirect_uris as string[]).includes(redirectUri)) throw badRequest('La dirección de regreso no coincide con la registrada');
  return r as { id: string; name: string; redirect_uris: string[] };
}

/** Para la pantalla de aprobación: nombre de la IA y a dónde vuelve (la persona ve el dominio antes de aprobar). */
export async function describe(clientId: string, redirectUri: string) {
  const c = await client(clientId, redirectUri);
  const u = new URL(redirectUri);
  return { name: c.name, redirectHost: u.protocol === 'http:' || u.protocol === 'https:' ? u.host : u.protocol.replace(/:$/, '') };
}

export const ApproveInput = z.object({
  clientId: z.string().min(1).max(100),
  redirectUri: z.string().min(1).max(2000),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  codeChallengeMethod: z.literal('S256'),
  state: z.string().max(2000).optional(),
});

/** La persona (con su sesión de la web) aprueba: devuelve la URL de regreso con el código. */
export async function approve(userId: string, input: z.infer<typeof ApproveInput>) {
  await client(input.clientId, input.redirectUri);
  const code = randomToken(32);
  await pool.query(
    `INSERT INTO mcp_oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(mins => $6))`,
    [sha256(code), input.clientId, userId, input.redirectUri, input.codeChallenge, CODE_TTL_MIN],
  );
  const u = new URL(input.redirectUri);
  u.searchParams.set('code', code);
  if (input.state) u.searchParams.set('state', input.state);
  u.searchParams.set('iss', config.publicOrigin);
  return { redirect: u.toString() };
}

/** La persona cancela: la IA recibe access_denied. */
export async function deny(input: { clientId: string; redirectUri: string; state?: string }) {
  await client(input.clientId, input.redirectUri);
  const u = new URL(input.redirectUri);
  u.searchParams.set('error', 'access_denied');
  if (input.state) u.searchParams.set('state', input.state);
  return { redirect: u.toString() };
}

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const hint = (t: string) => `…${t.slice(-4)}`;

function tokenResponse(access: string, refresh: string) {
  return { access_token: access, token_type: 'Bearer', refresh_token: refresh, scope: 'chaggu' };
}

export async function token(body: Record<string, unknown>) {
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const grant = s('grant_type');
  if (grant === 'authorization_code') {
    return tx(async (c) => {
      const row = (await c.query('SELECT * FROM mcp_oauth_codes WHERE code_hash = $1 FOR UPDATE', [sha256(s('code'))])).rows[0];
      if (!row || row.used_at || new Date(row.expires_at) < new Date()) throw new OAuthError(400, 'invalid_grant', 'Código inválido o vencido');
      if (row.client_id !== s('client_id') || row.redirect_uri !== s('redirect_uri')) throw new OAuthError(400, 'invalid_grant', 'El código es de otra aplicación');
      if (!s('code_verifier') || s256(s('code_verifier')) !== row.code_challenge) throw new OAuthError(400, 'invalid_grant', 'PKCE inválido');
      await c.query('UPDATE mcp_oauth_codes SET used_at = now() WHERE code_hash = $1', [row.code_hash]);
      const name = (await c.query('SELECT name FROM mcp_oauth_clients WHERE id = $1', [row.client_id])).rows[0]?.name ?? 'IA';
      const access = ACCESS + randomToken(32);
      const refresh = REFRESH + randomToken(32);
      await c.query(
        'INSERT INTO mcp_tokens (user_id, name, token_hash, token_hint, client_id, refresh_hash) VALUES ($1,$2,$3,$4,$5,$6)',
        [row.user_id, String(name).slice(0, 60), sha256(access), hint(access), row.client_id, sha256(refresh)],
      );
      return tokenResponse(access, refresh);
    });
  }
  if (grant === 'refresh_token') {
    return tx(async (c) => {
      const row = (await c.query(
        `SELECT t.id, t.client_id FROM mcp_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.refresh_hash = $1 AND t.revoked_at IS NULL AND u.disabled_at IS NULL FOR UPDATE OF t`,
        [sha256(s('refresh_token'))],
      )).rows[0];
      if (!row || (s('client_id') && row.client_id !== s('client_id'))) throw new OAuthError(400, 'invalid_grant', 'Token de refresco inválido');
      const access = ACCESS + randomToken(32);
      const refresh = REFRESH + randomToken(32);
      await c.query('UPDATE mcp_tokens SET token_hash = $2, token_hint = $3, refresh_hash = $4 WHERE id = $1', [row.id, sha256(access), hint(access), sha256(refresh)]);
      return tokenResponse(access, refresh);
    });
  }
  throw new OAuthError(400, 'unsupported_grant_type', 'grant_type no soportado');
}

/** RFC 7009: revocar con el token de acceso o el de refresco (siempre 200). */
export async function revoke(body: Record<string, unknown>) {
  const t = typeof body.token === 'string' ? body.token : '';
  if (t) await pool.query('UPDATE mcp_tokens SET revoked_at = now() WHERE (token_hash = $1 OR refresh_hash = $1) AND revoked_at IS NULL', [sha256(t)]);
  return {};
}

