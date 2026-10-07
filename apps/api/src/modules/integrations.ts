/**
 * Integraciones por grupo: un sistema externo (la mesa de ayuda, la landing, un CRM) publica en un grupo de Chaggu
 * como un participante bot.
 *
 * - Webhook entrante con el formato de Slack: `POST /api/hooks/{id}` con `Authorization: Bearer chg_…`
 *   (o `/api/hooks/{id}/{token}` para sistemas que solo aceptan una URL). Basta cambiar la URL de Slack.
 * - API de asuntos con el mismo token (`/api/integration/v1/…`): crear un asunto por ticket, comentarlo y moverlo.
 * - Webhook de salida (integration-events.ts): cambios de estado y comentarios de la gente vuelven al sistema externo.
 *
 * Las crea, rota y revoca quien administra el espacio (lead/admin) o la empresa dueña (owner/admin). Los admins
 * del grupo las ven (sin secretos).
 */
import type { z } from 'zod';
import type {
  CreateIntegrationInput, IncomingWebhookInput, IntegrationCommentInput, IntegrationCreateIssueInput, IntegrationDTO,
  IntegrationSecretDTO, IntegrationUpdateIssueInput, UpdateIntegrationInput, WebhookTaskInput,
} from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { config } from '../config.ts';
import { audit, pool, tx, type Db, type Tx } from '../db.ts';
import { ApiError, badRequest, forbidden, notFound, unauthorized, taskNotFound } from '../errors.ts';
import { randomToken, sha256 } from '../security.ts';
import * as issues from './issues.ts';
import { seal, validateOutgoingUrl } from './integration-events.ts';
import { appendMessage } from './messages.ts';
import { membersChanged } from './workspaces.ts';

const sys = (k: string, p: Record<string, unknown> = {}) => JSON.stringify({ k, ...p });
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const MAX_PER_GROUP = 10;

export const webhookUrl = (id: string) => `${config.publicOrigin}/api/hooks/${id}`;

function toDTO(r: any): IntegrationDTO {
  return {
    id: r.id, workspaceId: r.workspace_id, conversationId: r.conversation_id, botUserId: r.bot_user_id, name: r.name,
    tokenHint: r.token_hint, webhookUrl: webhookUrl(r.id), outgoingUrl: r.outgoing_url ?? null, createdBy: r.created_by,
    createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at), failingDeliveries: r.failing ?? 0,
  };
}

const SELECT = `SELECT ig.*, (SELECT count(*) FROM integration_deliveries d WHERE d.integration_id = ig.id AND d.delivered_at IS NULL AND d.attempts > 0)::int AS failing FROM integrations ig`;

/** Quien administra el espacio o la empresa dueña. Solo grupos de un espacio (no directos ni chats sueltos). */
async function assertIntegrationAdmin(c: Db, userId: string, conversationId: string) {
  const { rows } = await c.query(
    `SELECT c.id, c.kind, c.workspace_id, w.owning_org_id,
            EXISTS (SELECT 1 FROM workspace_memberships wm WHERE wm.workspace_id = c.workspace_id AND wm.user_id = $2
                     AND wm.revoked_at IS NULL AND wm.role IN ('lead','admin')) AS ws_admin,
            EXISTS (SELECT 1 FROM organization_memberships om WHERE om.org_id = w.owning_org_id AND om.user_id = $2
                     AND om.role IN ('owner','admin')) AS org_admin
       FROM conversations c JOIN workspaces w ON w.id = c.workspace_id AND w.archived_at IS NULL
      WHERE c.id = $1 AND c.archived_at IS NULL`,
    [conversationId, userId],
  );
  const r = rows[0];
  if (!r || !['group', 'internal'].includes(r.kind)) throw notFound('Grupo');
  if (!r.ws_admin && !r.org_admin) throw forbidden('Solo quien administra el espacio o la empresa configura integraciones');
  return { workspaceId: r.workspace_id as string, owningOrgId: r.owning_org_id as string };
}

async function loadOwned(c: Db, userId: string, integrationId: string) {
  const { rows } = await c.query(`${SELECT} WHERE ig.id = $1 AND ig.revoked_at IS NULL`, [integrationId]);
  if (!rows[0]) throw notFound('Integración');
  await assertIntegrationAdmin(c, userId, rows[0].conversation_id);
  return rows[0];
}

