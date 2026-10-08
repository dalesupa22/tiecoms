import type { z } from 'zod';
import { AddMembersInput, ISSUE_FIELDS_MAX, type IssueReview, type TaskInboxItemDTO, type TaskInboxReason, type TaskColumnDTO, type TaskColumnsInput, type CreateIssueInput, type IssueDTO, type IssueFieldValue, type IssueEventDTO, type IssueVisibility, type UpdateIssueInput } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { audit, enqueueOutbox, pool, tx, type Db, type Tx } from '../db.ts';
import { ApiError, badRequest, forbidden, notFound, taskNotFound } from '../errors.ts';
import { addMembers, createSideConversation } from './workspaces.ts';
import { appendEvent, appendMessage, toMessageDTO } from './messages.ts';
import { queueIntegrationEvent } from './integration-events.ts';
import { bumpCommentNotice } from './chat-notices.ts';
import { viewOnceConflict } from '../errors.ts';
import { normalizeAssignees } from './issue-assignees.ts';
import { issuePage } from './issue-pagination.ts';
import { agentEventFor, agentsWithWebhook, queueAgentTaskEvent } from './agent-tasks.ts';

/** Mensaje de sistema estructurado: cada cliente lo muestra en su idioma. */
const sys = (k: string, p: Record<string, unknown> = {}) => JSON.stringify({ k, ...p });
const CLOSED = new Set(['done', 'cancelled']);
// Integrations compose the whole import/comment and its replay receipt in one transaction.
const inTransaction = <T>(existing: Tx | undefined, run: (c: Tx) => Promise<T>) => existing ? run(existing) : tx(run);

const SELECT = `
  SELECT i.*, m.seq AS origin_seq,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'contentType', a.content_type, 'sizeBytes', a.size_bytes, 'width', a.width, 'height', a.height, 'url', '/api/v1/attachments/' || a.id, 'thumbUrl', CASE WHEN a.thumb_key IS NOT NULL THEN '/api/v1/attachments/' || a.id || '/thumb' ELSE NULL END) ORDER BY a.position, a.created_at) FROM attachments a WHERE a.issue_id = i.id AND a.deleted_at IS NULL), '[]'::jsonb) AS task_attachments,
         (SELECT count(*) FROM issue_events e WHERE e.issue_id = i.id AND e.kind = 'comment')::int AS comment_count,
         CASE WHEN i.visibility = 'all' THEN NULL ELSE (SELECT array_agg(v.user_id ORDER BY v.added_at) FROM issue_viewers v WHERE v.issue_id = i.id) END AS viewer_ids
    FROM issues i LEFT JOIN messages m ON m.id = i.origin_message_id`;

/**
 * Quién ve un asunto (persona = $1). Asuntos de todo el chat: quien puede leer la conversación.
 * 'org': las personas de esa empresa que están en la conversación. En ambos restringidos, también
 * issue_viewers (quien la creó, el responsable y los agregados), aunque no estén en el chat.
 */
const VISIBLE = `
  LEFT JOIN conversation_memberships vcm ON vcm.conversation_id = i.conversation_id AND vcm.user_id = $1 AND vcm.removed_at IS NULL
  LEFT JOIN workspace_memberships vwm ON vwm.workspace_id = i.workspace_id AND vwm.user_id = $1
  LEFT JOIN conversations vcv ON vcv.id = i.conversation_id
  WHERE (
    -- Personal: sin conversación, solo su dueño.
    (i.conversation_id IS NULL AND i.created_by = $1)
    OR (i.conversation_id IS NOT NULL AND vcv.archived_at IS NULL AND (
      (vcm.user_id IS NOT NULL
        AND (i.workspace_id IS NULL OR (vwm.user_id IS NOT NULL AND vwm.revoked_at IS NULL AND (vwm.expires_at IS NULL OR vwm.expires_at > now())))
        AND (i.visibility = 'all'
          OR (i.visibility = 'org' AND EXISTS (SELECT 1 FROM organization_memberships vom WHERE vom.user_id = $1 AND vom.org_id = i.visible_org_id))))
      OR (i.visibility <> 'all' AND EXISTS (SELECT 1 FROM issue_viewers vv WHERE vv.issue_id = i.id AND vv.user_id = $1))
    ))
  )`;

const iso = (d: any) => (d ? new Date(d).toISOString() : null);

type Fields = Record<string, IssueFieldValue>;
/**
 * Campos dinámicos: los nuevos se mezclan con los actuales, `null` borra y un texto vacío también.
 * Devuelve null si no queda ninguno.
 */
export function mergeFields(cur: Fields | null | undefined, patch: Record<string, IssueFieldValue | null> | undefined): Fields | null {
  const out: Fields = { ...(cur ?? {}) };
  for (const [rawKey, v] of Object.entries(patch ?? {})) {
    const k = rawKey.trim();
    if (!k) continue;
    if (v === null || (typeof v === 'string' && !v.trim())) delete out[k];
    else out[k] = typeof v === 'string' ? v.trim() : v;
  }
  if (Object.keys(out).length > ISSUE_FIELDS_MAX) throw badRequest(`Máximo ${ISSUE_FIELDS_MAX} campos por tarea`);
  return Object.keys(out).length ? out : null;
}

function toDTO(r: any): IssueDTO {
  return {
    id: r.id, workspaceId: r.workspace_id, conversationId: r.conversation_id,
    originMessageId: r.origin_message_id, originMessageSeq: r.origin_seq ?? null,
    title: r.title, status: r.status, waitingOnOrgId: r.waiting_on_org_id, ownerId: r.owner_id, assigneeIds: r.assignee_ids?.length ? r.assignee_ids : r.owner_id ? [r.owner_id] : [], attachments: r.task_attachments ?? [], requestedBy: r.requested_by,
    dueDate: r.due_date ? (typeof r.due_date === 'string' ? r.due_date : new Date(r.due_date).toISOString().slice(0, 10)) : null,
    createdBy: r.created_by, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, statusSince: iso(r.status_since)!,
    closedAt: iso(r.closed_at), commentCount: r.comment_count ?? 0,
    parentIssueId: r.parent_issue_id ?? null, topicId: r.topic_id ?? null, visibility: r.visibility ?? 'all', visibleOrgId: r.visible_org_id ?? null,
    ...(r.visibility && r.visibility !== 'all' ? { viewerIds: r.viewer_ids ?? [] } : {}),
    ...(r.integration_id ? { integrationId: r.integration_id, externalId: r.external_id ?? null, externalMeta: r.external_meta ?? null } : {}),
    ...(r.fields && Object.keys(r.fields).length ? { fields: r.fields } : {}),
    ...(r.review ? { review: r.review, reviewBy: r.review_by ?? null, reviewAt: iso(r.review_at) } : {}),
    ...(r.claimed_by && r.claimed_until && new Date(r.claimed_until).getTime() > Date.now() ? { claimedBy: r.claimed_by, claimedUntil: iso(r.claimed_until) } : {}),
  };
}

