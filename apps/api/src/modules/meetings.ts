import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { MeetingConnectionDTO, MeetingDTO, MeetingProvider } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { config } from '../config.ts';
import { pool, tx, type Db } from '../db.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { createEvent } from './calendar.ts';
import { sendMessage } from './messages.ts';

/**
 * Reuniones reales con Google Meet, Microsoft Teams o Zoom, con la cuenta de cada persona.
 * - OAuth por persona y solo cuando la persona toca «Conectar». Permisos mínimos: crear eventos del
 *   calendario (Google `calendar.events.owned`, Microsoft `Calendars.ReadWrite`) o reuniones (Zoom `meeting:write`).
 *   No se pide leer ni enviar correo.
 * - Google y Microsoft vuelven por las mismas redirect URI ya registradas para iniciar sesión
 *   (/api/v1/auth/{google|microsoft}/callback): el `state` dice que es una conexión y no un login.
 * - El enlace SOLO sale de la respuesta del proveedor. Sin respuesta, no hay enlace ni mensaje.
 * - Idempotencia: la misma llave devuelve la misma reunión; al proveedor va como requestId (Google),
 *   transactionId (Microsoft); Zoom conserva resultados inciertos sin repetir POST.
 */

const FLOW_TTL_MIN = 10;
const CONFIRM_TTL_SECONDS = 120;
const sha = (s: string) => createHash('sha256').update(s).digest();
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const token = (n = 32) => randomBytes(n).toString('base64url');

