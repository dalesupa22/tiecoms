/**
 * Agentes miembro (docs/AGENTES.md): una cuenta users.kind = 'agent' de una empresa, con dueño, que entra a grupos como
 * cualquier persona y habla por el MCP con su propio token. chaggu no corre el agente: le avisa por un webhook firmado
 * cuando le escriben por directo, lo mencionan o le responden (o, con allMessages, ante todo mensaje de sus grupos).
 *
 * Reglas:
 * - Lo que escribe un agente nunca dispara webhooks de agentes (evita bucles entre agentes y con bots de integraciones).
 * - La fila y el job se crean en la transacción del mensaje; el worker entrega con reintentos (como las integraciones)
 *   y revalida que el agente aún pueda leer el chat.
 * - Mensajes de una sola vista no se avisan.
 */
import { randomUUID } from 'node:crypto';
import type { MessageDTO } from '@tiecoms/contracts';
import { AddMembersInput } from '@tiecoms/contracts';
import { audit, pool, tx, type Tx } from '../db.ts';
import { config } from '../config.ts';
import { randomToken } from '../security.ts';
import { botCanRead, post, seal, sign, unseal, validateOutgoingUrl } from './integration-events.ts';
import { createToken } from './mcp.ts';
import { addMembers } from './workspaces.ts';

const MAX_ATTEMPTS = 10;
const ENDPOINT = () => `${config.publicOrigin}/api/mcp`;

export type AgentEventType = 'message.direct' | 'message.mention' | 'message.reply' | 'message.created';

export async function findAgent(orgId: string, name: string): Promise<string | null> {
  const { rows } = await pool.query(
    "SELECT u.id FROM users u JOIN organization_memberships om ON om.user_id = u.id AND om.org_id = $1 WHERE u.kind = 'agent' AND u.disabled_at IS NULL AND lower(u.name) = lower($2)",
    [orgId, name],
  );
  return rows[0]?.id ?? null;
}

/** Crea (o reutiliza por nombre dentro de la empresa) el agente y lo suma a los grupos. Token MCP solo si es nuevo. */
export async function createAgent(ownerId: string, orgId: string, name: string, conversationIds: string[], title = 'Agente') {
  let agent = await findAgent(orgId, name);
  const isNew = !agent;
  if (!agent) {
    agent = await tx(async (c) => {
      const id = (await c.query("INSERT INTO users (kind, name, primary_org_id) VALUES ('agent', $1, $2) RETURNING id", [name, orgId])).rows[0].id as string;
      await c.query("INSERT INTO organization_memberships (org_id, user_id, role, title, area) VALUES ($1,$2,'member',$3,'Agentes')", [orgId, id, title]);
      await audit(c, ownerId, 'agent.created', { type: 'user', id }, { orgId, name });
      return id;
    });
  }
  // Cada grupo lo suma alguien que lo pueda administrar: el dueño o, si no, quien creó el grupo (queda en el aviso del chat).
  const groups: Record<string, unknown> = {};
  for (const conv of conversationIds) {
    const creator = (await pool.query('SELECT created_by FROM conversations WHERE id = $1', [conv])).rows[0]?.created_by as string | undefined;
    let r: unknown = { error: 'Grupo no encontrado' };
    for (const actor of [...new Set([ownerId, creator].filter((x): x is string => !!x))]) {
      try { r = await addMembers(actor, conv, AddMembersInput.parse({ userIds: [agent], history: 'now' })); break; }
      catch (e: any) { r = { error: e?.message ?? String(e) }; }
    }
    groups[conv] = r;
  }
  const token = isNew ? await createToken(agent, `Agente ${name}`) : null;
  return { agentId: agent, name, orgId, isNew, groups, ...(token ? { mcpToken: token.token, endpoint: ENDPOINT() } : {}) };
}

export async function newAgentToken(agentId: string, name: string) {
  const token = await createToken(agentId, `Agente ${name}`);
  return { agentId, mcpToken: token.token, endpoint: ENDPOINT() };
}

