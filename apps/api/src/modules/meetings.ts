import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { MeetingConnectionDTO, MeetingDTO, MeetingProvider } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { config } from '../config.ts';
import { pool } from '../db.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { createEvent } from './calendar.ts';
import { sendMessage } from './messages.ts';

/**
 * Reuniones reales con Google Meet, Microsoft Teams o Zoom, con la cuenta de cada persona.
 * - OAuth por persona y solo cuando la persona toca «Conectar». Permisos mínimos: crear eventos del
 *   calendario (Google `calendar.events`, Microsoft `Calendars.ReadWrite`) o reuniones (Zoom `meeting:write`).
 *   No se pide leer ni enviar correo.
 * - Google y Microsoft vuelven por las mismas redirect URI ya registradas para iniciar sesión
 *   (/api/v1/auth/{google|microsoft}/callback): el `state` dice que es una conexión y no un login.
 * - El enlace SOLO sale de la respuesta del proveedor. Sin respuesta, no hay enlace ni mensaje.
 * - Idempotencia: la misma llave devuelve la misma reunión; al proveedor va como requestId (Google),
 *   transactionId (Microsoft) o se guarda antes de llamar (Zoom).
 */

const FLOW_TTL_MIN = 10;
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
  revoke?(accessToken: string): Promise<void>;
}

const env = (k: string, d = '') => process.env[k] ?? d;
const apiBase = (k: string, d: string) => env(k, d).replace(/\/$/, '');
const ssoRedirect = (p: 'google' | 'microsoft') => `${config.apiPublicOrigin}/api/v1/auth/${p}/callback`;
const zoomRedirect = () => `${config.apiPublicOrigin}/api/v1/meetings/zoom/callback`;

async function form(url: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(res.status, json?.error ?? 'token_failed', json?.error_description ?? json?.error ?? `HTTP ${res.status}`);
  return json;
}
class ProviderError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
/** El id_token llega directo del proveedor por TLS en el intercambio: basta leer el correo. */
function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try { const p = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString()); return p.email ?? p.preferred_username ?? null; } catch { return null; }
}
const toTokens = (j: any, prevRefresh: string | null = null): Tokens => ({
  access: j.access_token, refresh: j.refresh_token ?? prevRefresh, expiresIn: Number(j.expires_in ?? 3600), email: emailFromIdToken(j.id_token), scope: j.scope ?? '',
});

const GOOGLE_SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events';
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
    async create(accessToken, m) {
      const base = apiBase('MEETINGS_GOOGLE_API', 'https://www.googleapis.com/calendar/v3');
      const res = await fetch(`${base}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none`, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          summary: m.title, start: { dateTime: m.startsAt, timeZone: m.timezone }, end: { dateTime: m.endsAt, timeZone: m.timezone },
          conferenceData: { createRequest: { requestId: m.key.slice(0, 64), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
        }),
      });
      let ev: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new ProviderError(res.status, ev?.error?.status ?? 'google_failed', ev?.error?.message ?? `HTTP ${res.status}`);
      // Meet puede quedar «pending» un momento: se vuelve a leer el evento hasta tener el enlace.
      for (let i = 0; i < 4 && !meetUrl(ev); i++) {
        await new Promise((r) => setTimeout(r, 700));
        const again = await fetch(`${base}/calendars/primary/events/${encodeURIComponent(ev.id)}`, { headers: { authorization: `Bearer ${accessToken}` } });
        if (again.ok) ev = await again.json();
      }
      const url = meetUrl(ev);
      if (!url) throw new ProviderError(502, 'no_meet', 'Google creó el evento pero no devolvió un enlace de Meet (¿la cuenta tiene Meet habilitado?)');
      return { joinUrl: url, externalId: ev.id };
    },
    async revoke(accessToken) { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`, { method: 'POST' }).catch(() => {}); },
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
      const res = await fetch(`${base}/me/events`, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', prefer: `outlook.timezone="${m.timezone}"` },
        body: JSON.stringify({
          subject: m.title, start: { dateTime: local(m.startsAt), timeZone: m.timezone }, end: { dateTime: local(m.endsAt), timeZone: m.timezone },
          isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', transactionId: m.key.slice(0, 64),
        }),
      });
      const ev: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new ProviderError(res.status, ev?.error?.code ?? 'microsoft_failed', ev?.error?.message ?? `HTTP ${res.status}`);
      const url = ev?.onlineMeeting?.joinUrl;
      if (!url) throw new ProviderError(409, 'no_teams', 'Outlook creó el evento pero sin enlace de Teams: la cuenta no tiene Teams para empresas o no está habilitado');
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
      const res = await fetch(`${base}/users/me/meetings`, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ topic: m.title, type: m.instant ? 1 : 2, ...(m.instant ? {} : { start_time: m.startsAt, timezone: m.timezone }), duration: minutes }),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || !j.join_url) throw new ProviderError(res.status || 502, String(j?.code ?? 'zoom_failed'), j?.message ?? `HTTP ${res.status}`);
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
export async function startConnect(userId: string, provider: MeetingProvider, opts: { platform: string; redirectScheme?: string | null }) {
  const def = PROVIDERS[provider];
  const missing = def.missing();
  if (missing) throw new ApiError(503, 'provider_unavailable', missing);
  const state = `mtg_${token(32)}`;
  const verifier = token(48);
  await pool.query(
    `INSERT INTO meeting_flows (state_hash, user_id, provider, verifier, platform, native_scheme, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7))`,
    [sha(state), userId, provider, verifier, opts.platform, opts.redirectScheme ?? null, FLOW_TTL_MIN],
  );
  return { url: def.authorize(state, verifier) };
}

export const isMeetingState = (state: string | undefined) => !!state && state.startsWith('mtg_');

function backTo(platform: string, scheme: string | null, params: Record<string, string>) {
  const q = new URLSearchParams(params);
  if (platform === 'web') return `${config.publicOrigin}/ajustes?${q}#reuniones`;
  return `${scheme || 'chaggu'}://meetings/connected?${q}`;
}