// ---------- Cifrado de tokens ----------
const KEY = createHash('sha256').update(`chaggu:meetings:${process.env.MEETINGS_TOKEN_KEY ?? config.jwtSecret}`).digest();
function seal(v: string | null | undefined): Buffer | null {
  if (!v) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function open(b: Buffer | null): string | null {
  if (!b) return null;
  const d = createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// ---------- Proveedores ----------
interface Tokens { access: string; refresh: string | null; expiresIn: number; email: string | null; scope: string }
interface Created { joinUrl: string; externalId: string }
interface Provider {
  label: string;
  configured(): boolean;
  /** Por qué no está disponible (para explicarlo en la app, sin inventar un botón que no funciona). */
  missing(): string | null;
  authorize(state: string, verifier: string): string;
  exchange(code: string, verifier: string): Promise<Tokens>;
  refresh(refresh: string): Promise<Tokens>;
  create(accessToken: string, m: { key: string; title: string; startsAt: string; endsAt: string; timezone: string; instant: boolean }): Promise<Created>;
  read?(accessToken: string, externalId: string): Promise<Created>;
  revoke?(accessToken: string): Promise<void>;
}

const env = (k: string, d = '') => process.env[k] ?? d;
const request = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
const apiBase = (k: string, d: string) => env(k, d).replace(/\/$/, '');
const ssoRedirect = (p: 'google' | 'microsoft') => `${config.apiPublicOrigin}/api/v1/auth/${p}/callback`;
const zoomRedirect = () => `${config.apiPublicOrigin}/api/v1/meetings/zoom/callback`;

async function form(url: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(res.status, json?.error ?? 'token_failed', json?.error_description ?? json?.error ?? `HTTP ${res.status}`);
  return json;
}
class ProviderError extends Error {
  constructor(public status: number, public code: string, message: string, public externalId: string | null = null) { super(message); }
}
class ProviderPending extends Error {
  constructor(public externalId: string) { super('El proveedor todavía está preparando el enlace'); }
}
async function googleRead(accessToken: string, externalId: string): Promise<Created> {
  const base = apiBase('MEETINGS_GOOGLE_API', 'https://www.googleapis.com/calendar/v3');
  const res = await request(`${base}/calendars/primary/events/${encodeURIComponent(externalId)}`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new ProviderError(res.status, 'google_read_failed', `HTTP ${res.status}`, externalId);
  const ev: any = await res.json();
  if (ev.status === 'cancelled') throw new ProviderError(409, 'meeting_cancelled', 'El evento fue cancelado en Google', externalId);
  const url = meetUrl(ev);
  if (!url && ev?.conferenceData?.createRequest?.status?.statusCode === 'failure') throw new ProviderError(409, 'no_meet', 'Google creó el evento pero no pudo generar Meet. Comprueba tu calendario y la disponibilidad de Meet antes de crear otra reunión.', externalId);
  if (!url) throw new ProviderPending(externalId);
  return { joinUrl: url, externalId };
}
/** El id_token llega directo del proveedor por TLS en el intercambio: basta leer el correo. */
function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try { const p = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString()); return p.email ?? p.preferred_username ?? null; } catch { return null; }
}
const toTokens = (j: any, prevRefresh: string | null = null): Tokens => ({
  access: j.access_token, refresh: j.refresh_token ?? prevRefresh, expiresIn: Number(j.expires_in ?? 3600), email: emailFromIdToken(j.id_token), scope: j.scope ?? '',
});

const GOOGLE_SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events.owned';
const MS_SCOPE = 'openid email offline_access https://graph.microsoft.com/Calendars.ReadWrite';

const PROVIDERS: Record<MeetingProvider, Provider> = {
  google: {
    label: 'Google Meet',
    configured: () => !!(config.google.clientId && config.google.clientSecret),
    missing: () => (config.google.clientId && config.google.clientSecret ? null : 'Falta GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en el servidor'),
    authorize: (state, verifier) => `${apiBase('MEETINGS_GOOGLE_AUTH', 'https://accounts.google.com/o/oauth2/v2/auth')}?${new URLSearchParams({
      client_id: config.google.clientId, redirect_uri: ssoRedirect('google'), response_type: 'code', scope: GOOGLE_SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: s256(verifier), code_challenge_method: 'S256',
    })}`,
    exchange: async (code, verifier) => toTokens(await form(apiBase('MEETINGS_GOOGLE_TOKEN', 'https://oauth2.googleapis.com/token'), {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: ssoRedirect('google'), client_id: config.google.clientId, client_secret: config.google.clientSecret,
    })),
    refresh: async (refresh) => toTokens(await form(apiBase('MEETINGS_GOOGLE_TOKEN', 'https://oauth2.googleapis.com/token'), {
      grant_type: 'refresh_token', refresh_token: refresh, client_id: config.google.clientId, client_secret: config.google.clientSecret,
    }), refresh),
    read: googleRead,
    async create(accessToken, m) {
      // Calendar event IDs accept base32hex: a UUID without hyphens is valid and is scoped to
      // this stored operation, not a client-controlled key shared by different users.
      const externalId = m.key.replace(/-/g, '');
      try { return await googleRead(accessToken, externalId); }
      catch (e) { if (!(e instanceof ProviderError && e.status === 404)) throw e; }
      const base = apiBase('MEETINGS_GOOGLE_API', 'https://www.googleapis.com/calendar/v3');
      const res = await request(`${base}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none`, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: externalId, summary: m.title, start: { dateTime: m.startsAt, timeZone: m.timezone }, end: { dateTime: m.endsAt, timeZone: m.timezone },
          conferenceData: { createRequest: { requestId: m.key, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
        }),
      });
      if (res.status === 409) return googleRead(accessToken, externalId);
      const ev: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new ProviderError(res.status, 'google_failed', `Google respondió HTTP ${res.status}`, externalId);
      const url = meetUrl(ev);
      if (!url && ev?.conferenceData?.createRequest?.status?.statusCode === 'failure') throw new ProviderError(409, 'no_meet', 'Google creó el evento pero no pudo generar Meet. Comprueba tu calendario y la disponibilidad de Meet antes de crear otra reunión.', externalId);
      if (!url) throw new ProviderPending(externalId);
      return { joinUrl: url, externalId };
    },
    async revoke(accessToken) { await request(`${apiBase('MEETINGS_GOOGLE_REVOKE', 'https://oauth2.googleapis.com/revoke')}?token=${encodeURIComponent(accessToken)}`, { method: 'POST' }).catch(() => {}); },
  },
  microsoft: {
    label: 'Microsoft Teams',
    configured: () => !!(config.microsoft.clientId && config.microsoft.clientSecret),
    missing: () => (config.microsoft.clientId && config.microsoft.clientSecret ? null : 'Falta MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET en el servidor'),
    authorize: (state, verifier) => `${apiBase('MEETINGS_MS_AUTH', 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize')}?${new URLSearchParams({
      client_id: config.microsoft.clientId, redirect_uri: ssoRedirect('microsoft'), response_type: 'code', scope: MS_SCOPE, prompt: 'select_account',
      state, code_challenge: s256(verifier), code_challenge_method: 'S256',
    })}`,
    exchange: async (code, verifier) => toTokens(await form(apiBase('MEETINGS_MS_TOKEN', 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token'), {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: ssoRedirect('microsoft'), client_id: config.microsoft.clientId, client_secret: config.microsoft.clientSecret, scope: MS_SCOPE,
    })),
    refresh: async (refresh) => toTokens(await form(apiBase('MEETINGS_MS_TOKEN', 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token'), {
      grant_type: 'refresh_token', refresh_token: refresh, client_id: config.microsoft.clientId, client_secret: config.microsoft.clientSecret, scope: MS_SCOPE,
    }), refresh),
    async create(accessToken, m) {
      const base = apiBase('MEETINGS_MS_API', 'https://graph.microsoft.com/v1.0');
      // Graph quiere la hora local de la zona indicada, sin desfase.
      const local = (iso: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: m.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
        .format(new Date(iso)).replace(' ', 'T');
      const res = await request(`${base}/me/events`, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', prefer: `outlook.timezone="${m.timezone}"` },
        body: JSON.stringify({
          subject: m.title, start: { dateTime: local(m.startsAt), timeZone: m.timezone }, end: { dateTime: local(m.endsAt), timeZone: m.timezone },
          isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', transactionId: m.key.slice(0, 64),
        }),
      });
      const ev: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new ProviderError(res.status, ev?.error?.code ?? 'microsoft_failed', `Microsoft respondió HTTP ${res.status}`);
      const url = ev?.onlineMeeting?.joinUrl;
      if (!url) throw new ProviderError(409, 'no_teams', 'Outlook creó el evento pero sin enlace de Teams: la cuenta no tiene Teams para empresas o no está habilitado', ev.id ?? null);
      return { joinUrl: url, externalId: ev.id };
    },
  },
  zoom: {
    label: 'Zoom',
    configured: () => !!(env('ZOOM_CLIENT_ID') && env('ZOOM_CLIENT_SECRET')),
    missing: () => (env('ZOOM_CLIENT_ID') && env('ZOOM_CLIENT_SECRET') ? null : 'Zoom aún no tiene una app OAuth registrada para chaggu (faltan ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET)'),
    authorize: (state, verifier) => `${apiBase('MEETINGS_ZOOM_AUTH', 'https://zoom.us/oauth/authorize')}?${new URLSearchParams({
      client_id: env('ZOOM_CLIENT_ID'), redirect_uri: zoomRedirect(), response_type: 'code', state, code_challenge: s256(verifier), code_challenge_method: 'S256',
    })}`,
    exchange: async (code, verifier) => toTokens(await form(apiBase('MEETINGS_ZOOM_TOKEN', 'https://zoom.us/oauth/token'), {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: zoomRedirect(),
    }, { authorization: `Basic ${Buffer.from(`${env('ZOOM_CLIENT_ID')}:${env('ZOOM_CLIENT_SECRET')}`).toString('base64')}` })),
    refresh: async (refresh) => toTokens(await form(apiBase('MEETINGS_ZOOM_TOKEN', 'https://zoom.us/oauth/token'), {
      grant_type: 'refresh_token', refresh_token: refresh,
    }, { authorization: `Basic ${Buffer.from(`${env('ZOOM_CLIENT_ID')}:${env('ZOOM_CLIENT_SECRET')}`).toString('base64')}` }), refresh),
    async create(accessToken, m) {
      const base = apiBase('MEETINGS_ZOOM_API', 'https://api.zoom.us/v2');
      const minutes = Math.max(15, Math.round((Date.parse(m.endsAt) - Date.parse(m.startsAt)) / 60_000));
      const res = await request(`${base}/users/me/meetings`, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ topic: m.title, type: m.instant ? 1 : 2, ...(m.instant ? {} : { start_time: m.startsAt, timezone: m.timezone }), duration: minutes }),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new ProviderError(res.status, 'zoom_failed', `Zoom respondió HTTP ${res.status}`);
      if (!j.join_url) throw new ProviderError(502, 'zoom_no_link', 'Zoom no devolvió el enlace; comprueba tus reuniones antes de crear otra', j.id ? String(j.id) : null);
      return { joinUrl: j.join_url, externalId: String(j.id) };
    },
  },
};
function meetUrl(ev: any): string | null {
  if (typeof ev?.hangoutLink === 'string') return ev.hangoutLink;
  const ep = (ev?.conferenceData?.entryPoints ?? []).find((e: any) => e.entryPointType === 'video' && typeof e.uri === 'string');
  return ep?.uri ?? null;
}
export const isMeetingProvider = (p: string): p is MeetingProvider => p === 'google' || p === 'microsoft' || p === 'zoom';