const newToken = () => `chg_${randomToken(32)}`;
const newSecret = () => `whsec_${randomToken(32)}`;

function secretDTO(r: any, token: string, outgoingSecret: string | null): IntegrationSecretDTO {
  return { integration: toDTO(r), token, webhookUrlWithToken: `${webhookUrl(r.id)}/${token}`, outgoingSecret };
}

/** Lista para la información del grupo: la ven sus admins y quien administra el espacio; `canConfigure` dice si puede cambiarlas. */
export async function listIntegrations(userId: string, conversationId: string) {
  const a = await conversationAccess(pool, userId, conversationId, 'read');
  let canConfigure = true;
  try { await assertIntegrationAdmin(pool, userId, conversationId); } catch { canConfigure = false; }
  if (!canConfigure && !a.canManage) throw forbidden('Solo los admins del grupo ven sus integraciones');
  const { rows } = await pool.query(`${SELECT} WHERE ig.conversation_id = $1 AND ig.revoked_at IS NULL ORDER BY ig.created_at`, [conversationId]);
  return { integrations: rows.map((r) => {
    const dto = toDTO(r);
    // Destination paths/queries can themselves be secret webhook credentials.
    if (!canConfigure && dto.outgoingUrl) dto.outgoingUrl = new URL(dto.outgoingUrl).origin;
    return dto;
  }), canConfigure };
}

