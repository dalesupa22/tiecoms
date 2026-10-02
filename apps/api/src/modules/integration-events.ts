/**
 * Webhook de salida de las integraciones: cuando alguien cambia el estado o comenta un asunto que vino de una
 * integración (p. ej. un ticket de la mesa de ayuda), se avisa al sistema externo. La fila y el job se crean en la
 * misma transacción del cambio; el worker entrega con reintentos y firma HMAC. Lo que hace el propio bot no se avisa.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { IntegrationEventDTO, IssueStatus } from '@tiecoms/contracts';
import { config } from '../config.ts';
import { conversationAccess } from '../access.ts';
import { ApiError, badRequest } from '../errors.ts';
import { pool, type Tx } from '../db.ts';
import { isPublicIp, safeLookup } from './link-preview.ts';

const KEY = createHash('sha256').update(`chaggu:integrations:${process.env.INTEGRATIONS_KEY ?? config.jwtSecret}`).digest();
export function seal(v: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
export function unseal(b: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

/** Solo para pruebas locales: permite entregar a http://localhost. En producción no se define. */
const ALLOW_LOCAL = config.env !== 'production' && process.env.INTEGRATIONS_ALLOW_LOCAL === 'true';
const MAX_ATTEMPTS = 10;

export const issueUrl = (id: string) => `${config.publicOrigin}/asuntos?issue=${id}`;

export async function botCanRead(db: Tx | typeof pool, userId: string, conversationId: string): Promise<boolean> {
  try { await conversationAccess(db, userId, conversationId, 'read'); return true; } catch (error) {
    if (error instanceof ApiError && [403, 404].includes(error.status)) return false;
    throw error;
  }
}

type Extra = { type: 'issue.status_changed'; from: IssueStatus; to: IssueStatus } | { type: 'issue.commented'; body: string } | { type: 'issue.updated' };

export async function queueIntegrationEvent(c: Tx, issueId: string, actorId: string, extra: Extra) {
  const { rows } = await c.query(
    `SELECT i.id, i.title, i.status, i.external_id, ig.id AS integration_id, ig.bot_user_id, ig.conversation_id, ig.outgoing_url, u.name AS actor_name
       FROM issues i JOIN integrations ig ON ig.id = i.integration_id AND ig.revoked_at IS NULL
       JOIN users u ON u.id = $2
      WHERE i.id = $1`,
    [issueId, actorId],
  );
  const r = rows[0];
  if (!r || !r.outgoing_url || r.bot_user_id === actorId) return;
  if (!await botCanRead(c, r.bot_user_id, r.conversation_id)) return;
  const event: IntegrationEventDTO = {
    id: randomUUID(), type: extra.type, createdAt: new Date().toISOString(), integrationId: r.integration_id,
    issue: { id: r.id, externalId: r.external_id, title: r.title, status: r.status, url: issueUrl(r.id) },
    actor: { id: actorId, name: r.actor_name },
    ...(extra.type === 'issue.status_changed' ? { from: extra.from, to: extra.to } : {}),
    ...(extra.type === 'issue.commented' ? { comment: { body: extra.body } } : {}),
  };
  const d = await c.query(
    'INSERT INTO integration_deliveries (id, integration_id, event_type, payload) VALUES ($1,$2,$3,$4) RETURNING id',
    [event.id, r.integration_id, event.type, JSON.stringify(event)],
  );
  await c.query("INSERT INTO jobs (kind, payload, max_attempts) VALUES ('integration.deliver', $1, $2)", [JSON.stringify({ deliveryId: d.rows[0].id }), MAX_ATTEMPTS]);
}

/** Firma al estilo Stripe: `t=<unix>,v1=<hex(hmac_sha256(secret, "<t>.<body>"))>`. */
export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** Validate literals too: Node bypasses the DNS lookup hook for IP-address URLs. */
export function validateOutgoingUrl(value: string, allowLocal = ALLOW_LOCAL): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw badRequest('URL de salida inválida'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(host);
  if (url.username || url.password) throw badRequest('La URL de salida no admite credenciales');
  if (url.protocol !== 'https:' && !local) throw badRequest('La URL de salida requiere HTTPS');
  if (!local && net.isIP(host) && !isPublicIp(host)) throw badRequest('Dirección de salida no permitida');
  return url;
}

export function post(url: URL, body: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    try { validateOutgoingUrl(url.toString()); } catch (e) { reject(e); return; }
    const local = ALLOW_LOCAL && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'POST', timeout: 10_000, ...(local ? {} : { lookup: safeLookup }),
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'user-agent': 'Chaggu-Webhooks/1', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (ch: string) => { if (text.length < 2000) text += ch; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo agotado')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Job del worker. Lanza si falla para que el worker reintente con backoff; una integración revocada se descarta. */
export async function deliverIntegrationEvent(deliveryId: string) {
  const { rows } = await pool.query(
    `SELECT d.*, ig.outgoing_url, ig.outgoing_secret, ig.revoked_at, ig.bot_user_id, ig.conversation_id FROM integration_deliveries d
       JOIN integrations ig ON ig.id = d.integration_id WHERE d.id = $1`,
    [deliveryId],
  );
  const d = rows[0];
  if (!d || d.delivered_at || d.revoked_at || !d.outgoing_url || !d.outgoing_secret) return;
  // A queued delivery must not outlive the bot's right to read its source group.
  if (!await botCanRead(pool, d.bot_user_id, d.conversation_id)) return;
  const body = JSON.stringify(d.payload);
  let status = 0; let error: string | null = null;
  try {
    const r = await post(new URL(d.outgoing_url), body, {
      'x-chaggu-event': d.event_type, 'x-chaggu-delivery': d.id, 'x-chaggu-signature': sign(unseal(d.outgoing_secret), body),
    });
    status = r.status;
    if (status < 200 || status >= 300) error = `HTTP ${status}`; // Never persist/log a receiver body that can echo credentials.
  } catch { error = 'No se pudo entregar al destino'; } // DNS/network errors may contain sensitive destination URLs.
  await pool.query(
    `UPDATE integration_deliveries SET attempts = attempts + 1, last_status = $2, last_error = $3, delivered_at = CASE WHEN $3::text IS NULL THEN now() END WHERE id = $1`,
    [d.id, status || null, error],
  );
  if (error) throw new Error(`Entrega ${d.id}: ${error}`);
}