// ---------- Conexiones ----------
export async function listConnections(userId: string): Promise<MeetingConnectionDTO[]> {
  const { rows } = await pool.query('SELECT provider, account_email, status, updated_at FROM meeting_connections WHERE user_id = $1', [userId]);
  return (Object.keys(PROVIDERS) as MeetingProvider[]).map((p) => {
    const r = rows.find((x) => x.provider === p);
    const missing = PROVIDERS[p].missing();
    return {
      provider: p, label: PROVIDERS[p].label, available: !missing, unavailableReason: missing,
      status: r ? (r.status as 'active' | 'reconnect') : 'none', accountEmail: r?.account_email ?? null,
    };
  });
}

/** Paso 1 (autenticado): la URL del proveedor que la app abre en el navegador del sistema. */
export async function startConnect(userId: string, provider: MeetingProvider, opts: { platform: string; redirectScheme?: string | null; proofChallenge: string }) {
  const def = PROVIDERS[provider];
  const missing = def.missing();
  if (missing) throw new ApiError(503, 'provider_unavailable', missing);
  const state = `mtg_${token(32)}`;
  const verifier = token(48);
  await pool.query(
    `INSERT INTO meeting_flows (state_hash, user_id, provider, verifier, platform, native_scheme, expires_at, proof_challenge)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7), $8)`,
    [sha(state), userId, provider, verifier, opts.platform, opts.redirectScheme ?? null, FLOW_TTL_MIN, opts.proofChallenge],
  );
  return { url: def.authorize(state, verifier) };
}