/** Paso 2: el proveedor vuelve (por la callback del login o la de Zoom). Siempre redirige a la app. */
export async function finishConnect(query: Record<string, string | undefined>): Promise<string> {
  const { rows } = await pool.query('DELETE FROM meeting_flows WHERE state_hash = $1 RETURNING *', [sha(query.state ?? '')]);
  const flow = rows[0];
  if (!flow || new Date(flow.expires_at) < new Date()) return backTo('web', null, { error: 'expired' });
  const back = (p: Record<string, string>) => backTo(flow.platform, flow.native_scheme, { provider: flow.provider, ...p });
  if (query.error) return back({ error: query.error === 'access_denied' ? 'cancelled' : 'denied' });
  if (!query.code) return back({ error: 'no_code' });
  try {
    const tk = await PROVIDERS[flow.provider as MeetingProvider].exchange(query.code, flow.verifier);
    await saveTokens(flow.user_id, flow.provider, tk);
    return back({ connected: '1' });
  } catch (e: any) {
    console.error('[meetings] connect', flow.provider, e?.code ?? e?.message);
    return back({ error: e instanceof ProviderError ? e.code : 'failed' });
  }
}

async function saveTokens(userId: string, provider: string, tk: Tokens) {
  await pool.query(
    `INSERT INTO meeting_connections (user_id, provider, account_email, scopes, access_token_enc, refresh_token_enc, expires_at, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), 'active', now())
     ON CONFLICT (user_id, provider) DO UPDATE SET account_email = COALESCE(EXCLUDED.account_email, meeting_connections.account_email),
       scopes = EXCLUDED.scopes, access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, meeting_connections.refresh_token_enc),
       expires_at = EXCLUDED.expires_at, status = 'active', updated_at = now()`,
    [userId, provider, tk.email, tk.scope, seal(tk.access), seal(tk.refresh), Math.max(60, tk.expiresIn - 60)],
  );
}