async function load(db: Db, id: string): Promise<IssueDTO> {
  const { rows } = await db.query(`${SELECT} WHERE i.id = $1`, [id]);
  if (!rows[0]) throw taskNotFound();
  return toDTO(rows[0]);
}

/** El asunto, solo si esta persona lo puede ver (si no, «no encontrado»: no se confirma que exista). */
export async function loadVisible(db: Db, userId: string, id: string): Promise<IssueDTO> {
  const { rows } = await db.query(`${SELECT} ${VISIBLE} AND i.id = $2`, [userId, id]);
  if (!rows[0]) throw taskNotFound();
  return toDTO(rows[0]);
}

/** Todas las personas que hoy ven el asunto (para avisarles en vivo de un asunto restringido). */
async function audience(c: Db, issueId: string): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT cm.user_id FROM issues i JOIN conversation_memberships cm ON cm.conversation_id = i.conversation_id AND cm.removed_at IS NULL
      WHERE i.id = $1 AND (i.visibility = 'all'
        OR (i.visibility = 'org' AND EXISTS (SELECT 1 FROM organization_memberships om WHERE om.user_id = cm.user_id AND om.org_id = i.visible_org_id)))
     UNION SELECT v.user_id FROM issue_viewers v JOIN issues i ON i.id = v.issue_id WHERE v.issue_id = $1 AND i.visibility <> 'all'`,
    [issueId],
  );
  return rows.map((r) => r.user_id);
}

/** El responsable de un asunto de todo el chat debe poder leer la conversación: si no, se le volvería invisible. */
async function assertMember(c: Tx, conversationId: string, userId: string) {
  const { rowCount } = await c.query('SELECT 1 FROM conversation_memberships WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL', [conversationId, userId]);
  if (!rowCount) throw badRequest('El responsable debe participar en la conversación de la tarea');
}

/**
 * En un asunto restringido, el responsable o un agregado puede estar fuera del chat (un tercero de otra
 * empresa), pero debe ser un contacto: comparte empresa o alguna conversación con quien lo agrega.
 */
async function assertContact(c: Tx, actorId: string, userId: string) {
  if (actorId === userId) return;
  const { rowCount } = await c.query(
    `SELECT 1 FROM users u WHERE u.id = $2 AND u.disabled_at IS NULL AND (
       EXISTS (SELECT 1 FROM organization_memberships a JOIN organization_memberships b ON b.org_id = a.org_id WHERE a.user_id = $1 AND b.user_id = $2)
       OR EXISTS (SELECT 1 FROM conversation_memberships a JOIN conversation_memberships b ON b.conversation_id = a.conversation_id
                   WHERE a.user_id = $1 AND b.user_id = $2 AND a.removed_at IS NULL AND b.removed_at IS NULL))`,
    [actorId, userId],
  );
  if (!rowCount) throw badRequest('Solo puedes asignar o compartir con personas con las que ya trabajas');
}

/** «Esperando a»: una empresa del espacio o, en directos y chats grupales, la de algún participante. */
async function assertWaitingOrg(c: Tx, issue: { workspace_id: string | null; conversation_id: string }, orgId: string) {
  const { rowCount } = issue.workspace_id
    ? await c.query('SELECT 1 FROM workspace_organizations WHERE workspace_id = $1 AND org_id = $2 AND left_at IS NULL', [issue.workspace_id, orgId])
    : await c.query(
      `SELECT 1 FROM conversation_memberships cm JOIN organization_memberships om ON om.user_id = cm.user_id
        WHERE cm.conversation_id = $1 AND cm.removed_at IS NULL AND om.org_id = $2 LIMIT 1`, [issue.conversation_id, orgId]);
  if (!rowCount) throw badRequest('Solo puedes esperar a una empresa que participa en la conversación');
}

async function addViewers(c: Tx, issueId: string, actorId: string, ids: string[]) {
  for (const uid of new Set(ids)) {
    await c.query('INSERT INTO issue_viewers (issue_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [issueId, uid, actorId]);
  }
}

/**
 * En vivo: un asunto de todo el chat viaja por la conversación (como siempre). Uno restringido va solo
 * a quienes lo ven, por su cuenta; y quien perdió acceso recibe issue.hidden.
 */
async function publish(c: Tx, issue: IssueDTO, before: { visibility: IssueVisibility; audience: string[] } | null = null) {
  // Personal: solo a su dueño y con un tipo propio (las apps anteriores no esperan conversationId null).
  if (!issue.conversationId) {
    await enqueueOutbox(c, 'account.event', { userIds: [issue.createdBy], event: { type: 'issue.personal', issue } });
    return;
  }
  if (issue.visibility === 'all' && (!before || before.visibility === 'all')) {
    await appendEvent(c, issue.conversationId, { type: 'issue.updated', conversationId: issue.conversationId, issue });
    return;
  }
  const now = await audience(c, issue.id);
  if (issue.visibility === 'all') await appendEvent(c, issue.conversationId, { type: 'issue.updated', conversationId: issue.conversationId, issue });
  else if (now.length) await enqueueOutbox(c, 'account.event', { userIds: now, event: { type: 'issue.updated', issue } });
  const lost = (before?.audience ?? []).filter((u) => !now.includes(u));
  if (lost.length) await enqueueOutbox(c, 'account.event', { userIds: lost, event: { type: 'issue.hidden', issueId: issue.id, conversationId: issue.conversationId } });
}

async function queueAssignedPush(c: Tx, issueId: string, ownerId: string | null, actorId: string) {
  await notifyInbox(c, issueId, ownerId, actorId, 'assigned');
}

/**
 * Bandeja «Nuevas» (llamada con Lorena, 7-oct): las tareas que llegan quedan marcadas hasta que la persona las ve,
 * con push y aviso en vivo. Solo si la persona ve la tarea; nunca a quien hizo el cambio.
 */
export async function notifyInbox(c: Tx, issueId: string, userId: string | null, actorId: string, reason: TaskInboxReason, note?: string, attachmentIds?: string[]) {
  if (!userId || userId === actorId) return;
  let issue: IssueDTO;
  try { issue = await loadVisible(c, userId, issueId); } catch { return; }
  const { rows } = await c.query(
    `INSERT INTO issue_inbox (user_id, issue_id, reason, actor_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, issue_id) DO UPDATE SET reason = EXCLUDED.reason, actor_id = EXCLUDED.actor_id, created_at = now(), seen_at = NULL
     RETURNING created_at`,
    [userId, issueId, reason, actorId],
  );
  const item: TaskInboxItemDTO = { issueId, reason, actorId, at: iso(rows[0].created_at)! };
  await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'issue.inbox', item, issue } });
  // Un agente con webhook no tiene push: se le avisa al instante para que tome o retome la tarjeta.
  if ((await agentsWithWebhook(c, [userId])).length) {
    const type = agentEventFor(reason, issue);
    if (type) await queueAgentTaskEvent(c, userId, issue, actorId, type, { ...(note ? { note } : {}), attachmentIds });
    return;
  }
  await c.query("INSERT INTO jobs (kind, payload, max_attempts) VALUES ('push.issue', $1, 2)", [JSON.stringify({ issueId, ownerId: userId, actorId, reason })]);
}

/** Lo que llegó y no he visto, de tareas que sigo viendo (más nuevas primero). */
export async function listInbox(userId: string): Promise<{ items: TaskInboxItemDTO[] }> {
  const { rows } = await pool.query(
    `SELECT b.issue_id, b.reason, b.actor_id, b.created_at FROM issue_inbox b
      WHERE b.user_id = $1 AND b.seen_at IS NULL AND b.issue_id IN (SELECT i.id FROM issues i ${VISIBLE})
      ORDER BY b.created_at DESC LIMIT 200`,
    [userId],
  );
  return { items: rows.map((r) => ({ issueId: r.issue_id, reason: r.reason, actorId: r.actor_id, at: iso(r.created_at)! })) };
}

/** Marcar vistas (unas o todas); los demás dispositivos de la persona se enteran. */
export async function markInboxSeen(userId: string, issueIds?: string[]) {
  await tx(async (c) => {
    const r = issueIds
      ? await c.query('UPDATE issue_inbox SET seen_at = now() WHERE user_id = $1 AND seen_at IS NULL AND issue_id = ANY($2)', [userId, issueIds])
      : await c.query('UPDATE issue_inbox SET seen_at = now() WHERE user_id = $1 AND seen_at IS NULL', [userId]);
    if (r.rowCount) await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'issue.inbox_seen', issueIds: issueIds ?? null } });
  });
  return { ok: true };
}

/** Solo adjuntos propios pendientes o ya vinculados a esta tarea; nunca archivos de otro asunto. */
async function setTaskAttachments(c: Tx, actorId: string, issueId: string, conversationId: string | null, ids: string[]) {
  const unique = [...new Set(ids)];
  const { rows } = await c.query(`SELECT * FROM attachments WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL FOR UPDATE`, [unique]);
  if (rows.length !== unique.length || rows.some((a) => a.message_id || (a.issue_id ? a.issue_id !== issueId : a.owner_id !== actorId || a.conversation_id !== conversationId))) {
    throw badRequest('Algún archivo no es tuyo, ya se usó o pertenece a otra tarea');
  }
  await c.query('UPDATE attachments SET deleted_at = now() WHERE issue_id = $1 AND NOT (id = ANY($2::uuid[])) AND deleted_at IS NULL', [issueId, unique]);
  for (let n = 0; n < unique.length; n++) await c.query('UPDATE attachments SET issue_id = $2, position = $3 WHERE id = $1', [unique[n], issueId, n]);
}

/** La empresa de quien crea un asunto «solo mi empresa»: su empresa principal. */
async function actorOrg(c: Tx, userId: string): Promise<string | null> {
  const { rows } = await c.query('SELECT primary_org_id FROM users WHERE id = $1', [userId]);
  return rows[0]?.primary_org_id ?? null;
}

export async function createIssue(userId: string, conversationId: string, input: z.infer<typeof CreateIssueInput>, existing?: Tx) {
  return inTransaction(existing, async (c) => {
    const a = await conversationAccess(c, userId, conversationId, 'post', true);
    // Los terceros invitados participan en los asuntos (comentan, cambian estado, pueden ser responsables) pero no los abren.
    if (a.workspaceRole === 'guest') throw forbidden('Las personas invitadas de fuera participan en las tareas, pero no pueden crearlas');
    let parentId: string | null = null;
    if (input.parentIssueId) {
      // Una tarea hija nace en la conversación del asunto o en un sidechat que salió de ella. Un solo nivel.
      const parent = await loadVisible(c, userId, input.parentIssueId);
      if (!parent.conversationId) throw badRequest('Las tareas personales no tienen subtareas');
      if (parent.parentIssueId) throw badRequest('Las subtareas no tienen subtareas: créala en la tarea principal');
      const conv = (await c.query('SELECT parent_conversation_id FROM conversations WHERE id = $1', [conversationId])).rows[0];
      if (parent.conversationId !== conversationId && conv?.parent_conversation_id !== parent.conversationId) {
        throw badRequest('La subtarea debe crearse en el chat de la tarea o en un sidechat que salió de él');
      }
      parentId = parent.id;
    }
    let requestedBy: string | null = null;
    let topicId: string | null = input.topicId ?? null;
    if (input.originMessageId) {
      const m = await c.query('SELECT author_id, seq, topic_id, view_once FROM messages WHERE id = $1 AND conversation_id = $2', [input.originMessageId, conversationId]);
      if (!m.rows[0] || m.rows[0].seq <= a.historyFromSeq) throw badRequest('El mensaje de origen no está en esta conversación');
      if (m.rows[0].view_once) throw viewOnceConflict();
      requestedBy = m.rows[0].author_id;
      // La tarea que sale de un mensaje con tema hereda su tema (docs/TEMAS.md).
      if (input.topicId === undefined && m.rows[0].topic_id) topicId = m.rows[0].topic_id;
    }
    if (topicId) await assertTopic(c, conversationId, topicId);
    const visibility: IssueVisibility = input.visibility ?? 'all';
    let visibleOrg: string | null = null;
    if (visibility === 'org') {
      visibleOrg = await actorOrg(c, userId);
      if (!visibleOrg) throw badRequest('No tienes empresa: usa «Privada»');
    }
    const assignees = normalizeAssignees(input, [userId]);
    const owner = assignees[0] ?? null;
    for (const uid of assignees) { if (visibility === 'all') await assertMember(c, conversationId, uid); else await assertContact(c, userId, uid); }
    for (const v of input.viewerIds ?? []) await assertContact(c, userId, v);
    const { rows } = await c.query(
      `INSERT INTO issues (workspace_id, conversation_id, origin_message_id, title, owner_id, requested_by, due_date, created_by, parent_issue_id, visibility, visible_org_id, topic_id, assignee_ids, fields)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [a.workspaceId, conversationId, input.originMessageId ?? null, input.title, owner, requestedBy, input.dueDate ?? null, userId, parentId, visibility, visibleOrg, topicId, assignees, fieldsJson(mergeFields(null, applyColumns(await loadColumns(c, conversationId), input.fields)))],
    );
    const id: string = rows[0].id;
    if (input.attachmentIds) await setTaskAttachments(c, userId, id, conversationId, input.attachmentIds);
    if (visibility !== 'all') await addViewers(c, id, userId, [userId, ...assignees, ...(input.viewerIds ?? [])]);
    await c.query("INSERT INTO issue_events (issue_id, actor_id, kind, payload) VALUES ($1,$2,'created',$3)", [id, userId, JSON.stringify({ title: input.title, ownerId: owner, parentIssueId: parentId, visibility })]);
    // Solo lo que ve todo el chat se anuncia en el chat.
    if (visibility === 'all') await appendMessage(c, { conversationId, authorId: userId, kind: 'system', topicId, body: sys('issue.created', { title: input.title, issueId: id, ...(parentId ? { parentIssueId: parentId } : {}) }) });
    const dto = await load(c, id);
    await publish(c, dto);
    for (const uid of assignees) await queueAssignedPush(c, id, uid, userId);
    await audit(c, userId, 'issue.created', { type: 'issue', id, workspaceId: a.workspaceId }, { visibility, child: !!parentId });
    return dto;
  });
}