export const isMeetingState = (state: string | undefined) => !!state && state.startsWith('mtg_');

function backTo(platform: string, scheme: string | null, params: Record<string, string>) {
  const q = new URLSearchParams(params);
  if (platform === 'web') return `${config.publicOrigin}/ajustes?${q}#reuniones`;
  return `${scheme || 'chaggu'}://meetings/connected?${q}`;
}

/** Callback never activates credentials. The receipt is delivered only to the receiving user agent;
 * its original authenticated client must also possess the verifier, which is never put in a URL. */
export async function finishConnect(query: Record<string, string | undefined>, provider: MeetingProvider): Promise<string> {
  const { rows } = await pool.query('DELETE FROM meeting_flows WHERE state_hash = $1 AND provider = $2 RETURNING *', [sha(query.state ?? ''), provider]);
  const flow = rows[0];
  if (!flow || !flow.proof_challenge || new Date(flow.expires_at) < new Date()) return backTo('web', null, { error: 'expired' });
  const back = (p: Record<string, string>) => backTo(flow.platform, flow.native_scheme, { provider: flow.provider, ...p });
  if (query.error) return back({ error: query.error === 'access_denied' ? 'cancelled' : 'denied' });
  if (!query.code) return back({ error: 'no_code' });
  try {
    const tk = await PROVIDERS[provider].exchange(query.code, flow.verifier);
    if (!tk.access) return back({ error: 'failed' });
    const receipt = token(32);
    await pool.query('DELETE FROM meeting_confirmations WHERE expires_at < now()');
    await pool.query(
      `INSERT INTO meeting_confirmations (receipt_hash, user_id, provider, proof_challenge, tokens_enc, expires_at)
       VALUES ($1,$2,$3,$4,$5,now() + make_interval(secs => $6))`,
      [sha(receipt), flow.user_id, provider, flow.proof_challenge, seal(JSON.stringify(tk)), CONFIRM_TTL_SECONDS],
    );
    return back({ receipt });
  } catch {
    // Provider errors may contain credentials or authorization codes. Never log them.
    return back({ error: 'failed' });
  }
}

