/**
 * Envío de notificaciones push sin librerías externas:
 *  - APNs: HTTP/2 (node:http2) con token JWT ES256 firmado con la llave .p8 de Apple.
 *  - FCM HTTP v1: token OAuth de la cuenta de servicio (JWT RS256) y POST de un mensaje de datos.
 * No toca la base de datos: lo usa modules/push.ts y se prueba con servidores falsos
 * (APNS_HOST y FCM_HOST apuntan a ellos; la cuenta de servicio trae su token_uri).
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';

export type PushResult =
  | { ok: true }
  /** invalidToken: el proveedor dice que el token ya no sirve (se borra). */
  | { ok: false; invalidToken: boolean; error: string };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

// ---------- APNs ----------
interface ApnsConfig { keyId: string; teamId: string; bundleId: string; key: KeyObject }
let apnsCfg: ApnsConfig | null | undefined;

/** Lee la configuración una vez (null si falta algo: se registra el token pero no se envía). */
export function apnsConfig(): ApnsConfig | null {
  if (apnsCfg !== undefined) return apnsCfg;
  const pem = process.env.APNS_KEY || (process.env.APNS_KEY_PATH ? readFileSync(process.env.APNS_KEY_PATH, 'utf8') : '');
  const keyId = process.env.APNS_KEY_ID ?? '', teamId = process.env.APNS_TEAM_ID ?? '';
  if (!pem || !keyId || !teamId) {
    console.warn('[push] APNs sin configurar (APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_PATH o APNS_KEY): los tokens de iOS se guardan pero no se envían');
    return (apnsCfg = null);
  }
  return (apnsCfg = { keyId, teamId, bundleId: process.env.APNS_BUNDLE_ID || 'com.tiecoms.app', key: createPrivateKey(pem.replace(/\\n/g, '\n')) });
}

let apnsJwt: { token: string; at: number } | null = null;
/** Apple pide renovar el token entre 20 y 60 minutos: se renueva cada 40. */
export function apnsToken(cfg: ApnsConfig, now = Date.now()): string {
  if (apnsJwt && now - apnsJwt.at < 40 * 60_000) return apnsJwt.token;
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const claims = b64url(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(now / 1000) }));
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key: cfg.key, dsaEncoding: 'ieee-p1363' });
  apnsJwt = { token: `${head}.${claims}.${b64url(sig)}`, at: now };
  return apnsJwt.token;
}

const apnsHost = (env: 'sandbox' | 'production') =>
  process.env.APNS_HOST || (env === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');

const sessions = new Map<string, http2.ClientHttp2Session>();
function h2(origin: string) {
  const cur = sessions.get(origin);
  if (cur && !cur.closed && !cur.destroyed) return cur;
  const s = http2.connect(origin);
  s.on('error', (e) => { console.error('[push] APNs conexión', e.message); sessions.delete(origin); });
  s.on('close', () => sessions.delete(origin));
  s.on('goaway', () => sessions.delete(origin));
  s.setTimeout(10 * 60_000, () => s.close());
  sessions.set(origin, s);
  return s;
}

export function closePushConnections() {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}

export async function sendApns(token: string, environment: 'sandbox' | 'production', payload: object, opts: { collapseId?: string } = {}): Promise<PushResult> {
  const cfg = apnsConfig();
  if (!cfg) return { ok: false, invalidToken: false, error: 'apns_not_configured' };
  const body = JSON.stringify(payload);
  const exec = () => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = h2(apnsHost(environment)).request({
      ':method': 'POST', ':path': `/3/device/${encodeURIComponent(token)}`,
      authorization: `bearer ${apnsToken(cfg)}`,
      'apns-topic': cfg.bundleId, 'apns-push-type': 'alert', 'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 86_400),
      ...(opts.collapseId ? { 'apns-collapse-id': opts.collapseId.slice(0, 64) } : {}),
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    });
    let status = 0, data = '';
    req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on('response', (h) => { status = Number(h[':status']); });
    req.setEncoding('utf8');
    req.on('data', (d) => (data += d));
    req.on('end', () => resolve({ status, body: data }));
    req.on('error', reject);
    req.on('close', () => { if (!status) reject(new Error('APNs cerró sin respuesta')); });
    req.end(body);
  });
  let r: { status: number; body: string };
  try { r = await exec(); } catch (e: any) {
    // Una conexión vieja cerrada por Apple: un reintento con conexión nueva.
    sessions.delete(apnsHost(environment));
    try { r = await exec(); } catch (e2: any) { return { ok: false, invalidToken: false, error: `apns_network: ${e2?.message ?? e?.message}` }; }
  }
  if (r.status === 200) return { ok: true };
  let reason = '';
  try { reason = JSON.parse(r.body).reason ?? ''; } catch {}
  if (r.status === 403 && /ProviderToken/.test(reason)) apnsJwt = null;
  const invalid = r.status === 410 || (r.status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(reason));
  return { ok: false, invalidToken: invalid, error: `apns_${r.status}${reason ? `_${reason}` : ''}` };
}

