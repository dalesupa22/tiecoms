import type { z } from 'zod';
import type { CreateIssueInput, IssueDTO, IssueEventDTO, IssueVisibility, UpdateIssueInput } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { audit, enqueueOutbox, pool, tx, type Db, type Tx } from '../db.ts';
import { badRequest, forbidden, notFound, taskNotFound } from '../errors.ts';
import { appendEvent, appendMessage } from './messages.ts';
import { queueIntegrationEvent } from './integration-events.ts';
import { bumpCommentNotice } from './chat-notices.ts';
import { viewOnceConflict } from '../errors.ts';

/** Mensaje de sistema estructurado: cada cliente lo muestra en su idioma. */
const sys = (k: string, p: Record<string, unknown> = {}) => JSON.stringify({ k, ...p });
const CLOSED = new Set(['done', 'cancelled']);
// Integrations compose the whole import/comment and its replay receipt in one transaction.
const inTransaction = <T>(existing: Tx | undefined, run: (c: Tx) => Promise<T>) => existing ? run(existing) : tx(run);

const SELECT = `
  SELECT i.*, m.seq AS origin_seq,
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
function toDTO(r: any): IssueDTO {
  return {
    id: r.id, workspaceId: r.workspace_id, conversationId: r.conversation_id,
    originMessageId: r.origin_message_id, originMessageSeq: r.origin_seq ?? null,
    title: r.title, status: r.status, waitingOnOrgId: r.waiting_on_org_id, ownerId: r.owner_id, requestedBy: r.requested_by,
    dueDate: r.due_date ? (typeof r.due_date === 'string' ? r.due_date : new Date(r.due_date).toISOString().slice(0, 10)) : null,
    createdBy: r.created_by, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, statusSince: iso(r.status_since)!,
    closedAt: iso(r.closed_at), commentCount: r.comment_count ?? 0,
    parentIssueId: r.parent_issue_id ?? null, topicId: r.topic_id ?? null, visibility: r.visibility ?? 'all', visibleOrgId: r.visible_org_id ?? null,
    ...(r.visibility && r.visibility !== 'all' ? { viewerIds: r.viewer_ids ?? [] } : {}),
    ...(r.integration_id ? { integrationId: r.integration_id, externalId: r.external_id ?? null, externalMeta: r.external_meta ?? null } : {}),
  };
}

async function load(db: Db, id: string): Promise<IssueDTO> {
  const { rows } = await db.query(`${SELECT} WHERE i.id = $1`, [id]);
  if (!rows[0]) throw taskNotFound();
  return toDTO(rows[0]);
}

/** El asunto, solo si esta persona lo puede ver (si no, «no encontrado»: no se confirma que exista). */
async function loadVisible(db: Db, userId: string, id: string): Promise<IssueDTO> {
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
  if (!ownerId || ownerId === actorId) return;
  await c.query("INSERT INTO jobs (kind, payload, max_attempts) VALUES ('push.issue', $1, 2)", [JSON.stringify({ issueId, ownerId, actorId })]);
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
    const owner = input.ownerId === undefined ? userId : input.ownerId;
    if (owner) { if (visibility === 'all') await assertMember(c, conversationId, owner); else await assertContact(c, userId, owner); }
    for (const v of input.viewerIds ?? []) await assertContact(c, userId, v);
    const { rows } = await c.query(
      `INSERT INTO issues (workspace_id, conversation_id, origin_message_id, title, owner_id, requested_by, due_date, created_by, parent_issue_id, visibility, visible_org_id, topic_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [a.workspaceId, conversationId, input.originMessageId ?? null, input.title, owner, requestedBy, input.dueDate ?? null, userId, parentId, visibility, visibleOrg, topicId],
    );
    const id: string = rows[0].id;
    if (visibility !== 'all') await addViewers(c, id, userId, [userId, ...(owner ? [owner] : []), ...(input.viewerIds ?? [])]);
    await c.query("INSERT INTO issue_events (issue_id, actor_id, kind, payload) VALUES ($1,$2,'created',$3)", [id, userId, JSON.stringify({ title: input.title, ownerId: owner, parentIssueId: parentId, visibility })]);
    // Solo lo que ve todo el chat se anuncia en el chat.
    if (visibility === 'all') await appendMessage(c, { conversationId, authorId: userId, kind: 'system', body: sys('issue.created', { title: input.title, issueId: id, ...(parentId ? { parentIssueId: parentId } : {}) }) });
    const dto = await load(c, id);
    await publish(c, dto);
    await queueAssignedPush(c, id, owner, userId);
    await audit(c, userId, 'issue.created', { type: 'issue', id, workspaceId: a.workspaceId }, { visibility, child: !!parentId });
    return dto;
  });
}