export async function confirmConnect(userId: string, input: { receipt: string; proofVerifier: string }) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `DELETE FROM meeting_confirmations WHERE receipt_hash = $1 AND user_id = $2
         AND proof_challenge = $3 AND expires_at > now() RETURNING *`,
      [sha(input.receipt), userId, s256(input.proofVerifier)],
    );
    const pending = rows[0];
    if (!pending) throw new ApiError(409, 'meeting_confirmation_invalid', 'La conexión venció o no pertenece a esta sesión. Conecta la cuenta de nuevo.');
    await saveTokens(userId, pending.provider, JSON.parse(open(pending.tokens_enc)!), c, true);
    return { ok: true, provider: pending.provider as MeetingProvider };
  });
}

async function saveTokens(userId: string, provider: string, tk: Tokens, db: Db = pool, replacing = false) {
  await db.query(
    `INSERT INTO meeting_connections (user_id, provider, account_email, scopes, access_token_enc, refresh_token_enc, expires_at, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), 'active', now())
     ON CONFLICT (user_id, provider) DO UPDATE SET account_email = CASE WHEN $8 THEN EXCLUDED.account_email ELSE COALESCE(EXCLUDED.account_email, meeting_connections.account_email) END,
       scopes = EXCLUDED.scopes, access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = CASE WHEN $8 THEN EXCLUDED.refresh_token_enc ELSE COALESCE(EXCLUDED.refresh_token_enc, meeting_connections.refresh_token_enc) END,
       expires_at = EXCLUDED.expires_at, status = 'active', updated_at = now(),
       generation = CASE WHEN $8 THEN gen_random_uuid() ELSE meeting_connections.generation END`,
    [userId, provider, tk.email, tk.scope, seal(tk.access), seal(tk.refresh), Math.max(60, tk.expiresIn - 60), replacing],
  );
}

export async function disconnect(userId: string, provider: MeetingProvider) {
  await pool.query('DELETE FROM meeting_flows WHERE user_id = $1 AND provider = $2', [userId, provider]);
  await pool.query('DELETE FROM meeting_confirmations WHERE user_id = $1 AND provider = $2', [userId, provider]);
  const { rows } = await pool.query('DELETE FROM meeting_connections WHERE user_id = $1 AND provider = $2 RETURNING access_token_enc, refresh_token_enc', [userId, provider]);
  if (rows[0]) {
    const t = open(rows[0].refresh_token_enc) ?? open(rows[0].access_token_enc);
    if (t) await PROVIDERS[provider].revoke?.(t);
  }
  return { ok: true };
}