export async function createIntegration(userId: string, conversationId: string, input: z.infer<typeof CreateIntegrationInput>) {
  if (input.outgoingUrl) validateOutgoingUrl(input.outgoingUrl);
  return tx(async (c) => {
    const { workspaceId } = await assertIntegrationAdmin(c, userId, conversationId);
    await c.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
    const n = (await c.query('SELECT count(*)::int AS n FROM integrations WHERE conversation_id = $1 AND revoked_at IS NULL', [conversationId])).rows[0].n;
    if (n >= MAX_PER_GROUP) throw badRequest(`Máximo ${MAX_PER_GROUP} integraciones por grupo`);
    // El bot: participante del grupo (y del espacio, que es lo que exige el control de acceso), sin empresa y sin sesión.
    const bot = (await c.query("INSERT INTO users (kind, name) VALUES ('agent', $1) RETURNING id", [input.name])).rows[0].id as string;
    await c.query("INSERT INTO workspace_memberships (workspace_id, user_id, org_id, role, sponsor_id) VALUES ($1,$2,NULL,'member',$3)", [workspaceId, bot, userId]);
    const seq = (await c.query('SELECT last_message_seq FROM conversations WHERE id = $1', [conversationId])).rows[0].last_message_seq;
    await c.query(
      'INSERT INTO conversation_memberships (conversation_id, user_id, can_post, can_manage, history_from_seq, added_by) VALUES ($1,$2,true,false,$3,$4)',
      [conversationId, bot, seq, userId],
    );
    const token = newToken();
    const secret = input.outgoingUrl ? newSecret() : null;
    const { rows } = await c.query(
      `INSERT INTO integrations (workspace_id, conversation_id, bot_user_id, name, token_hash, token_hint, outgoing_url, outgoing_secret, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [workspaceId, conversationId, bot, input.name, sha256(token), token.slice(-4), input.outgoingUrl ?? null, secret ? seal(secret) : null, userId],
    );
    await appendMessage(c, { conversationId, authorId: userId, kind: 'system', body: sys('integration.added', { name: input.name }) });
    await membersChanged(c, conversationId);
    await audit(c, userId, 'integration.created', { type: 'integration', id: rows[0].id, workspaceId }, { conversationId, outgoing: !!input.outgoingUrl });
    return secretDTO({ ...rows[0], failing: 0 }, token, secret);
  });
}

export async function updateIntegration(userId: string, integrationId: string, input: z.infer<typeof UpdateIntegrationInput>) {
  if (input.outgoingUrl) validateOutgoingUrl(input.outgoingUrl);
  return tx(async (c) => {
    const cur = await loadOwned(c, userId, integrationId);
    let secret: string | null = null;
    const url = input.outgoingUrl !== undefined ? input.outgoingUrl : cur.outgoing_url;
    // Una URL de salida nueva sin secreto (o si lo piden) recibe uno nuevo.
    if (url && (input.rotateOutgoingSecret || !cur.outgoing_secret || (input.outgoingUrl && input.outgoingUrl !== cur.outgoing_url))) secret = newSecret();
    await c.query(
      `UPDATE integrations SET name = COALESCE($2, name), outgoing_url = $3,
              outgoing_secret = CASE WHEN $3::text IS NULL THEN NULL WHEN $4::bytea IS NOT NULL THEN $4 ELSE outgoing_secret END
        WHERE id = $1`,
      [integrationId, input.name ?? null, url ?? null, secret ? seal(secret) : null],
    );
    if (input.name && input.name !== cur.name) await c.query('UPDATE users SET name = $2 WHERE id = $1', [cur.bot_user_id, input.name]);
    await audit(c, userId, 'integration.updated', { type: 'integration', id: integrationId, workspaceId: cur.workspace_id }, { outgoing: !!url, rotatedSecret: !!secret });
    const r = (await c.query(`${SELECT} WHERE ig.id = $1`, [integrationId])).rows[0];
    return { integration: toDTO(r), outgoingSecret: secret };
  });
}

export async function rotateToken(userId: string, integrationId: string) {
  return tx(async (c) => {
    const cur = await loadOwned(c, userId, integrationId);
    const token = newToken();
    const { rows } = await c.query(`UPDATE integrations SET token_hash = $2, token_hint = $3, rotated_at = now() WHERE id = $1 RETURNING *`, [integrationId, sha256(token), token.slice(-4)]);
    await audit(c, userId, 'integration.token_rotated', { type: 'integration', id: integrationId, workspaceId: cur.workspace_id });
    return secretDTO({ ...rows[0], failing: cur.failing }, token, null);
  });
}

/** Revocar: el token deja de servir y el bot sale del grupo; sus mensajes y asuntos quedan. */
export async function revokeIntegration(userId: string, integrationId: string) {
  await tx(async (c) => {
    const cur = await loadOwned(c, userId, integrationId);
    await c.query('UPDATE integrations SET revoked_at = now() WHERE id = $1', [integrationId]);
    await c.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [cur.conversation_id]);
    await c.query('UPDATE conversation_memberships SET removed_at = now() WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL', [cur.conversation_id, cur.bot_user_id]);
    await c.query('UPDATE workspace_memberships SET revoked_at = now() WHERE workspace_id = $1 AND user_id = $2', [cur.workspace_id, cur.bot_user_id]);
    await appendMessage(c, { conversationId: cur.conversation_id, authorId: userId, kind: 'system', body: sys('integration.removed', { name: cur.name }) });
    await membersChanged(c, cur.conversation_id);
    await audit(c, userId, 'integration.revoked', { type: 'integration', id: integrationId, workspaceId: cur.workspace_id });
  });
  return { ok: true };
}

// ---------- Lado del sistema externo (token del grupo) ----------

export interface IntegrationAuth { id: string; conversationId: string; workspaceId: string; botUserId: string; name: string }

/** Valida el token. Si viene el id (webhook entrante), debe coincidir. */
export async function authenticate(token: string | undefined, id?: string): Promise<IntegrationAuth> {
  if (!token || !token.startsWith('chg_') || token.length > 100) throw unauthorized('Token de integración inválido');
  const { rows } = await pool.query(
    `SELECT ig.id, ig.conversation_id, ig.workspace_id, ig.bot_user_id, ig.name, ig.last_used_at FROM integrations ig
       JOIN conversations c ON c.id = ig.conversation_id AND c.archived_at IS NULL
      WHERE ig.token_hash = $1 AND ig.revoked_at IS NULL`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r || (id && r.id !== id)) throw unauthorized('Token de integración inválido');
  if (!r.last_used_at || Date.now() - new Date(r.last_used_at).getTime() > 60_000) {
    await pool.query('UPDATE integrations SET last_used_at = now() WHERE id = $1', [r.id]);
  }
  return { id: r.id, conversationId: r.conversation_id, workspaceId: r.workspace_id, botUserId: r.bot_user_id, name: r.name };
}

/** Canonical payload fingerprints ignore JSON object-key ordering, but never payload/resource changes. */
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)])) : v;

/** The side effect and replay receipt commit together. Concurrent calls serialize on the same key. */
async function idempotent<T>(integ: IntegrationAuth, key: string | undefined, operation: string, payload: unknown, run: (c: Tx) => Promise<T>): Promise<T> {
  if (key && key.length > 200) throw badRequest('Idempotency-Key demasiado larga');
  return tx(async (c) => {
    // A replay must not bypass access revoked since the original request.
    await conversationAccess(c, integ.botUserId, integ.conversationId, 'post');
    const hash = sha256(JSON.stringify(canonical([operation, payload])));
    if (key) {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`integration-request:${integ.id}:${key}`]);
      const prev = (await c.query('SELECT response, request_hash FROM integration_requests WHERE integration_id = $1 AND idempotency_key = $2', [integ.id, key])).rows[0];
      if (prev) {
        if (prev.request_hash && !prev.request_hash.equals(hash)) throw new ApiError(409, 'idempotency_mismatch', 'Esta llave ya se usó para otra operación o contenido');
        // Pre-migration receipts cannot be fingerprinted retrospectively. Preserve their
        // stored response without repeating a committed side effect.
        return prev.response as T;
      }
    }
    const out = await run(c);
    if (key) await c.query('INSERT INTO integration_requests (integration_id, idempotency_key, response, request_hash) VALUES ($1,$2,$3,$4)', [integ.id, key, JSON.stringify(out), hash]);
    return out;
  });
}

/** mrkdwn de Slack → texto plano de Chaggu (los mensajes no llevan formato). */
export function slackText(s: string): string {
  return s
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<mailto:([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<[@#!][^|>]*\|([^>]+)>/g, '$1')
    .replace(/<[@#!][^>]*>/g, '')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/g, '$1$2')
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,:;!?]|$)/g, '$1$2')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

function blockText(b: any): string {
  const t = (o: any) => (typeof o?.text === 'string' ? slackText(o.text) : '');
  switch (b?.type) {
    case 'header': return t(b.text).toUpperCase();
    case 'section': return [t(b.text), ...(Array.isArray(b.fields) ? b.fields.map(t) : [])].filter(Boolean).join('\n');
    case 'context': return (Array.isArray(b.elements) ? b.elements.map(t) : []).filter(Boolean).join(' · ');
    case 'divider': return '—';
    case 'rich_text': {
      const walk = (e: any): string => (typeof e?.text === 'string' ? e.text : e?.type === 'link' ? (e.text ?? e.url ?? '') : Array.isArray(e?.elements) ? e.elements.map(walk).join('') : '');
      return (b.elements ?? []).map(walk).join('\n');
    }
    default: return '';
  }
}

/** Arma el texto de un payload de Slack: blocks (si hay) o text, y luego attachments. */
export function slackPayloadText(p: z.infer<typeof IncomingWebhookInput>): string {
  const parts: string[] = [];
  const fromBlocks = (p.blocks ?? []).map(blockText).filter(Boolean).join('\n');
  parts.push(fromBlocks || slackText(p.text ?? ''));
  for (const a of p.attachments ?? []) {
    const lines = [a?.pretext, a?.title, a?.text].filter((x) => typeof x === 'string' && x).map((x: string) => slackText(x));
    for (const f of Array.isArray(a?.fields) ? a.fields : []) if (f?.title || f?.value) lines.push(`${slackText(String(f.title ?? ''))}: ${slackText(String(f.value ?? ''))}`);
    if (Array.isArray(a?.blocks)) lines.push(...a.blocks.map(blockText).filter(Boolean));
    if (!lines.length && typeof a?.fallback === 'string') lines.push(slackText(a.fallback));
    if (lines.length) parts.push(lines.join('\n'));
  }
  return parts.filter(Boolean).join('\n\n').slice(0, 12_000);
}

export async function postMessage(integ: IntegrationAuth, input: z.infer<typeof IncomingWebhookInput>, key?: string) {
  const body = slackPayloadText(input);
  if (!body) throw badRequest('El mensaje está vacío (manda text o blocks)');
  return idempotent(integ, key, 'message', { body }, async (c) => {
    await conversationAccess(c, integ.botUserId, integ.conversationId, 'post', true);
    const m = await appendMessage(c, { conversationId: integ.conversationId, authorId: integ.botUserId, body, clientMessageId: key ?? null });
    return { ok: true, messageId: m.id };
  });
}

async function issueOf(c: Db, integ: IntegrationAuth, issueId: string) {
  const { rows } = await c.query('SELECT id FROM issues WHERE id = $1 AND integration_id = $2', [issueId, integ.id]);
  if (!rows[0]) throw taskNotFound();
}

/** Correos → personas que participan en el grupo (solo a ellas se les puede asignar una tarea de todo el chat). */
async function membersByEmail(c: Db, conversationId: string, emails: string[] | undefined) {
  if (!emails?.length) return { ids: [] as string[], ignored: [] as string[] };
  const { rows } = await c.query(
    `SELECT lower(u.email) AS email, u.id FROM users u JOIN conversation_memberships cm ON cm.user_id = u.id AND cm.conversation_id = $1 AND cm.removed_at IS NULL
      WHERE lower(u.email) = ANY($2) AND u.disabled_at IS NULL`, [conversationId, emails]);
  const found = new Map(rows.map((r) => [r.email as string, r.id as string]));
  return { ids: [...new Set(emails.flatMap((e) => found.get(e) ?? []))], ignored: emails.filter((e) => !found.has(e)) };
}

const fieldLines = (f: Record<string, unknown> | null | undefined) => Object.entries(f ?? {}).filter(([, v]) => v !== null && v !== '')
  .map(([k, v]) => `${k}: ${typeof v === 'boolean' ? (v ? 'sí' : 'no') : v}`);

/** Un asunto por ticket. El mismo externalId devuelve el mismo asunto (idempotente). Sin externalId, siempre crea. */
export async function createIssue(integ: IntegrationAuth, input: Omit<z.infer<typeof IntegrationCreateIssueInput>, 'externalId'> & { externalId?: string | null }, existing?: Tx) {
  const run = async (c: Tx) => {
    // Validate even on externalId replays: an invalid destination never becomes a successful receipt.
    if (input.topicId) await issues.assertTopic(c, integ.conversationId, input.topicId);
    // Candado por (integración, externalId): dos reintentos simultáneos no crean dos asuntos.
    if (input.externalId) {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${integ.id}:${input.externalId}`]);
      const prev = await c.query('SELECT id FROM issues WHERE integration_id = $1 AND external_id = $2', [integ.id, input.externalId]);
      if (prev.rows[0]) return { issue: (await issues.getIssue(integ.botUserId, prev.rows[0].id, c)).issue, created: false };
    }
    const who = await membersByEmail(c, integ.conversationId, input.assigneeEmails);
    const dto = await issues.createIssue(integ.botUserId, integ.conversationId, {
      title: input.title, ownerId: null, visibility: 'all', topicId: input.topicId, ...(who.ids.length ? { assigneeIds: who.ids } : {}),
      ...(input.dueDate ? { dueDate: input.dueDate } : {}), ...(input.fields ? { fields: input.fields } : {}),
    } as any, c);
    // The issue, source binding, comments, announcement and outbox are one atomic import.
    await c.query('UPDATE issues SET integration_id = $2, external_id = $3, external_meta = $4 WHERE id = $1', [dto.id, integ.id, input.externalId ?? null, input.externalMeta ? JSON.stringify(input.externalMeta) : null]);
    if (input.description) await issues.commentIssue(integ.botUserId, dto.id, input.description, {}, c);
    // Ticket sin responsable: que se note en «Nuevas» de las personas del grupo (llamada con Lorena 7-oct).
    if (!who.ids.length) {
      const { rows: people } = await c.query(
        `SELECT cm.user_id FROM conversation_memberships cm JOIN users u ON u.id = cm.user_id
          WHERE cm.conversation_id = $1 AND cm.removed_at IS NULL AND u.kind <> 'agent' AND u.disabled_at IS NULL AND cm.user_id <> $2`,
        [integ.conversationId, integ.botUserId]);
      for (const p of people) await issues.notifyInbox(c, dto.id, p.user_id, integ.botUserId, 'ticket');
    }
    for (const h of input.history ?? []) {
      await issues.commentIssue(integ.botUserId, dto.id, `${h.author}${h.at ? ` · ${h.at}` : ''}\n${h.body}`, { author: h.author, ...(h.at ? { at: h.at } : {}) }, c);
    }
    if (input.status && input.status !== 'open') await issues.updateIssue(integ.botUserId, dto.id, { status: input.status }, c);
    if (input.announce) {
      const meta = [...fieldLines(input.externalMeta), ...fieldLines(dto.fields)].join('\n');
      const excerpt = input.description ? `\n\n${input.description.slice(0, 600)}${input.description.length > 600 ? '…' : ''}` : '';
      await appendMessage(c, { conversationId: integ.conversationId, authorId: integ.botUserId, topicId: dto.topicId, body: `${input.title}${meta ? `\n${meta}` : ''}${excerpt}` });
    }
    return { issue: (await issues.getIssue(integ.botUserId, dto.id, c)).issue, created: true, ...(who.ignored.length ? { ignoredAssignees: who.ignored } : {}) };
  };
  return existing ? run(existing) : tx(run);
}