/** Activa o cambia el webhook. Devuelve el secreto UNA vez si es nuevo (o si se pide rotarlo). url = null lo apaga. */
export async function setAgentWebhook(ownerId: string, agentId: string, url: string | null, opts: { allMessages?: boolean; rotate?: boolean } = {}) {
  if (!url) {
    await pool.query('UPDATE agent_webhooks SET revoked_at = now(), updated_at = now() WHERE agent_user_id = $1 AND revoked_at IS NULL', [agentId]);
    await pool.query("INSERT INTO audit_events (actor_id, action, target_type, target_id) VALUES ($1,'agent.webhook_off','user',$2)", [ownerId, agentId]);
    return { agentId, webhook: null };
  }
  validateOutgoingUrl(url);
  const cur = (await pool.query('SELECT url, revoked_at FROM agent_webhooks WHERE agent_user_id = $1', [agentId])).rows[0];
  const secret = !cur || cur.revoked_at || opts.rotate ? `whsec_${randomToken(32)}` : null;
  await pool.query(
    `INSERT INTO agent_webhooks (agent_user_id, url, secret, all_messages, created_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (agent_user_id) DO UPDATE SET url = EXCLUDED.url, all_messages = EXCLUDED.all_messages, revoked_at = NULL, updated_at = now(),
       secret = CASE WHEN $6 THEN EXCLUDED.secret ELSE agent_webhooks.secret END`,
    [agentId, url, seal(secret ?? 'x'), !!opts.allMessages, ownerId, !!secret],
  );
  await pool.query("INSERT INTO audit_events (actor_id, action, target_type, target_id, meta) VALUES ($1,'agent.webhook_set','user',$2,$3)",
    [ownerId, agentId, JSON.stringify({ host: new URL(url).host, allMessages: !!opts.allMessages, rotated: !!secret })]);
  return { agentId, webhook: { url, allMessages: !!opts.allMessages }, ...(secret ? { secret } : {}) };
}

