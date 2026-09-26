import type { z } from 'zod';
import type { CreateIssueInput, IssueDTO, IssueEventDTO, UpdateIssueInput } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { audit, pool, tx, type Db, type Tx } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { appendEvent, appendMessage } from './messages.ts';

/** Mensaje de sistema estructurado: cada cliente lo muestra en su idioma. */
const sys = (k: string, p: Record<string, unknown> = {}) => JSON.stringify({ k, ...p });
const CLOSED = new Set(['done', 'cancelled']);

const SELECT = `
  SELECT i.*, m.seq AS origin_seq,
         (SELECT count(*) FROM issue_events e WHERE e.issue_id = i.id AND e.kind = 'comment')::int AS comment_count
    FROM issues i LEFT JOIN messages m ON m.id = i.origin_message_id`;

const iso = (d: any) => (d ? new Date(d).toISOString() : null);
function toDTO(r: any): IssueDTO {
  return {
    id: r.id, workspaceId: r.workspace_id, conversationId: r.conversation_id,
    originMessageId: r.origin_message_id, originMessageSeq: r.origin_seq ?? null,
    title: r.title, status: r.status, waitingOnOrgId: r.waiting_on_org_id, ownerId: r.owner_id, requestedBy: r.requested_by,
    dueDate: r.due_date ? (typeof r.due_date === 'string' ? r.due_date : new Date(r.due_date).toISOString().slice(0, 10)) : null,
    createdBy: r.created_by, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, statusSince: iso(r.status_since)!,
    closedAt: iso(r.closed_at), commentCount: r.comment_count ?? 0,
  };
}

async function load(db: Db, id: string): Promise<IssueDTO> {
  const { rows } = await db.query(`${SELECT} WHERE i.id = $1`, [id]);
  if (!rows[0]) throw notFound('Asunto');
  return toDTO(rows[0]);
}