export async function disconnect(userId: string, provider: MeetingProvider) {
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

/**
 * Crea la reunión con el proveedor y, solo si la confirma, la comparte: un mensaje con el enlace real y
 * una reunión en el calendario de la conversación. Con `share: false` solo devuelve el enlace (copiar).
 */
export async function createMeeting(userId: string, input: {
  provider: MeetingProvider; conversationId?: string | null; idempotencyKey: string; title: string; startsAt?: string | null; durationMin: number; timezone: string; share: boolean;
}) {
  const def = PROVIDERS[input.provider];
  const missing = def.missing();
  if (missing) throw new ApiError(503, 'provider_unavailable', missing);
  if (input.conversationId) await conversationAccess(pool, userId, input.conversationId, 'post');
  const instant = !input.startsAt;
  const starts = instant ? new Date(Math.floor(Date.now() / 60_000) * 60_000) : new Date(input.startsAt!);
  if (Number.isNaN(starts.getTime())) throw badRequest('Hora inválida');
  if (!instant && starts.getTime() < Date.now() - 5 * 60_000) throw badRequest('La hora de la reunión ya pasó');
  const ends = new Date(starts.getTime() + input.durationMin * 60_000);

  // Idempotencia: la primera vez se reserva la fila; un reintento devuelve lo que haya (o espera la creación en curso).
  const ins = await pool.query(
    `INSERT INTO meetings (user_id, provider, conversation_id, idempotency_key, title, starts_at, ends_at, timezone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`,
    [userId, input.provider, input.conversationId ?? null, input.idempotencyKey, input.title, starts.toISOString(), ends.toISOString(), input.timezone],
  );
  if (!ins.rows[0]) {
    for (let i = 0; i < 20; i++) {
      const { rows } = await pool.query('SELECT * FROM meetings WHERE user_id = $1 AND idempotency_key = $2', [userId, input.idempotencyKey]);
      if (rows[0]?.status !== 'creating') {
        if (rows[0]?.status === 'failed') throw new ApiError(502, 'meeting_failed', rows[0].error ?? 'No se pudo crear la reunión');
        return toDTO(rows[0]);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new ApiError(409, 'meeting_in_progress', 'La reunión se está creando; espera un momento');
  }
  const row = ins.rows[0];
  let created: Created;
  try {
    const at = await accessToken(userId, input.provider);
    created = await def.create(at, { key: input.idempotencyKey, title: input.title, startsAt: starts.toISOString(), endsAt: ends.toISOString(), timezone: input.timezone, instant });
  } catch (e: any) {
    const err = e instanceof ApiError ? e : e instanceof ProviderError
      ? (e.status === 401 || e.status === 403
        ? (await markReconnect(userId, input.provider), new ApiError(409, 'reconnect_required', `${def.label} rechazó el permiso: vuelve a conectar la cuenta (${e.message})`))
        : new ApiError(e.status === 409 ? 409 : 502, e.code, `${def.label}: ${e.message}`))
      : new ApiError(502, 'provider_unreachable', `${def.label} no respondió; no se creó ninguna reunión`);
    // Se libera la llave para poder reintentar después de reconectar.
    await pool.query('DELETE FROM meetings WHERE id = $1', [row.id]);
    throw err;
  }
  await pool.query("UPDATE meetings SET status = 'created', join_url = $2, external_id = $3 WHERE id = $1", [row.id, created.joinUrl, created.externalId]);
  if (input.share && input.conversationId) {
    try {
      const ev = await createEvent(userId, input.conversationId, {
        title: input.title, location: created.joinUrl, description: `${def.label}: ${created.joinUrl}`,
        startsAt: starts.toISOString(), endsAt: ends.toISOString(), timezone: input.timezone,
      });
      const lead = instant ? `📹 ${def.label} · ahora` : `📹 ${def.label}`;
      const { message } = await sendMessage(userId, input.conversationId, { clientMessageId: `meet-${row.id}`, body: `${lead}: ${input.title}\n${created.joinUrl}` });
      await pool.query('UPDATE meetings SET calendar_event_id = $2, message_id = $3 WHERE id = $1', [row.id, ev.id, message.id]);
    } catch (e: any) {
      // La reunión existe en el proveedor aunque compartirla falle: se devuelve con el enlace para copiarlo.
      await pool.query('UPDATE meetings SET error = $2 WHERE id = $1', [row.id, String(e?.message ?? e).slice(0, 300)]);
    }
  }
  const { rows } = await pool.query('SELECT * FROM meetings WHERE id = $1', [row.id]);
  return toDTO(rows[0]);
}

export async function getMeeting(userId: string, id: string) {
  const { rows } = await pool.query('SELECT * FROM meetings WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rows[0]) throw notFound('Reunión');
  return toDTO(rows[0]);
}