/** Token vigente; si venció se renueva. Si el proveedor lo rechaza, la conexión queda «reconectar». */
async function accessToken(userId: string, provider: MeetingProvider): Promise<string> {
  const { rows } = await pool.query('SELECT * FROM meeting_connections WHERE user_id = $1 AND provider = $2', [userId, provider]);
  const r = rows[0];
  if (!r) throw new ApiError(409, 'not_connected', `Conecta tu cuenta de ${PROVIDERS[provider].label} para crear la reunión`);
  if (r.status === 'reconnect') throw new ApiError(409, 'reconnect_required', `Vuelve a conectar ${PROVIDERS[provider].label}: el permiso venció o se revocó`);
  if (r.expires_at && new Date(r.expires_at).getTime() > Date.now() + 30_000) return open(r.access_token_enc)!;
  const refresh = open(r.refresh_token_enc);
  if (!refresh) { await markReconnect(userId, provider); throw new ApiError(409, 'reconnect_required', `Vuelve a conectar ${PROVIDERS[provider].label}`); }
  try {
    const tk = await PROVIDERS[provider].refresh(refresh);
    await saveTokens(userId, provider, tk);
    return tk.access;
  } catch (e: any) {
    if (e instanceof ProviderError && e.status >= 400 && e.status < 500) { await markReconnect(userId, provider); throw new ApiError(409, 'reconnect_required', `Vuelve a conectar ${PROVIDERS[provider].label}: el permiso venció o se revocó`); }
    throw new ApiError(502, 'provider_unreachable', `${PROVIDERS[provider].label} no respondió; inténtalo de nuevo`);
  }
}
const markReconnect = (userId: string, provider: string) => pool.query("UPDATE meeting_connections SET status = 'reconnect', updated_at = now() WHERE user_id = $1 AND provider = $2", [userId, provider]);

// ---------- Crear y compartir ----------
const toDTO = (r: any): MeetingDTO => ({
  id: r.id, provider: r.provider, status: r.status, title: r.title, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(),
  timezone: r.timezone, joinUrl: r.join_url, conversationId: r.conversation_id, calendarEventId: r.calendar_event_id, messageId: r.message_id, error: r.error,
});

type MeetingInput = {
  provider: MeetingProvider; conversationId?: string | null; idempotencyKey: string; title: string;
  startsAt?: string | null; durationMin: number; timezone: string; share: boolean;
};
const fingerprint = (i: MeetingInput) => sha(JSON.stringify([
  1, i.provider, i.conversationId ?? null, i.title, i.startsAt ? new Date(i.startsAt).toISOString() : null,
  i.durationMin, i.timezone, i.share,
]));
const details = (row: any) => ({ meetingId: row.id });
const rowById = async (id: string) => (await pool.query('SELECT * FROM meetings WHERE id = $1', [id])).rows[0];

/** A session advisory lock (no open transaction across network calls) serializes recovery and sharing.
 * A process crash releases it, while the persisted inflight reservation remains conservative. */
async function locked<T>(row: any, fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let held = false;
  try {
    for (let i = 0; i < 30; i++) {
      held = (await c.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held', [`meeting:${row.id}`])).rows[0].held;
      if (held) return await fn();
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new ApiError(409, 'meeting_in_progress', 'La reunión se está creando; conserva este intento y espera un momento', details(row));
  } finally {
    try { if (held) await c.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`meeting:${row.id}`]); }
    finally { c.release(); }
  }
}