/** Asunto personal: sin conversación, privado para quien lo crea (y solo él puede ser responsable). */
export async function createPersonalIssue(userId: string, input: { title: string; dueDate?: string | null }) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO issues (workspace_id, conversation_id, title, owner_id, due_date, created_by, visibility, assignee_ids)
       VALUES (NULL, NULL, $1, $2, $3, $2, 'private', ARRAY[$2::uuid]) RETURNING id`,
      [input.title, userId, input.dueDate ?? null],
    );
    const id: string = rows[0].id;
    await addViewers(c, id, userId, [userId]);
    await c.query("INSERT INTO issue_events (issue_id, actor_id, kind, payload) VALUES ($1,$2,'created',$3)", [id, userId, JSON.stringify({ title: input.title, personal: true })]);
    const dto = await load(c, id);
    await publish(c, dto);
    await audit(c, userId, 'issue.created', { type: 'issue', id }, { personal: true });
    return dto;
  });
}

/** Tarea hija. Sin conversationId, en la conversación del asunto; con él, en un sidechat que salió de ella. */
export async function createChildIssue(userId: string, parentId: string, input: z.infer<typeof CreateIssueInput> & { conversationId?: string }) {
  const parent = await loadVisible(pool, userId, parentId);
  if (!parent.conversationId) throw badRequest('Las tareas personales no tienen subtareas');
  return createIssue(userId, input.conversationId ?? parent.conversationId, { ...input, parentIssueId: parentId });
}

/**
 * Puede editar quien ve el asunto. En los de todo el chat, además, debe poder escribir en él (como antes).
 * La visibilidad solo la cambia quien lo creó.
 */
export async function updateIssue(userId: string, issueId: string, input: z.infer<typeof UpdateIssueInput>, existing?: Tx) {
  return inTransaction(existing, async (c) => {
    const { rows } = await c.query('SELECT * FROM issues WHERE id = $1 FOR UPDATE', [issueId]);
    const cur = rows[0];
    if (!cur) throw taskNotFound();
    await loadVisible(c, userId, issueId);
    if (cur.visibility === 'all') await conversationAccess(c, userId, cur.conversation_id, 'post', true);
    if (!cur.conversation_id) {
      // Un asunto personal sigue siendo personal: no se reasigna, no se comparte ni espera a una empresa.
      if (input.assigneeIds?.some((id) => id !== userId)) throw badRequest('Una tarea personal solo es tuya');
      if (input.conversationId) throw badRequest('Una tarea personal no se comparte: crea otra en el chat');
      if (input.ownerId !== undefined && input.ownerId !== userId && input.ownerId !== null) throw badRequest('Una tarea personal solo es tuya');
      if (input.visibility !== undefined && input.visibility !== 'private') throw badRequest('Una tarea personal no se comparte');
      if (input.viewerIds?.length) throw badRequest('Una tarea personal no se comparte');
      if (input.waitingOnOrgId) throw badRequest('Una tarea personal no espera a una empresa');
    }
    const moving = !!input.conversationId && input.conversationId !== cur.conversation_id;
    const oldConversationId = cur.conversation_id;
    const oldAudience = moving ? await audience(c, issueId) : [];
    let destination = cur.conversation_id;
    let destinationWorkspace = cur.workspace_id;
    if (moving) {
      if (cur.created_by !== userId) throw forbidden('Solo quien creó la tarea puede moverla');
      const a = await conversationAccess(c, userId, input.conversationId!, 'post', true);
      if (a.workspaceRole === 'guest') throw forbidden('No puedes mover una tarea a un chat donde eres invitado');
      if ((await c.query('SELECT 1 FROM issues WHERE parent_issue_id = $1 LIMIT 1', [issueId])).rowCount) throw badRequest('Mueve primero las subtareas de este asunto');
      destination = input.conversationId!; destinationWorkspace = a.workspaceId;
    }
    const nextVis: IssueVisibility = input.visibility ?? cur.visibility;
    if (input.visibility !== undefined && input.visibility !== cur.visibility && cur.created_by !== userId) throw forbidden('Solo quien creó la tarea cambia quién lo ve');
    const before = cur.visibility !== 'all' || nextVis !== 'all' ? { visibility: cur.visibility as IssueVisibility, audience: await audience(c, issueId) } : null;
    const sets: string[] = ['updated_at = now()'];
    const vals: unknown[] = [issueId];
    const events: [string, object][] = [];
    const positions = new Map<string, number>();
    const add = (col: string, v: unknown) => { const existing = positions.get(col); if (existing !== undefined) { vals[existing - 1] = v; return; } vals.push(v); positions.set(col, vals.length); sets.push(`${col} = $${vals.length}`); };
    if (input.title !== undefined && input.title !== cur.title) { add('title', input.title); events.push(['title', { from: cur.title, to: input.title }]); }
    if (input.visibility !== undefined && input.visibility !== cur.visibility) {
      add('visibility', input.visibility);
      const org = input.visibility === 'org' ? await actorOrg(c, userId) : null;
      if (input.visibility === 'org' && !org) throw badRequest('No tienes empresa: usa «Privada»');
      add('visible_org_id', org);
      events.push(['visibility', { from: cur.visibility, to: input.visibility }]);
      if (input.visibility !== 'all') await addViewers(c, issueId, userId, [cur.created_by, ...(cur.owner_id ? [cur.owner_id] : [])]);
    }
    const previousAssignees: string[] = cur.assignee_ids?.length ? cur.assignee_ids : cur.owner_id ? [cur.owner_id] : [];
    // «Devolver» (llamada con Lorena 7-oct): pedir corrección le regresa la tarjeta a quien la dejó por revisar
    // (el agente o la persona que la resolvió), salvo que en el mismo cambio se elijan otros responsables.
    if (input.review === 'changes' && cur.review !== 'changes' && input.assigneeIds === undefined && input.ownerId === undefined
      && cur.review_requested_by && cur.review_requested_by !== userId) {
      input = { ...input, assigneeIds: [cur.review_requested_by] };
    }
    const assignees = normalizeAssignees(input, previousAssignees);
    const owner = assignees[0] ?? null;
    // Una transición a todo el chat también valida responsables antiguos para no dejarlos invisibles.
    if (input.assigneeIds !== undefined || input.ownerId !== undefined || moving || (nextVis === 'all' && cur.visibility !== 'all')) {
      for (const uid of assignees) { if (nextVis === 'all') await assertMember(c, destination, uid); else await assertContact(c, userId, uid); }
    }
    if (JSON.stringify(assignees) !== JSON.stringify(previousAssignees)) {
      add('assignee_ids', assignees); add('owner_id', owner);
      if (owner !== cur.owner_id) events.push(['owner', { from: cur.owner_id, to: owner }]);
      events.push(['assignees', { from: previousAssignees, to: assignees }]);
    }
    if (nextVis !== 'all') {
      for (const v of input.viewerIds ?? []) await assertContact(c, userId, v);
      await addViewers(c, issueId, userId, [...assignees, ...(input.viewerIds ?? [])]);
    }
    if (moving) {
      add('conversation_id', destination); add('workspace_id', destinationWorkspace);
      add('topic_id', null); add('origin_message_id', null); add('waiting_on_org_id', null);
      if (cur.parent_issue_id) {
        const parent = (await c.query('SELECT conversation_id FROM issues WHERE id = $1', [cur.parent_issue_id])).rows[0];
        const to = (await c.query('SELECT parent_conversation_id FROM conversations WHERE id = $1', [destination])).rows[0];
        if (parent?.conversation_id !== destination && to?.parent_conversation_id !== parent?.conversation_id) add('parent_issue_id', null);
      }
      events.push(['moved', { from: oldConversationId, to: destination }]);
    }
    if (input.attachmentIds !== undefined) {
      await setTaskAttachments(c, userId, issueId, moving ? oldConversationId : destination, input.attachmentIds);
      events.push(['attachments', { count: [...new Set(input.attachmentIds)].length }]);
    }
    if (input.dueDate !== undefined) {
      const prev = cur.due_date ? new Date(cur.due_date).toISOString().slice(0, 10) : null;
      if (input.dueDate !== prev) { add('due_date', input.dueDate); events.push(['due', { from: prev, to: input.dueDate }]); }
    }
    if (input.waitingOnOrgId !== undefined && input.waitingOnOrgId !== cur.waiting_on_org_id) {
      if (input.waitingOnOrgId) await assertWaitingOrg(c, { workspace_id: destinationWorkspace, conversation_id: destination }, input.waitingOnOrgId);
      add('waiting_on_org_id', input.waitingOnOrgId); events.push(['waiting', { to: input.waitingOnOrgId }]);
    }
    if (input.status !== undefined && input.status !== cur.status) {
      add('status', input.status);
      sets.push('status_since = now()');
      sets.push(CLOSED.has(input.status) ? 'closed_at = now(), claimed_by = NULL, claimed_until = NULL' : 'closed_at = NULL');
      if (input.status !== 'waiting') add('waiting_on_org_id', null);
      events.push(['status', { from: cur.status, to: input.status }]);
    }
    if (input.fields !== undefined) {
      const next = mergeFields(cur.fields, applyColumns(await loadColumns(c, destination), input.fields));
      if (JSON.stringify(next) !== JSON.stringify(cur.fields ?? null)) {
        add('fields', fieldsJson(next));
        const before = (cur.fields ?? {}) as Fields;
        const changed = Object.keys(next ?? {}).filter((k) => before[k] !== next![k]);
        const removed = Object.keys(before).filter((k) => !next || !(k in next));
        events.push(['fields', { changed, removed }]);
      }
    }
    // Revisión humana: quien la deja «por revisar» recibe la decisión; los responsables, el pedido de revisión.
    const prevReview: IssueReview | null = cur.review ?? null;
    const reviewChanged = input.review !== undefined && input.review !== prevReview;
    if (reviewChanged) {
      add('review', input.review); add('review_by', input.review ? userId : null);
      sets.push(input.review ? 'review_at = now()' : 'review_at = NULL');
      if (input.review === 'pending') add('review_requested_by', userId);
      // Dejarla por revisar termina el trabajo de quien la tenía tomada.
      if (input.review === 'pending' || input.review === 'approved') sets.push('claimed_by = NULL, claimed_until = NULL');
      events.push(['review', { from: prevReview, to: input.review, ...(input.reviewNote ? { note: input.reviewNote } : {}) }]);
    }
    if (input.reviewNote && !reviewChanged) throw badRequest('reviewNote va con un cambio de revisión');
    if (input.reviewAttachmentIds?.length && !input.reviewNote) throw badRequest('Los archivos de la revisión van con una nota (reviewNote)');
    let topicChanged = false;
    const currentTopicId = moving ? null : cur.topic_id;
    if (input.topicId !== undefined) {
      if (!cur.conversation_id) throw badRequest('Una tarea personal no lleva tema');
      if (input.topicId) await assertTopic(c, destination, input.topicId);
      if (input.topicId !== currentTopicId) { add('topic_id', input.topicId); topicChanged = true; }
    }
    const topicId = input.topicId !== undefined ? input.topicId : currentTopicId;
    // Re-applying the current topic also repairs historical notices left untagged by older clients.
    const repairedNotices = input.topicId !== undefined ? await syncIssueMessageTopics(c, destination, issueId, topicId, userId) : 0;
    if (!events.length && !topicChanged && !repairedNotices && !(input.viewerIds?.length)) return load(c, issueId);
    await c.query(`UPDATE issues SET ${sets.join(', ')} WHERE id = $1`, vals);
    for (const [kind, payload] of events) {
      await c.query('INSERT INTO issue_events (issue_id, actor_id, kind, payload) VALUES ($1,$2,$3,$4)', [issueId, userId, kind, JSON.stringify(payload)]);
    }
    // Tarea hecha (tanda 1.7): «✅ Ana completó la tarea» con confeti, también en las hijas. Cada cierre publica uno.
    const doneNow = nextVis === 'all' && input.status === 'done' && cur.status !== 'done';
    if (doneNow) {
      const byName = (await c.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]?.name ?? '';
      await appendMessage(c, { conversationId: destination, authorId: userId, kind: 'system', topicId, body: sys('issue.done', { issueId, title: input.title ?? cur.title, byId: userId, byName }) });
    }
    // Cancelar o reabrir se avisa en la conversación (solo si todo el chat ve el asunto y no es una tarea hija).
    else if (nextVis === 'all' && !cur.parent_issue_id && input.status && input.status !== cur.status && (CLOSED.has(input.status) || CLOSED.has(cur.status))) {
      await appendMessage(c, { conversationId: destination, authorId: userId, kind: 'system', topicId, body: sys(CLOSED.has(input.status) ? 'issue.closed' : 'issue.reopened', { title: input.title ?? cur.title, issueId }) });
    }
    const dto = await load(c, issueId);
    if (moving) {
      await c.query('UPDATE attachments SET conversation_id = $2 WHERE issue_id = $1', [issueId, destination]);
      const nextAudience = await audience(c, issueId);
      const lost = oldAudience.filter((uid) => !nextAudience.includes(uid));
      if (lost.length) await enqueueOutbox(c, 'account.event', { userIds: lost, event: { type: 'issue.hidden', issueId, conversationId: oldConversationId } });
      await publish(c, dto);
    } else await publish(c, dto, before);
    // Cambiar solo el tema es interno de Chaggu: no dispara el webhook de la integración.
    if (cur.integration_id && events.some(([k]) => k !== 'review')) {
      if (input.status !== undefined && input.status !== cur.status) await queueIntegrationEvent(c, issueId, userId, { type: 'issue.status_changed', from: cur.status, to: input.status });
      else await queueIntegrationEvent(c, issueId, userId, { type: 'issue.updated' });
    }
    for (const uid of assignees.filter((uid) => !previousAssignees.includes(uid))) await queueAssignedPush(c, issueId, uid, userId);
    if (reviewChanged) {
      const reviewFiles = input.reviewNote ? await bindCommentFiles(c, userId, issueId, destination, input.reviewAttachmentIds) : [];
      if (input.reviewNote) await c.query("INSERT INTO issue_events (issue_id, actor_id, kind, payload) VALUES ($1,$2,'comment',$3)", [issueId, userId, JSON.stringify({ body: input.reviewNote, ...(reviewFiles.length ? { attachmentIds: reviewFiles } : {}) })]);
      if (input.review === 'pending') {
        for (const uid of assignees) await notifyInbox(c, issueId, uid, userId, 'review');
      } else if (input.review) {
        for (const uid of new Set([cur.review_requested_by, cur.created_by].filter(Boolean) as string[])) await notifyInbox(c, issueId, uid, userId, 'reviewed', input.reviewNote, reviewFiles);
      }
      if (cur.integration_id) await queueIntegrationEvent(c, issueId, userId, { type: 'issue.review_changed', from: prevReview, to: input.review ?? null, ...(input.reviewNote ? { note: input.reviewNote } : {}) });
    }
    await audit(c, userId, 'issue.updated', { type: 'issue', id: issueId, workspaceId: cur.workspace_id }, { changes: events.map(([k]) => k) });
    return dto;
  });
}

// ---------- Tomar una tarjeta (reserva) ----------

/**
 * Reserva atómica: solo una corrida trabaja la tarjeta. Si otro la tiene con reserva vigente → 409 con quién y hasta
 * cuándo. Tomarla la deja «en curso» y asignada a quien la toma (avisa como cualquier cambio).
 */
export async function claimIssue(userId: string, issueId: string, minutes: number) {
  return tx(async (c) => {
    const cur = await loadVisible(c, userId, issueId);
    if (CLOSED.has(cur.status)) throw badRequest('La tarea ya está cerrada');
    const { rows } = await c.query(
      `UPDATE issues SET claimed_by = $2, claimed_until = now() + make_interval(mins => $3)
        WHERE id = $1 AND (claimed_by IS NULL OR claimed_by = $2 OR claimed_until < now()) RETURNING id`,
      [issueId, userId, minutes],
    );
    if (!rows[0]) {
      const r = (await c.query('SELECT u.name, i.claimed_until FROM issues i JOIN users u ON u.id = i.claimed_by WHERE i.id = $1', [issueId])).rows[0];
      throw new ApiError(409, 'task_claimed', `La está trabajando ${r?.name ?? 'otra corrida'} hasta ${iso(r?.claimed_until) ?? 'pronto'}`);
    }
    const patch: z.infer<typeof UpdateIssueInput> = {};
    if (cur.status !== 'in_progress') patch.status = 'in_progress';
    const who = cur.assigneeIds ?? [];
    if (who.length !== 1 || who[0] !== userId) patch.assigneeIds = [userId];
    const dto = Object.keys(patch).length ? await updateIssue(userId, issueId, patch as any, c) : await load(c, issueId);
    await publish(c, dto);
    return dto;
  });
}

/** Suelta la reserva propia (p. ej. si la corrida falla); la de otro no se toca. */
export async function releaseIssue(userId: string, issueId: string) {
  return tx(async (c) => {
    await loadVisible(c, userId, issueId);
    await c.query('UPDATE issues SET claimed_by = NULL, claimed_until = NULL WHERE id = $1 AND claimed_by = $2', [issueId, userId]);
    const dto = await load(c, issueId);
    await publish(c, dto);
    return dto;
  });
}

/**
 * Chat de la tarea (CH-IA-02): un sidechat ligado a la tarea donde el agente trabaja con las personas. Reutiliza el que
 * ya tenga quien lo pide (y suma a quien falte); si no hay, lo crea con esas personas.
 */
export async function openTaskChat(userId: string, issueId: string, people: string[]) {
  const issue = await loadVisible(pool, userId, issueId);
  if (!issue.conversationId) throw badRequest('Una tarea personal no tiene chat');
  const { rows } = await pool.query(
    `SELECT c.id FROM conversations c JOIN conversation_memberships m ON m.conversation_id = c.id AND m.user_id = $2 AND m.removed_at IS NULL
      WHERE c.side_issue_id = $1 AND c.derive_kind = 'side' AND c.archived_at IS NULL ORDER BY c.created_at LIMIT 1`,
    [issueId, userId],
  );
  if (rows[0]) {
    const have = new Set((await pool.query('SELECT user_id FROM conversation_memberships WHERE conversation_id = $1 AND removed_at IS NULL', [rows[0].id])).rows.map((r) => r.user_id as string));
    const missing = people.filter((p) => !have.has(p) && p !== userId);
    if (missing.length) await addMembers(userId, rows[0].id, AddMembersInput.parse({ userIds: missing, history: 'all' }));
    return { id: rows[0].id as string, created: false };
  }
  const r = await createSideConversation(userId, issue.conversationId, { issueId, userIds: people });
  return { id: r.id, created: true };
}

const fieldsJson = (f: Fields | null) => (f ? JSON.stringify(f) : null);

// ---------- Columnas del grupo (texto, lista desplegable, número, casilla) ----------

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLocaleLowerCase();

async function loadColumns(c: Db, conversationId: string | null): Promise<TaskColumnDTO[]> {
  if (!conversationId) return [];
  const { rows } = await c.query('SELECT task_columns FROM conversations WHERE id = $1', [conversationId]);
  return (rows[0]?.task_columns ?? []) as TaskColumnDTO[];
}

/**
 * Ajusta los valores a las columnas del grupo: una lista desplegable solo acepta sus opciones (sin importar
 * mayúsculas ni tildes, y se guarda la opción tal cual), un número debe ser número y una casilla sí/no.
 * El nombre del campo también se ajusta al de la columna («tipo» → «Tipo»).
 */
export function applyColumns(columns: TaskColumnDTO[], patch: Record<string, IssueFieldValue | null> | undefined) {
  if (!patch || !columns.length) return patch;
  const out: Record<string, IssueFieldValue | null> = {};
  for (const [k, v] of Object.entries(patch)) {
    const col = columns.find((x) => fold(x.name) === fold(k));
    if (!col || v === null || (typeof v === 'string' && !v.trim())) { out[col?.name ?? k] = v; continue; }
    if (col.type === 'select') {
      const opt = col.options?.find((o) => fold(o) === fold(String(v)));
      if (!opt) throw badRequest(`«${String(v)}» no es una opción de ${col.name}. Opciones: ${(col.options ?? []).join(', ')}`);
      out[col.name] = opt;
    } else if (col.type === 'number') {
      const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n)) throw badRequest(`${col.name} debe ser un número`);
      out[col.name] = n;
    } else if (col.type === 'checkbox') {
      out[col.name] = typeof v === 'boolean' ? v : ['si', 'sí', 'true', '1', 'yes', 'x'].includes(fold(String(v)));
    } else out[col.name] = String(v);
  }
  return out;
}

/** Columnas del grupo. Las cambia quien administra el grupo o el espacio. */
export async function getTaskColumns(userId: string, conversationId: string) {
  const a = await conversationAccess(pool, userId, conversationId, 'read');
  return { columns: await loadColumns(pool, conversationId), canEdit: !!a.canManage };
}

export async function setTaskColumns(userId: string, conversationId: string, input: z.infer<typeof TaskColumnsInput>) {
  return tx(async (c) => {
    const a = await conversationAccess(c, userId, conversationId, 'read');
    if (!a.canManage) throw forbidden('Solo quien administra el grupo cambia sus columnas');
    const seen = new Set<string>();
    const columns: TaskColumnDTO[] = [];
    for (const col of input.columns) {
      const key = fold(col.name);
      if (seen.has(key)) throw badRequest(`La columna «${col.name}» está repetida`);
      seen.add(key);
      columns.push({ name: col.name.trim(), type: col.type, ...(col.type === 'select' ? { options: [...new Map((col.options ?? []).map((o) => [fold(o), o.trim()])).values()] } : {}) });
    }
    await c.query('UPDATE conversations SET task_columns = $2 WHERE id = $1', [conversationId, columns.length ? JSON.stringify(columns) : null]);
    await audit(c, userId, 'task_columns.updated', { type: 'conversation', id: conversationId, workspaceId: a.workspaceId }, { columns: columns.map((x) => x.name) });
    return { columns, canEdit: true };
  });
}

/** Solo un tema activo del mismo chat. */
export async function assertTopic(c: Tx, conversationId: string, topicId: string) {
  const { rowCount } = await c.query('SELECT 1 FROM conversation_topics WHERE id = $1 AND conversation_id = $2 AND archived_at IS NULL', [topicId, conversationId]);
  if (!rowCount) throw badRequest('Ese tema no está activo en esta conversación');
}

/** Keep existing task cards and lifecycle notices in the task's current topic on every client. */
async function syncIssueMessageTopics(c: Tx, conversationId: string, issueId: string, topicId: string | null, userId: string) {
  const { rows } = await c.query(
    `SELECT id, body FROM messages WHERE conversation_id=$1 AND kind='system' AND deleted_at IS NULL
       AND body LIKE $2 AND topic_id IS DISTINCT FROM $3::uuid FOR UPDATE`,
    [conversationId, `%${issueId}%`, topicId],
  );
  const kinds = new Set(['issue.created', 'issue.done', 'issue.closed', 'issue.reopened', 'issue.comments', 'issue.overdue']);
  const ids = rows.filter((m) => {
    // System bodies may be legacy plain text or malformed; never cast arbitrary bodies in SQL.
    try { const payload = JSON.parse(m.body); return payload?.issueId === issueId && kinds.has(payload?.k); }
    catch { return false; }
  }).map((m) => m.id as string);
  if (!ids.length) return 0;
  const { rows: updated } = await c.query('UPDATE messages SET topic_id=$2, topic_by=$3 WHERE id=ANY($1::uuid[]) RETURNING *', [ids, topicId, topicId ? userId : null]);
  for (const m of updated) await appendEvent(c, conversationId, { type: 'message.updated', conversationId, message: toMessageDTO(m) }, m.id);
  return updated.length;
}

/** Capturas o archivos de un comentario: quedan como archivos de la tarea (mismo acceso) y el comentario los nombra. */
async function bindCommentFiles(c: Tx, userId: string, issueId: string, conversationId: string | null, attachmentIds?: string[]) {
  const files = attachmentIds?.length ? [...new Set(attachmentIds)] : [];
  if (!files.length) return files;
  const { rows: att } = await c.query('SELECT * FROM attachments WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL FOR UPDATE', [files]);
  if (att.length !== files.length || att.some((a) => a.message_id || (a.issue_id ? a.issue_id !== issueId : a.owner_id !== userId || a.conversation_id !== conversationId))) {
    throw badRequest('Algún archivo no es tuyo, ya se usó o pertenece a otra tarea');
  }
  const count = (await c.query('SELECT count(*)::int AS n FROM attachments WHERE issue_id = $1 AND deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))', [issueId, files])).rows[0].n;
  if (count + files.length > 50) throw badRequest('Máximo 50 archivos por tarea');
  for (let n = 0; n < files.length; n++) await c.query('UPDATE attachments SET issue_id = $2, position = $3 WHERE id = $1 AND issue_id IS DISTINCT FROM $2', [files[n], issueId, count + n]);
  return files;
}

export async function commentIssue(userId: string, issueId: string, body: string, extra: { author?: string; at?: string } = {}, existing?: Tx, attachmentIds?: string[]) {
  return inTransaction(existing, async (c) => {
    const { rows } = await c.query('SELECT conversation_id, topic_id, visibility, integration_id, title, review_requested_by FROM issues WHERE id = $1 FOR UPDATE', [issueId]);
    if (!rows[0]) throw taskNotFound();
    await loadVisible(c, userId, issueId);
    if (rows[0].visibility === 'all') await conversationAccess(c, userId, rows[0].conversation_id, 'post', true);
    // `author`: quién lo escribió fuera de Chaggu (comentarios que trae una integración). Los clientes muestran el cuerpo.
    const files = await bindCommentFiles(c, userId, issueId, rows[0].conversation_id, attachmentIds);
    await c.query("INSERT INTO issue_events (issue_id, actor_id, kind, payload) VALUES ($1,$2,'comment',$3)", [issueId, userId, JSON.stringify({ body, ...extra, ...(files.length ? { attachmentIds: files } : {}) })]);
    await c.query('UPDATE issues SET updated_at = now() WHERE id = $1', [issueId]);
    if (!body && files.length) body = `📎 ${files.length === 1 ? 'Archivo adjunto' : `${files.length} archivos adjuntos`}`;
    if (rows[0].integration_id) await queueIntegrationEvent(c, issueId, userId, { type: 'issue.commented', body });
    // Aviso agrupado en el chat (tanda 1.7): solo lo que ve todo el chat.
    if (rows[0].visibility === 'all' && rows[0].conversation_id) {
      const actorName = extra.author || (await c.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]?.name || '';
      await bumpCommentNotice(c, { kind: 'issue', conversationId: rows[0].conversation_id, topicId: rows[0].topic_id, itemId: issueId, title: rows[0].title, actorId: userId, actorName, body });
    }
    const dto = await load(c, issueId);
    await publish(c, dto);
    // La persona le escribe a la IA sobre la tarea (p. ej. «no me parece, corrige X»): la IA responde en la misma tarea.
    const listeners = await agentsWithWebhook(c, [...new Set([...(dto.assigneeIds ?? []), ...(rows[0].review_requested_by ? [rows[0].review_requested_by] : [])])]);
    for (const agentId of listeners) await queueAgentTaskEvent(c, agentId, dto, userId, 'task.commented', { comment: body, attachmentIds: files });
    return dto;
  });
}

/**
 * Eliminar una tarea (pedido de Lorena 7-oct): quien la creó o quien administra el chat. Se lleva sus subtareas,
 * comentarios y archivos; quienes la veían reciben issue.hidden. Los tickets de una integración no se borran
 * (el sistema externo los volvería a crear): se cancelan.
 */
export async function deleteIssue(userId: string, issueId: string) {
  return tx(async (c) => {
    const cur = (await c.query('SELECT * FROM issues WHERE id = $1 FOR UPDATE', [issueId])).rows[0];
    if (!cur) throw taskNotFound();
    await loadVisible(c, userId, issueId);
    let can = cur.created_by === userId;
    if (!can && cur.conversation_id) {
      // En los grupos de un espacio, quien lo administra; en chats grupales todos pueden administrar, así que solo quien la creó.
      try { const a = await conversationAccess(c, userId, cur.conversation_id, 'read'); can = a.canManage && !!a.workspaceId; } catch { can = false; }
    }
    if (!can) throw forbidden('Solo quien creó la tarea o quien administra el chat puede eliminarla');
    if (cur.integration_id) throw badRequest('Los tickets de la mesa de ayuda no se eliminan: cancélalos');
    const kids = (await c.query('SELECT id, conversation_id FROM issues WHERE parent_issue_id = $1', [issueId])).rows as { id: string; conversation_id: string | null }[];
    const all = [{ id: issueId, conversation_id: cur.conversation_id as string | null }, ...kids];
    const notify: { id: string; conversationId: string; people: string[] }[] = [];
    for (const x of all) notify.push({ id: x.id, conversationId: x.conversation_id ?? '', people: [...new Set([...(await audience(c, x.id)), cur.created_by])] });
    await c.query('DELETE FROM issues WHERE id = $1', [issueId]);
    for (const n of notify) if (n.people.length) await enqueueOutbox(c, 'account.event', { userIds: n.people, event: { type: 'issue.hidden', issueId: n.id, conversationId: n.conversationId } });
    await audit(c, userId, 'issue.deleted', { type: 'issue', id: issueId, workspaceId: cur.workspace_id }, { title: cur.title, children: kids.length });
    return { ok: true, deleted: all.map((x) => x.id) };
  });
}

export async function getIssue(userId: string, issueId: string, db: Db = pool) {
  const issue = await loadVisible(db, userId, issueId);
  const { rows } = await db.query('SELECT * FROM issue_events WHERE issue_id = $1 ORDER BY id', [issueId]);
  const events: IssueEventDTO[] = rows.map((r) => ({ id: r.id, issueId: r.issue_id, actorId: r.actor_id, kind: r.kind, payload: r.payload, createdAt: iso(r.created_at)! }));
  // Las tareas hijas que esta persona ve (en el chat del asunto o en sus sidechats).
  const kids = await db.query(`${SELECT} ${VISIBLE} AND i.parent_issue_id = $2 ORDER BY i.created_at`, [userId, issueId]);
  return { issue, events, children: kids.rows.map(toDTO) };
}

/**
 * Asuntos visibles para la persona: los de conversaciones que puede leer ahora mismo (membresía activa y,
 * si es tercero, dentro de su fecha) según su visibilidad, y los restringidos donde la agregaron.
 */
type IssueFilter = { workspaceId?: string; conversationId?: string; mine?: boolean; open?: boolean; personal?: boolean };

async function queryIssues(userId: string, filter: IssueFilter, limit: number, offset: number, db: Db) {
  const { rows } = await db.query(
    `${SELECT} ${VISIBLE}
        AND ($2::uuid IS NULL OR i.workspace_id = $2) AND ($3::uuid IS NULL OR i.conversation_id = $3)
        AND (NOT $4 OR i.owner_id = $1 OR $1 = ANY(i.assignee_ids)) AND (NOT $5 OR i.status NOT IN ('done','cancelled'))
        AND ($6 OR i.conversation_id IS NOT NULL)
      ORDER BY (i.status IN ('done','cancelled')), i.due_date NULLS LAST, i.created_at DESC, i.id
      LIMIT $7 OFFSET $8`,
    [userId, filter.workspaceId ?? null, filter.conversationId ?? null, !!filter.mine, !!filter.open, filter.personal !== false, limit, offset],
  );
  return rows.map(toDTO);
}

export async function listIssues(userId: string, filter: IssueFilter, db: Db = pool) {
  return queryIssues(userId, filter, 500, 0, db);
}

/** Applies the same visibility predicate before every page, including personal tasks. */
export async function listIssuesPage(userId: string, filter: IssueFilter, page: { limit: number; offset?: number }, db: Db = pool) {
  const offset = page.offset ?? 0;
  return issuePage(await queryIssues(userId, filter, page.limit + 1, offset, db), page.limit, offset);
}

/** Reporte completo de tareas asignadas que puedo ver; independiente del límite de la vista interactiva. */
export async function listIssueReport(userId: string) {
  const { rows } = await pool.query(`${SELECT} ${VISIBLE}
    AND (i.owner_id IS NOT NULL OR cardinality(i.assignee_ids) > 0)
    ORDER BY (i.status IN ('done','cancelled')), i.due_date NULLS LAST, i.created_at DESC`, [userId]);
  return rows.map(toDTO);
}
