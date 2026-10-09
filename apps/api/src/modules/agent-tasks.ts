/**
 * La IA escucha el tablero (llamada con Lorena, 7-oct): el mismo webhook firmado de los agentes miembro
 * (docs/AGENTES.md) también avisa de tareas, para que el agente tome la tarjeta, la resuelva, cargue la evidencia y
 * la deje «por revisar»; si la persona pide corrección o comenta, la vuelve a tomar.
 *
 * - task.created: llegó un ticket sin responsable a un grupo del agente.
 * - task.assigned: le asignaron la tarea al agente.
 * - task.changes_requested / task.approved / task.needs_human: la persona revisó lo que el agente dejó por revisar.
 * - task.commented: alguien comentó una tarea que el agente tiene asignada o dejó por revisar.
 *
 * Mismas reglas que los avisos de mensajes: lo que hace un agente miembro nunca avisa a otro agente (los bots de
 * integración sí, porque son los que abren los tickets), solo tareas de un chat
 * que el agente puede leer, y el worker entrega con reintentos (job agent.deliver).
 */
import { randomUUID } from 'node:crypto';
import type { IssueDTO, TaskInboxReason } from '@tiecoms/contracts';
import type { Tx } from '../db.ts';
import { botCanRead, issueUrl } from './integration-events.ts';

const MAX_ATTEMPTS = 10;

export type AgentTaskEventType = 'task.created' | 'task.assigned' | 'task.changes_requested' | 'task.approved' | 'task.deploy_approved' | 'task.needs_human' | 'task.commented';

/** Qué aviso recibe un agente según el motivo de la bandeja «Nuevas». null = no le interesa (p. ej. «revisa tú»). */
export function agentEventFor(reason: TaskInboxReason, issue: IssueDTO): AgentTaskEventType | null {
  if (reason === 'ticket') return 'task.created';
  if (reason === 'assigned') return 'task.assigned';
  if (reason === 'reviewed') return issue.review === 'changes' ? 'task.changes_requested' : issue.review === 'approved' ? 'task.approved' : issue.review === 'deploy' ? 'task.deploy_approved' : issue.review === 'human' ? 'task.needs_human' : null;
  return null;
}

/** Ids de los agentes con webhook activo dentro de `userIds`. */
export async function agentsWithWebhook(c: Tx, userIds: string[]): Promise<string[]> {
  if (!userIds.length) return [];
  const { rows } = await c.query(
    `SELECT u.id FROM users u JOIN agent_webhooks aw ON aw.agent_user_id = u.id AND aw.revoked_at IS NULL
      WHERE u.id = ANY($1::uuid[]) AND u.kind = 'agent' AND u.disabled_at IS NULL`,
    [userIds],
  );
  return rows.map((r) => r.id as string);
}

export async function queueAgentTaskEvent(c: Tx, agentId: string, issue: IssueDTO, actorId: string, type: AgentTaskEventType, extra: { note?: string; comment?: string; attachmentIds?: string[] } = {}) {
  if (!issue.conversationId || agentId === actorId) return;
  if (!(await agentsWithWebhook(c, [agentId])).length) return;
  const { rows } = await c.query(
    `SELECT a.name AS agent_name, u.name AS actor_name, cv.kind AS conv_kind, cv.name AS conv_name,
            -- Los bots de integración (p. ej. el portal que abre los tickets) sí avisan; otro agente miembro no.
            (u.kind = 'agent' AND NOT EXISTS (SELECT 1 FROM integrations ig WHERE ig.bot_user_id = u.id)) AS actor_is_agent
       FROM users a JOIN users u ON u.id = $2 JOIN conversations cv ON cv.id = $3 WHERE a.id = $1`,
    [agentId, actorId, issue.conversationId],
  );
  const r = rows[0];
  if (!r || r.actor_is_agent) return;
  if (!await botCanRead(c, agentId, issue.conversationId)) return;
  // Capturas o archivos que vienen con el comentario o la corrección («mira esto, quedó mal»): get_task trae sus URL.
  const files = extra.attachmentIds?.length
    ? (await c.query('SELECT id, name, content_type, size_bytes FROM attachments WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [extra.attachmentIds])).rows
      .map((a) => ({ id: a.id as string, name: a.name as string, contentType: a.content_type as string, sizeBytes: Number(a.size_bytes) }))
    : [];
  const event = {
    id: randomUUID(), type, createdAt: new Date().toISOString(),
    agent: { id: agentId, name: r.agent_name },
    conversation: { id: issue.conversationId, kind: r.conv_kind, name: r.conv_kind === 'direct' ? null : r.conv_name },
    actor: { id: actorId, name: r.actor_name },
    task: {
      id: issue.id, title: issue.title, status: issue.status, review: issue.review ?? null,
      assigneeIds: issue.assigneeIds ?? (issue.ownerId ? [issue.ownerId] : []), requestedBy: issue.requestedBy,
      externalId: issue.externalId ?? null, externalMeta: issue.externalMeta ?? null, url: issueUrl(issue.id),
    },
    ...(extra.note ? { note: extra.note } : {}),
    ...(extra.comment ? { comment: { body: extra.comment } } : {}),
    ...(files.length ? { attachments: files } : {}),
    // Cómo trabajar la tarjeta por el MCP con el token del agente.
    tools: {
      read: { tool: 'get_task', arguments: { id: issue.id } },
      take: { tool: 'update_task', arguments: { id: issue.id, status: 'in_progress', assignees: [agentId] } },
      evidence: { tool: 'upload_task_attachment', arguments: { id: issue.id } },
      comment: { tool: 'comment_task', arguments: { id: issue.id, attachment_ids: ['<ids de upload_task_attachment>'] } },
      requestReview: { tool: 'update_task', arguments: { id: issue.id, review: 'pending', assignees: ['<persona que revisa>'] } },
    },
  };
  await c.query('INSERT INTO agent_deliveries (id, agent_user_id, conversation_id, event_type, payload) VALUES ($1,$2,$3,$4,$5)',
    [event.id, agentId, issue.conversationId, type, JSON.stringify(event)]);
  await c.query("INSERT INTO jobs (kind, payload, max_attempts) VALUES ('agent.deliver', $1, $2)", [JSON.stringify({ deliveryId: event.id }), MAX_ATTEMPTS]);
}