/** Persist every outcome. In particular, an uncertain POST never frees its idempotency key. */
async function recordFailure(row: any, e: unknown, dispatched: boolean): Promise<never> {
  let code: string, message: string, status: number, op: string, externalId: string | null = row.external_id;
  if (e instanceof ProviderPending) {
    op = 'pending'; code = 'meeting_pending'; status = 409; externalId = e.externalId;
    message = 'Google creó el evento y todavía está preparando Meet. Conserva este intento y vuelve a comprobarlo.';
  } else if (!dispatched && e instanceof ApiError) {
    op = 'reserved'; code = e.code; status = e.status; message = e.message;
  } else if (e instanceof ProviderError && e.status >= 400 && e.status < 500) {
    externalId = e.externalId ?? externalId;
    if (e.status === 401 || e.status === 403) {
      await markReconnect(row.user_id, row.provider);
      // A known rejected request can be retried after reconnecting; a previously uncertain one cannot.
      op = row.operation_state === 'reserved' ? 'reserved' : 'uncertain';
      code = 'reconnect_required'; status = 409; message = 'El proveedor rechazó el permiso. Vuelve a conectar la cuenta.';
    } else {
      op = 'failed'; code = e.code; status = e.status === 409 ? 409 : 502; message = e.message;
    }
  } else {
    op = 'uncertain'; code = 'meeting_uncertain'; status = 409;
    if (e instanceof ProviderError) externalId = e.externalId ?? externalId;
    message = 'No pudimos confirmar el resultado. El proveedor puede haber creado la reunión. Conserva este intento y comprueba tu calendario antes de crear otra.';
  }
  await pool.query(
    `UPDATE meetings SET status = $2, operation_state = $3, error_code = $4, error_status = $5, error = $6, external_id = $7 WHERE id = $1`,
    [row.id, op === 'failed' || op === 'reserved' ? 'failed' : 'creating', op, code, status, message, externalId],
  );
  throw new ApiError(status, code, message, details(row));
}

async function shareCreated(row: any) {
  if (!row.share_requested || !row.conversation_id) return;
  try {
    await conversationAccess(pool, row.user_id, row.conversation_id, 'post');
    if (!row.calendar_event_id) {
      const ev = await createEvent(row.user_id, row.conversation_id, {
        title: row.title, location: row.join_url, description: `${PROVIDERS[row.provider as MeetingProvider].label}: ${row.join_url}`,
        startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(), timezone: row.timezone,
      }, row.id);
      row.calendar_event_id = ev.id;
    }
    if (!row.message_id) {
      const lead = `📹 ${PROVIDERS[row.provider as MeetingProvider].label}${row.instant ? ' · ahora' : ''}`;
      const { message } = await sendMessage(row.user_id, row.conversation_id, { clientMessageId: `meet-${row.id}`, body: `${lead}: ${row.title}\n${row.join_url}` });
      await pool.query('UPDATE meetings SET message_id = $2 WHERE id = $1', [row.id, message.id]);
    }
    await pool.query('UPDATE meetings SET error = NULL, error_code = NULL, error_status = NULL WHERE id = $1', [row.id]);
  } catch {
    await pool.query("UPDATE meetings SET error = 'La reunión existe, pero no se pudo compartir. Puedes copiar su enlace o reintentar este mismo intento.' WHERE id = $1", [row.id]);
  }
}