// ---------- FCM HTTP v1 ----------
interface FcmConfig { projectId: string; clientEmail: string; key: KeyObject; tokenUri: string }
let fcmCfg: FcmConfig | null | undefined;

export function fcmConfig(): FcmConfig | null {
  if (fcmCfg !== undefined) return fcmCfg;
  const raw = process.env.FCM_SERVICE_ACCOUNT || (process.env.FCM_SERVICE_ACCOUNT_PATH ? readFileSync(process.env.FCM_SERVICE_ACCOUNT_PATH, 'utf8') : '');
  if (!raw) {
    console.warn('[push] FCM sin configurar (FCM_SERVICE_ACCOUNT_PATH o FCM_SERVICE_ACCOUNT): los tokens de Android se guardan pero no se envían');
    return (fcmCfg = null);
  }
  const sa = JSON.parse(raw);
  return (fcmCfg = {
    projectId: sa.project_id, clientEmail: sa.client_email, key: createPrivateKey(String(sa.private_key)),
    tokenUri: sa.token_uri || 'https://oauth2.googleapis.com/token',
  });
}

let fcmAccess: { token: string; exp: number } | null = null;
async function fcmAccessToken(cfg: FcmConfig): Promise<string> {
  if (fcmAccess && Date.now() < fcmAccess.exp - 60_000) return fcmAccess.token;
  const iat = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: cfg.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: cfg.tokenUri, iat, exp: iat + 3600 }));
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), cfg.key);
  const res = await fetch(cfg.tokenUri, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(sig)}` }),
    signal: AbortSignal.timeout(10_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`fcm_oauth_${res.status}`);
  fcmAccess = { token: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
  return fcmAccess.token;
}

/** Mensaje de DATOS (sin `notification`): la app arma la notificación con su canal, MessagingStyle y burbuja. */
export async function sendFcm(token: string, data: Record<string, string>, opts: { collapseKey?: string } = {}): Promise<PushResult> {
  const cfg = fcmConfig();
  if (!cfg) return { ok: false, invalidToken: false, error: 'fcm_not_configured' };
  const host = process.env.FCM_HOST || 'https://fcm.googleapis.com';
  const send = async () => fetch(`${host}/v1/projects/${encodeURIComponent(cfg.projectId)}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await fcmAccessToken(cfg)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { token, data, android: { priority: 'high', ttl: '86400s', ...(opts.collapseKey ? { collapse_key: opts.collapseKey } : {}) } } }),
    signal: AbortSignal.timeout(10_000),
  });
  let res: Response;
  try {
    res = await send();
    if (res.status === 401) { fcmAccess = null; res = await send(); }
  } catch (e: any) { return { ok: false, invalidToken: false, error: `fcm_network: ${e?.message}` }; }
  if (res.ok) return { ok: true };
  const j: any = await res.json().catch(() => ({}));
  const code: string = (j?.error?.details ?? []).map((d: any) => d?.errorCode).find(Boolean) ?? j?.error?.status ?? '';
  const invalid = code === 'UNREGISTERED' || (res.status === 404 && code === 'NOT_FOUND');
  return { ok: false, invalidToken: invalid, error: `fcm_${res.status}${code ? `_${code}` : ''}` };
}

/** Solo para pruebas: olvida la configuración y los tokens en caché. */
export function resetPushConfig() { apnsCfg = undefined; fcmCfg = undefined; apnsJwt = null; fcmAccess = null; closePushConnections(); }