/**
 * Webhook de tareas (`/api/hooks/{id}/{token}/tasks`): un sistema avisa algo que no pudo hacer (o cualquier pendiente)
 * y queda como tarea del grupo, con sus campos como columnas. Con `externalId` es idempotente por ticket; sin él,
 * la `Idempotency-Key` evita duplicar reintentos.
 */
export async function createTaskFromHook(integ: IntegrationAuth, input: z.infer<typeof WebhookTaskInput>, key?: string) {
  const { body, text, ...rest } = input;
  const task = { ...rest, description: rest.description ?? body ?? text };
  if (task.externalId || !key) return createIssue(integ, task);
  return idempotent(integ, key, 'task', task, (c) => createIssue(integ, task, c));
}

export async function findIssue(integ: IntegrationAuth, externalId: string) {
  const { rows } = await pool.query('SELECT id FROM issues WHERE integration_id = $1 AND external_id = $2', [integ.id, externalId]);
  if (!rows[0]) throw taskNotFound();
  return getIssue(integ, rows[0].id);
}

export async function getIssue(integ: IntegrationAuth, issueId: string) {
  await issueOf(pool, integ, issueId);
  const r = await issues.getIssue(integ.botUserId, issueId);
  const ids = [...new Set(r.events.map((e) => e.actorId))];
  const names = new Map((await pool.query('SELECT id, name, kind FROM users WHERE id = ANY($1)', [ids])).rows.map((u) => [u.id, u]));
  return {
    issue: r.issue,
    events: r.events.map((e) => ({ ...e, actorName: names.get(e.actorId)?.name ?? null, actorIsBot: names.get(e.actorId)?.kind === 'agent' })),
  };
}