async function recover(row: any, readOnly: boolean): Promise<MeetingDTO> {
  row = await rowById(row.id);
  if (row.status === 'created') {
    if (!readOnly) await shareCreated(row);
    return toDTO(await rowById(row.id));
  }
  if (row.operation_state === 'failed') {
    if (readOnly) return toDTO(row);
    throw new ApiError(row.error_status ?? 502, row.error_code ?? 'meeting_failed', row.error ?? 'El proveedor rechazó este intento', details(row));
  }
  if (readOnly && row.operation_state === 'reserved') return toDTO(row);
  const def = PROVIDERS[row.provider as MeetingProvider];
  const priorUncertain = ['inflight', 'uncertain', 'pending'].includes(row.operation_state);
  if (priorUncertain && row.provider !== 'google') {
    // Zoom provides no transaction key for POST /users/me/meetings. An interrupted request MUST NOT be repeated.
    if (row.operation_state === 'inflight') await pool.query("UPDATE meetings SET operation_state = 'uncertain', error = 'El proveedor puede haber creado la reunión; comprueba tu calendario antes de crear otra.' WHERE id = $1", [row.id]);
    if (readOnly) return toDTO(await rowById(row.id));
    throw new ApiError(409, 'meeting_uncertain', row.error ?? 'El proveedor puede haber creado la reunión. Comprueba tu calendario antes de crear otra.', details(row));
  }
  let dispatched = false;
  try {
    const connection = (await pool.query('SELECT generation FROM meeting_connections WHERE user_id = $1 AND provider = $2', [row.user_id, row.provider])).rows[0];
    if (priorUncertain && row.connection_generation !== connection?.generation) {
      throw new ApiError(409, 'meeting_uncertain', 'La cuenta conectada cambió. Comprueba la reunión en la cuenta original antes de crear otra.', details(row));
    }
    const at = await accessToken(row.user_id, row.provider);
    let created: Created;
    if (readOnly) {
      // GET only reads the original Google event; it never inserts an external event.
      if (!row.external_id || !def.read) return toDTO(row);
      created = await def.read(at, row.external_id);
    } else {
      row.external_id ??= row.provider === 'google' ? row.id.replace(/-/g, '') : null;
      await pool.query("UPDATE meetings SET operation_state = 'inflight', status = 'creating', connection_generation = $2, external_id = COALESCE(external_id, $3) WHERE id = $1", [row.id, connection?.generation, row.external_id]);
      dispatched = true;
      created = await def.create(at, { key: row.id, title: row.title, startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(), timezone: row.timezone, instant: row.instant });
    }
    await pool.query("UPDATE meetings SET status = 'created', operation_state = 'complete', join_url = $2, external_id = $3, error = NULL, error_code = NULL, error_status = NULL WHERE id = $1", [row.id, created.joinUrl, created.externalId]);
  } catch (e) {
    // A read failure cannot prove an earlier write failed. Keep the original reservation.
    if (readOnly) return toDTO(await rowById(row.id));
    if (priorUncertain && e instanceof ApiError) throw e;
    await recordFailure(row, e, dispatched);
  }
  row = await rowById(row.id);
  await shareCreated(row);
  return toDTO(await rowById(row.id));
}

export async function createMeeting(userId: string, input: MeetingInput) {
  // Recovery belongs to the original operation even if time, access or provider configuration changed.
  // Only a new key can fail preflight without a meetingId; callers must keep ambiguous existing attempts.
  const fp = fingerprint(input);
  let row = (await pool.query('SELECT * FROM meetings WHERE user_id = $1 AND idempotency_key = $2', [userId, input.idempotencyKey])).rows[0];
  if (!row) {
    const missing = PROVIDERS[input.provider].missing();
    if (missing) throw new ApiError(503, 'provider_unavailable', missing);
    if (input.conversationId) await conversationAccess(pool, userId, input.conversationId, 'post');
    try { new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }); } catch { throw badRequest('Zona horaria inválida'); }
    const instant = !input.startsAt;
    const starts = instant ? new Date(Math.floor(Date.now() / 60_000) * 60_000) : new Date(input.startsAt!);
    if (Number.isNaN(starts.getTime())) throw badRequest('Hora inválida');
    if (!instant && starts.getTime() < Date.now() - 5 * 60_000) throw badRequest('La hora de la reunión ya pasó');
    const ends = new Date(starts.getTime() + input.durationMin * 60_000);
    const ins = await pool.query(
      `INSERT INTO meetings (user_id, provider, conversation_id, idempotency_key, title, starts_at, ends_at, timezone, request_fingerprint, share_requested, instant)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`,
      [userId, input.provider, input.conversationId ?? null, input.idempotencyKey, input.title, starts.toISOString(), ends.toISOString(), input.timezone, fp, input.share, instant],
    );
    row = ins.rows[0] ?? (await pool.query('SELECT * FROM meetings WHERE user_id = $1 AND idempotency_key = $2', [userId, input.idempotencyKey])).rows[0];
  }
  if (!row.request_fingerprint?.equals(fp)) throw new ApiError(409, 'idempotency_mismatch', 'Esta llave pertenece a otro intento. Conserva los datos originales para recuperarlo.', details(row));
  return locked(row, () => recover(row, false));
}

export async function getMeeting(userId: string, id: string) {
  const row = (await pool.query('SELECT * FROM meetings WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
  if (!row) throw notFound('Reunión');
  return locked(row, () => recover(row, true));
}