/** Asunto personal: sin conversación, privado para quien lo crea (y solo él puede ser responsable). */
export async function createPersonalIssue(userId: string, input: { title: string; dueDate?: string | null }) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO issues (workspace_id, conversation_id, title, owner_id, due_date, created_by, visibility)
       VALUES (NULL, NULL, $1, $2, $3, $2, 'private') RETURNING id`,
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
      if (input.ownerId !== undefined && input.ownerId !== userId && input.ownerId !== null) throw badRequest('Una tarea personal solo es tuya');
      if (input.visibility !== undefined && input.visibility !== 'private') throw badRequest('Una tarea personal no se comparte');
      if (input.viewerIds?.length) throw badRequest('Una tarea personal no se comparte');
      if (input.waitingOnOrgId) throw badRequest('Una tarea personal no espera a una empresa');
    }
    const nextVis: IssueVisibility = input.visibility ?? cur.visibility;
    if (input.visibility !== undefined && input.visibility !== cur.visibility && cur.created_by !== userId) throw forbidden('Solo quien creó la tarea cambia quién lo ve');
    const before = cur.visibility !== 'all' || nextVis !== 'all' ? { visibility: cur.visibility as IssueVisibility, audience: await audience(c, issueId) } : null;
    const sets: string[] = ['updated_at = now()'];
    const vals: unknown[] = [issueId];
    const events: [string, object][] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (input.title !== undefined && input.title !== cur.title) { add('title', input.title); events.push(['title', { from: cur.title, to: input.title }]); }
    if (input.visibility !== undefined && input.visibility !== cur.visibility) {
      add('visibility', input.visibility);
      const org = input.visibility === 'org' ? await actorOrg(c, userId) : null;
      if (input.visibility === 'org' && !org) throw badRequest('No tienes empresa: usa «Privada»');
      add('visible_org_id', org);
      events.push(['visibility', { from: cur.visibility, to: input.visibility }]);
      if (input.visibility !== 'all') await addViewers(c, issueId, userId, [cur.created_by, ...(cur.owner_id ? [cur.owner_id] : [])]);
    }
    const owner = input.ownerId !== undefined ? input.ownerId : cur.owner_id;
    if (input.ownerId !== undefined && input.ownerId !== cur.owner_id) {
      if (input.ownerId) { if (nextVis === 'all') await assertMember(c, cur.conversation_id, input.ownerId); else await assertContact(c, userId, input.ownerId); }
      add('owner_id', input.ownerId); events.push(['owner', { from: cur.owner_id, to: input.ownerId }]);
    }
    if (nextVis !== 'all') {
      for (const v of input.viewerIds ?? []) await assertContact(c, userId, v);
      await addViewers(c, issueId, userId, [...(owner ? [owner] : []), ...(input.viewerIds ?? [])]);
    }
    if (input.dueDate !== undefined) {
      const prev = cur.due_date ? new Date(cur.due_date).toISOString().slice(0, 10) : null;
      if (input.dueDate !== prev) { add('due_date', input.dueDate); events.push(['due', { from: prev, to: input.dueDate }]); }
    }
    if (input.waitingOnOrgId !== undefined && input.waitingOnOrgId !== cur.waiting_on_org_id) {
      if (input.waitingOnOrgId) await assertWaitingOrg(c, cur, input.waitingOnOrgId);
      add('waiting_on_org_id', input.waitingOnOrgId); events.push(['waiting', { to: input.waitingOnOrgId }]);
    }
    if (input.status !== undefined && input.status !== cur.status) {
      add('status', input.status);
      sets.push('status_since = now()');
      sets.push(CLOSED.has(input.status) ? 'closed_at = now()' : 'closed_at = NULL');
      if (input.status !== 'waiting') sets.push('waiting_on_org_id = NULL');
      events.push(['status', { from: cur.status, to: input.status }]);
    }
    let topicChanged = false;
    if (input.topicId !== undefined && input.topicId !== cur.topic_id) {
      if (!cur.conversation_id) throw badRequest('Una tarea personal no lleva tema');
      if (input.topicId) await assertTopic(c, cur.conversation_id, input.topicId);
      add('topic_id', input.topicId); topicChanged = true;
    }
    if (!events.length && !topicChanged && !(input.viewerIds?.length)) return load(c, issueId);
    await c.query(`UPDATE issues SET ${sets.join(', ')} WHERE id = $1`, vals);
    for (const [kind, payload] of events) {
      await c.query('INSERT INTO issue_events (issue_id, actor_id, kind, payload) VALUES ($1,$2,$3,$4)', [issueId, userId, kind, JSON.stringify(payload)]);
    }
    // Tarea hecha (tanda 1.7): «✅ Ana completó la tarea» con confeti, también en las hijas. Cada cierre publica uno.
    const doneNow = nextVis === 'all' && input.status === 'done' && cur.status !== 'done';
    if (doneNow) {
      const byName = (await c.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]?.name ?? '';
      await appendMessage(c, { conversationId: cur.conversation_id, authorId: userId, kind: 'system', body: sys('issue.done', { issueId, title: input.title ?? cur.title, byId: userId, byName }) });
    }
    // Cancelar o reabrir se avisa en la conversación (solo si todo el chat ve el asunto y no es una tarea hija).
    else if (nextVis === 'all' && !cur.parent_issue_id && input.status && input.status !== cur.status && (CLOSED.has(input.status) || CLOSED.has(cur.status))) {
      await appendMessage(c, { conversationId: cur.conversation_id, authorId: userId, kind: 'system', body: sys(CLOSED.has(input.status) ? 'issue.closed' : 'issue.reopened', { title: input.title ?? cur.title, issueId }) });
    }
    const dto = await load(c, issueId);
    await publish(c, dto, before);
    // Cambiar solo el tema es interno de Chaggu: no dispara el webhook de la integración.
    if (cur.integration_id && events.length) {
      if (input.status !== undefined && input.status !== cur.status) await queueIntegrationEvent(c, issueId, userId, { type: 'issue.status_changed', from: cur.status, to: input.status });
      else await queueIntegrationEvent(c, issueId, userId, { type: 'issue.updated' });
    }
    if (input.ownerId !== undefined && input.ownerId !== cur.owner_id) await queueAssignedPush(c, issueId, input.ownerId, userId);
    await audit(c, userId, 'issue.updated', { type: 'issue', id: issueId, workspaceId: cur.workspace_id }, { changes: events.map(([k]) => k) });
    return dto;
  });
}

/** Solo un tema activo del mismo chat. */
async function assertTopic(c: Tx, conversationId: string, topicId: string) {
  const { rowCount } = await c.query('SELECT 1 FROM conversation_topics WHERE id = $1 AND conversation_id = $2 AND archived_at IS NULL', [topicId, conversationId]);
  if (!rowCount) throw badRequest('Ese tema no está activo en esta conversación');
}

export async function commentIssue(userId: string, issueId: string, body: string, extra: { author?: string; at?: string } = {}, existing?: Tx) {
  return inTransaction(existing, async (c) => {
    const { rows } = await c.query('SELECT conversation_id, visibility, integration_id, title FROM issues WHERE id = $1 FOR UPDATE', [issueId]);
    if (!rows[0]) throw taskNotFound();
    await loadVisible(c, userId, issueId);
    if (rows[0].visibility === 'all') await conversationAccess(c, userId, rows[0].conversation_id, 'post', true);
    // `author`: quién lo escribió fuera de Chaggu (comentarios que trae una integración). Los clientes muestran el cuerpo.
    await c.query("INSERT INTO issue_events (issue_id, actor_id, kind, payload) VALUES ($1,$2,'comment',$3)", [issueId, userId, JSON.stringify({ body, ...extra })]);
    await c.query('UPDATE issues SET updated_at = now() WHERE id = $1', [issueId]);
    if (rows[0].integration_id) await queueIntegrationEvent(c, issueId, userId, { type: 'issue.commented', body });
    // Aviso agrupado en el chat (tanda 1.7): solo lo que ve todo el chat.
    if (rows[0].visibility === 'all' && rows[0].conversation_id) {
      const actorName = extra.author || (await c.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]?.name || '';
      await bumpCommentNotice(c, { kind: 'issue', conversationId: rows[0].conversation_id, itemId: issueId, title: rows[0].title, actorId: userId, actorName, body });
    }
    const dto = await load(c, issueId);
    await publish(c, dto);
    return dto;
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
export async function listIssues(userId: string, filter: { workspaceId?: string; conversationId?: string; mine?: boolean; open?: boolean; personal?: boolean }) {
  const { rows } = await pool.query(
    `${SELECT} ${VISIBLE}
        AND ($2::uuid IS NULL OR i.workspace_id = $2) AND ($3::uuid IS NULL OR i.conversation_id = $3)
        AND (NOT $4 OR i.owner_id = $1) AND (NOT $5 OR i.status NOT IN ('done','cancelled'))
        AND ($6 OR i.conversation_id IS NOT NULL)
      ORDER BY (i.status IN ('done','cancelled')), i.due_date NULLS LAST, i.created_at DESC
      LIMIT 500`,
    [userId, filter.workspaceId ?? null, filter.conversationId ?? null, !!filter.mine, !!filter.open, filter.personal !== false],
  );
  return rows.map(toDTO);
}