export async function updateIssue(integ: IntegrationAuth, issueId: string, input: z.infer<typeof IntegrationUpdateIssueInput>) {
  return tx(async (c) => {
    await issueOf(c, integ, issueId);
    const patch: Record<string, unknown> = {};
    if (input.status) patch.status = input.status;
    if (input.title) patch.title = input.title;
    if (input.topicId !== undefined) patch.topicId = input.topicId;
    if (input.fields) patch.fields = input.fields;
    if (input.review !== undefined) patch.review = input.review;
    // Permission check and metadata update belong to the same transaction as the status/title.
    await issues.updateIssue(integ.botUserId, issueId, patch as any, c);
    if (input.externalMeta) await c.query('UPDATE issues SET external_meta = $2 WHERE id = $1', [issueId, JSON.stringify(input.externalMeta)]);
    return { issue: (await issues.getIssue(integ.botUserId, issueId, c)).issue };
  });
}

export async function commentIssue(integ: IntegrationAuth, issueId: string, input: z.infer<typeof IntegrationCommentInput>, key?: string) {
  await issueOf(pool, integ, issueId);
  return idempotent(integ, key, `comment:${issueId}`, input, async (c) => {
    const body = input.author ? `${input.author}\n${input.body}` : input.body;
    const issue = await issues.commentIssue(integ.botUserId, issueId, body, input.author ? { author: input.author } : {}, c);
    return { issue };
  });
}

export async function describe(integ: IntegrationAuth) {
  const { rows } = await pool.query('SELECT c.name FROM conversations c WHERE c.id = $1', [integ.conversationId]);
  return { id: integ.id, name: integ.name, conversationId: integ.conversationId, conversationName: rows[0]?.name ?? null, workspaceId: integ.workspaceId, capabilities: { issueTopics: true } };
}