export async function listAgents() {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, o.name AS org, om.title, ow.email AS owner,
            (SELECT array_agg(cv.name ORDER BY cv.name) FROM conversation_memberships m JOIN conversations cv ON cv.id = m.conversation_id
              WHERE m.user_id = u.id AND m.removed_at IS NULL AND cv.archived_at IS NULL AND cv.kind <> 'direct') AS groups,
            (SELECT max(t.last_used_at) FROM mcp_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS last_used_at,
            CASE WHEN aw.revoked_at IS NULL THEN aw.url END AS webhook, aw.all_messages,
            (SELECT count(*)::int FROM agent_deliveries d WHERE d.agent_user_id = u.id AND d.delivered_at IS NULL) AS pending
       FROM users u JOIN organization_memberships om ON om.user_id = u.id JOIN organizations o ON o.id = om.org_id
       LEFT JOIN audit_events al ON al.target_id = u.id AND al.action = 'agent.created' LEFT JOIN users ow ON ow.id = al.actor_id
       LEFT JOIN agent_webhooks aw ON aw.agent_user_id = u.id
      WHERE u.kind = 'agent' AND u.disabled_at IS NULL AND al.id IS NOT NULL ORDER BY o.name, u.name`,
  );
  return rows;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** «@semillero» escrito a mano (MCP, apps viejas) también cuenta como mención. */
const namedIn = (body: string, name: string) => new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRe(name)}(?![\\p{L}\\p{N}_])`, 'iu').test(body);

/** En la transacción de sendMessage: encola el aviso para cada agente con webhook a quien va dirigido el mensaje. */
export async function queueAgentEvents(c: Tx, m: MessageDTO) {
  if (m.kind !== 'text' || m.viewOnce) return;
  const { rows: agents } = await c.query(
    `SELECT aw.agent_user_id AS id, u.name, aw.all_messages FROM agent_webhooks aw
       JOIN users u ON u.id = aw.agent_user_id AND u.disabled_at IS NULL
       JOIN conversation_memberships cm ON cm.conversation_id = $1 AND cm.user_id = aw.agent_user_id AND cm.removed_at IS NULL
      WHERE aw.revoked_at IS NULL AND aw.agent_user_id <> $2`,
    [m.conversationId, m.authorId],
  );
  if (!agents.length) return;
  const ctx = (await c.query(
    `SELECT cv.kind, cv.name, a.name AS author_name, a.kind AS author_kind, o.name AS author_org,
            (SELECT author_id FROM messages WHERE id = $3) AS reply_author
       FROM conversations cv JOIN users a ON a.id = $2 LEFT JOIN organizations o ON o.id = a.primary_org_id WHERE cv.id = $1`,
    [m.conversationId, m.authorId, m.replyTo],
  )).rows[0];
  if (!ctx || ctx.author_kind === 'agent') return;
  const mentioned = new Set((m.mentions ?? []).map((x) => x.userId));
  for (const a of agents) {
    const type: AgentEventType | null = ctx.kind === 'direct' ? 'message.direct'
      : mentioned.has(a.id) || namedIn(m.body, a.name) ? 'message.mention'
        : m.replyTo && ctx.reply_author === a.id ? 'message.reply'
          : a.all_messages ? 'message.created' : null;
    if (!type) continue;
    const event = {
      id: randomUUID(), type, createdAt: new Date().toISOString(),
      agent: { id: a.id, name: a.name },
      conversation: { id: m.conversationId, kind: ctx.kind, name: ctx.kind === 'direct' ? null : ctx.name },
      message: {
        id: m.id, seq: m.seq, body: m.body, replyTo: m.replyTo, topicId: m.topicId ?? null,
        attachments: (m.attachments ?? []).map((x) => ({ id: x.id, name: x.name, contentType: x.contentType, sizeBytes: x.sizeBytes })),
        author: { id: m.authorId, name: ctx.author_name, org: ctx.author_org ?? null },
      },
      // Cómo contestar por el MCP con el token del agente.
      reply: { tool: 'send_message', arguments: { chat: m.conversationId, reply_to: m.id } },
    };
    await c.query('INSERT INTO agent_deliveries (id, agent_user_id, conversation_id, event_type, payload) VALUES ($1,$2,$3,$4,$5)',
      [event.id, a.id, m.conversationId, type, JSON.stringify(event)]);
    await c.query("INSERT INTO jobs (kind, payload, max_attempts) VALUES ('agent.deliver', $1, $2)", [JSON.stringify({ deliveryId: event.id }), MAX_ATTEMPTS]);
  }
}

/** Job del worker. Lanza si falla para que el worker reintente; webhook apagado o sin acceso al chat → se descarta. */
export async function deliverAgentEvent(deliveryId: string) {
  const { rows } = await pool.query(
    `SELECT d.*, aw.url, aw.secret, aw.revoked_at FROM agent_deliveries d JOIN agent_webhooks aw ON aw.agent_user_id = d.agent_user_id WHERE d.id = $1`,
    [deliveryId],
  );
  const d = rows[0];
  if (!d || d.delivered_at || d.revoked_at) return;
  if (!await botCanRead(pool, d.agent_user_id, d.conversation_id)) return;
  const body = JSON.stringify(d.payload);
  let status = 0; let error: string | null = null;
  try {
    const r = await post(new URL(d.url), body, { 'x-chaggu-event': d.event_type, 'x-chaggu-delivery': d.id, 'x-chaggu-signature': sign(unseal(d.secret), body) });
    status = r.status;
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch { error = 'No se pudo entregar al destino'; }
  await pool.query(
    'UPDATE agent_deliveries SET attempts = attempts + 1, last_status = $2, last_error = $3, delivered_at = CASE WHEN $3::text IS NULL THEN now() END WHERE id = $1',
    [d.id, status || null, error],
  );
  if (error) throw new Error(`Entrega a agente ${d.id}: ${error}`);
}