/** El responsable debe poder leer la conversación: si no, el asunto se le volvería invisible. */
async function assertMember(c: Tx, conversationId: string, userId: string) {
  const { rowCount } = await c.query('SELECT 1 FROM conversation_memberships WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL', [conversationId, userId]);
  if (!rowCount) throw badRequest('El responsable debe participar en la conversación del asunto');
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

async function publish(c: Tx, issue: IssueDTO) {
  await appendEvent(c, issue.conversationId, { type: 'issue.updated', conversationId: issue.conversationId, issue });
}

export async function createIssue(userId: string, conversationId: string, input: z.infer<typeof CreateIssueInput>) {
  return tx(async (c) => {
    const a = await conversationAccess(c, userId, conversationId, 'post', true);
    // Los terceros invitados participan en los asuntos (comentan, cambian estado, pueden ser responsables) pero no los abren.
    if (a.workspaceRole === 'guest') throw forbidden('Las personas invitadas de fuera participan en los asuntos, pero no pueden crearlos');
    let requestedBy: string | null = null;
    if (input.originMessageId) {
      const m = await c.query('SELECT author_id, seq FROM messages WHERE id = $1 AND conversation_id = $2', [input.originMessageId, conversationId]);
      if (!m.rows[0] || m.rows[0].seq <= a.historyFromSeq) throw badRequest('El mensaje de origen no está en esta conversación');
      requestedBy = m.rows[0].author_id;
    }
    const owner = input.ownerId ?? userId;
    await assertMember(c, conversationId, owner);
    const { rows } = await c.query(
      `INSERT INTO issues (workspace_id, conversation_id, origin_message_id, title, owner_id, requested_by, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [a.workspaceId, conversationId, input.originMessageId ?? null, input.title, owner, requestedBy, input.dueDate ?? null, userId],
    );
    const id: string = rows[0].id;
    await c.query("INSERT INTO issue_events (issue_id, actor_id, kind, payload) VALUES ($1,$2,'created',$3)", [id, userId, JSON.stringify({ title: input.title, ownerId: owner })]);
    await appendMessage(c, { conversationId, authorId: userId, kind: 'system', body: sys('issue.created', { title: input.title, issueId: id }) });
    const dto = await load(c, id);
    await publish(c, dto);
    await audit(c, userId, 'issue.created', { type: 'issue', id, workspaceId: a.workspaceId });
    return dto;
  });
}

export async function updateIssue(userId: string, issueId: string, input: z.infer<typeof UpdateIssueInput>) {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM issues WHERE id = $1 FOR UPDATE', [issueId]);
    const cur = rows[0];
    if (!cur) throw notFound('Asunto');
    await conversationAccess(c, userId, cur.conversation_id, 'post', true);
    const sets: string[] = ['updated_at = now()'];
    const vals: unknown[] = [issueId];
    const events: [string, object][] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (input.title !== undefined && input.title !== cur.title) { add('title', input.title); events.push(['title', { from: cur.title, to: input.title }]); }
    if (input.ownerId !== undefined && input.ownerId !== cur.owner_id) {
      if (input.ownerId) await assertMember(c, cur.conversation_id, input.ownerId);
      add('owner_id', input.ownerId); events.push(['owner', { from: cur.owner_id, to: input.ownerId }]);
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
    if (!events.length) return load(c, issueId);
    await c.query(`UPDATE issues SET ${sets.join(', ')} WHERE id = $1`, vals);
    for (const [kind, payload] of events) {
      await c.query('INSERT INTO issue_events (issue_id, actor_id, kind, payload) VALUES ($1,$2,$3,$4)', [issueId, userId, kind, JSON.stringify(payload)]);
    }
    // Cerrar o reabrir se avisa en la conversación: es lo que el grupo necesita saber.
    if (input.status && input.status !== cur.status && (CLOSED.has(input.status) || CLOSED.has(cur.status))) {
      await appendMessage(c, { conversationId: cur.conversation_id, authorId: userId, kind: 'system', body: sys(CLOSED.has(input.status) ? 'issue.closed' : 'issue.reopened', { title: input.title ?? cur.title, issueId }) });
    }
    const dto = await load(c, issueId);
    await publish(c, dto);
    await audit(c, userId, 'issue.updated', { type: 'issue', id: issueId, workspaceId: cur.workspace_id }, { changes: events.map(([k]) => k) });
    return dto;
  });
}

export async function commentIssue(userId: string, issueId: string, body: string) {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT conversation_id FROM issues WHERE id = $1 FOR UPDATE', [issueId]);
    if (!rows[0]) throw notFound('Asunto');
    await conversationAccess(c, userId, rows[0].conversation_id, 'post', true);
    await c.query("INSERT INTO issue_events (issue_id, actor_id, kind, payload) VALUES ($1,$2,'comment',$3)", [issueId, userId, JSON.stringify({ body })]);
    await c.query('UPDATE issues SET updated_at = now() WHERE id = $1', [issueId]);
    const dto = await load(c, issueId);
    await publish(c, dto);
    return dto;
  });
}

export async function getIssue(userId: string, issueId: string) {
  const issue = await load(pool, issueId);
  await conversationAccess(pool, userId, issue.conversationId, 'read');
  const { rows } = await pool.query('SELECT * FROM issue_events WHERE issue_id = $1 ORDER BY id', [issueId]);
  const events: IssueEventDTO[] = rows.map((r) => ({ id: r.id, issueId: r.issue_id, actorId: r.actor_id, kind: r.kind, payload: r.payload, createdAt: iso(r.created_at)! }));
  return { issue, events };
}

/**
 * Asuntos visibles para la persona: solo los de conversaciones que puede leer
 * ahora mismo (membresía activa y, si es tercero, dentro de su fecha).
 */
export async function listIssues(userId: string, filter: { workspaceId?: string; conversationId?: string; mine?: boolean; open?: boolean }) {
  const { rows } = await pool.query(
    `${SELECT}
       JOIN conversation_memberships cm ON cm.conversation_id = i.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
       JOIN conversations cv ON cv.id = i.conversation_id AND cv.archived_at IS NULL
       LEFT JOIN workspace_memberships wm ON wm.workspace_id = i.workspace_id AND wm.user_id = $1
      WHERE (i.workspace_id IS NULL OR (wm.user_id IS NOT NULL AND wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at > now())))
        AND ($2::uuid IS NULL OR i.workspace_id = $2) AND ($3::uuid IS NULL OR i.conversation_id = $3)
        AND (NOT $4 OR i.owner_id = $1) AND (NOT $5 OR i.status NOT IN ('done','cancelled'))
      ORDER BY (i.status IN ('done','cancelled')), i.due_date NULLS LAST, i.created_at DESC
      LIMIT 500`,
    [userId, filter.workspaceId ?? null, filter.conversationId ?? null, !!filter.mine, !!filter.open],
  );
  return rows.map(toDTO);
}
