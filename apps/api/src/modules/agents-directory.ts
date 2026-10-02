// Pantalla «Agentes» (docs/AGENTES.md): los agentes miembro (users.kind = 'agent') de una empresa, con dueño, grupos,
// tareas que han tomado y último uso de su token MCP. La lista la ve cualquiera de la empresa; crear lo hace la
// administración; rotar el token o apagarlo, la administración o el dueño del agente. De cada agente solo se
// muestran los grupos y las tareas que quien mira también puede ver.
import { AddMembersInput, type AgentDTO, type CreateAgentInput } from '@tiecoms/contracts';
import type { z } from 'zod';
import { audit, enqueueOutbox, pool, tx, type Tx } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { createToken } from './mcp.ts';
import { avatarUrl } from './profile.ts';
import { addMembers } from './workspaces.ts';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const isAdmin = (role: string) => role === 'owner' || role === 'admin';

async function roleIn(userId: string, orgId: string): Promise<string> {
  const { rows } = await pool.query('SELECT role FROM organization_memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  if (!rows[0]) throw notFound('Empresa');
  return rows[0].role;
}

async function agentOf(orgId: string, agentId: string) {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, (SELECT al.actor_id FROM audit_events al WHERE al.target_id = u.id AND al.action = 'agent.created' ORDER BY al.id LIMIT 1) AS owner_id
       FROM users u JOIN organization_memberships om ON om.user_id = u.id AND om.org_id = $1
      WHERE u.id = $2 AND u.kind = 'agent' AND u.disabled_at IS NULL`,
    [orgId, agentId],
  );
  if (!rows[0]) throw notFound('Agente');
  return rows[0] as { id: string; name: string; owner_id: string | null };
}

async function canManage(viewerId: string, orgId: string, agentId: string) {
  const role = await roleIn(viewerId, orgId);
  const agent = await agentOf(orgId, agentId);
  if (!isAdmin(role) && agent.owner_id !== viewerId) throw forbidden('Solo la administración de la empresa o el dueño del agente');
  return agent;
}

async function notifyOrg(c: Tx, orgId: string) {
  const members = await c.query('SELECT user_id FROM organization_memberships WHERE org_id = $1', [orgId]);
  await enqueueOutbox(c, 'account.event', { userIds: members.rows.map((r) => r.user_id), event: { type: 'scope.changed', reason: 'org.agents' } });
}

export async function listOrgAgents(viewerId: string, orgId: string): Promise<{ agents: AgentDTO[]; canCreate: boolean }> {
  const role = await roleIn(viewerId, orgId);
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.avatar_file_id, om.title, om.area, u.created_at, ow.id AS owner_id, ow.name AS owner_name,
            (SELECT max(t.last_used_at) FROM mcp_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS last_used_at,
            (SELECT count(*)::int FROM mcp_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS tokens,
            (SELECT coalesce(json_agg(json_build_object('id', cv.id, 'name', cv.name) ORDER BY cv.name), '[]')
               FROM conversation_memberships m JOIN conversations cv ON cv.id = m.conversation_id AND cv.archived_at IS NULL
               JOIN conversation_memberships me ON me.conversation_id = cv.id AND me.user_id = $2 AND me.removed_at IS NULL
              WHERE m.user_id = u.id AND m.removed_at IS NULL) AS groups,
            (SELECT count(*)::int FROM conversation_memberships m JOIN conversations cv ON cv.id = m.conversation_id AND cv.archived_at IS NULL
              WHERE m.user_id = u.id AND m.removed_at IS NULL) AS group_total
       FROM users u JOIN organization_memberships om ON om.user_id = u.id AND om.org_id = $1
       LEFT JOIN LATERAL (SELECT al.actor_id FROM audit_events al WHERE al.target_id = u.id AND al.action = 'agent.created' ORDER BY al.id LIMIT 1) al ON true
       LEFT JOIN users ow ON ow.id = al.actor_id
      WHERE u.kind = 'agent' AND u.disabled_at IS NULL
      ORDER BY lower(u.name)`,
    [orgId, viewerId],
  );
  const ids = rows.map((r) => r.id as string);
  // Tareas del agente que quien mira puede ver: en grupos donde está y sin las privadas ajenas.
  const tasks = ids.length ? (await pool.query(
    `SELECT a.agent_id, i.id, i.title, i.status, i.conversation_id, cv.name AS chat, i.updated_at
       FROM unnest($1::uuid[]) AS a(agent_id)
       JOIN issues i ON a.agent_id = ANY(i.assignee_ids)
       JOIN conversations cv ON cv.id = i.conversation_id
       JOIN conversation_memberships me ON me.conversation_id = i.conversation_id AND me.user_id = $2 AND me.removed_at IS NULL
      WHERE i.visibility <> 'private' OR $2 = ANY(i.assignee_ids)
      ORDER BY i.updated_at DESC`,
    [ids, viewerId],
  )).rows : [];
  const agents = rows.map((r): AgentDTO => {
    const mine = tasks.filter((t) => t.agent_id === r.id);
    return {
      id: r.id,
      name: r.name,
      title: r.title ?? null,
      area: r.area ?? null,
      avatarUrl: avatarUrl(r.avatar_file_id),
      owner: r.owner_id ? { id: r.owner_id, name: r.owner_name } : null,
      createdAt: iso(r.created_at)!,
      lastUsedAt: iso(r.last_used_at),
      connected: r.tokens > 0,
      groups: r.groups,
      hiddenGroups: Math.max(0, r.group_total - r.groups.length),
      tasks: {
        open: mine.filter((t) => !['done', 'cancelled'].includes(t.status)).length,
        done: mine.filter((t) => t.status === 'done').length,
        recent: mine.slice(0, 5).map((t) => ({ id: t.id, title: t.title, status: t.status, chatId: t.conversation_id, chat: t.chat, updatedAt: iso(t.updated_at)! })),
      },
      canManage: isAdmin(role) || r.owner_id === viewerId,
    };
  });
  return { agents, canCreate: isAdmin(role) };
}

/** Alta desde la web (administración). Quien crea queda de dueño y suma el agente a los grupos que él administra. */
export async function createOrgAgent(viewerId: string, orgId: string, input: z.infer<typeof CreateAgentInput>) {
  if (!isAdmin(await roleIn(viewerId, orgId))) throw forbidden('Solo la administración de la empresa puede crear agentes');
  const name = input.name.trim().replace(/^@/, '');
  const clash = await pool.query(
    'SELECT u.kind FROM users u JOIN organization_memberships om ON om.user_id = u.id AND om.org_id = $1 WHERE u.disabled_at IS NULL AND lower(u.name) = lower($2)',
    [orgId, name],
  );
  if (clash.rowCount) throw badRequest(clash.rows[0].kind === 'agent' ? 'Ya hay un agente con ese nombre' : 'Ya hay una persona de la empresa con ese nombre');
  const agentId = await tx(async (c) => {
    const id = (await c.query("INSERT INTO users (kind, name, primary_org_id) VALUES ('agent', $1, $2) RETURNING id", [name, orgId])).rows[0].id as string;
    await c.query("INSERT INTO organization_memberships (org_id, user_id, role, title, area) VALUES ($1,$2,'member',$3,'Agentes')", [orgId, id, input.title?.trim() || 'Agente']);
    await audit(c, viewerId, 'agent.created', { type: 'user', id }, { orgId, name, via: 'web' });
    await notifyOrg(c, orgId);
    return id;
  });
  const groups: { id: string; ok: boolean; error?: string }[] = [];
  for (const conv of [...new Set(input.conversationIds ?? [])]) {
    try { await addMembers(viewerId, conv, AddMembersInput.parse({ userIds: [agentId], history: 'now' })); groups.push({ id: conv, ok: true }); }
    catch (e: any) { groups.push({ id: conv, ok: false, error: e?.message ?? String(e) }); }
  }
  const token = await createToken(agentId, `Agente ${name}`);
  return { agentId, name, groups, token: token.token, endpoint: '/api/mcp' };
}

/** Token nuevo: revoca los anteriores del agente y entrega el nuevo UNA vez. */
export async function rotateOrgAgentToken(viewerId: string, orgId: string, agentId: string) {
  const agent = await canManage(viewerId, orgId, agentId);
  await pool.query('UPDATE mcp_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [agentId]);
  const token = await createToken(agentId, `Agente ${agent.name}`);
  await tx((c) => audit(c, viewerId, 'agent.token_rotated', { type: 'user', id: agentId }, { orgId }));
  return { agentId, token: token.token, endpoint: '/api/mcp' };
}

/** Apaga el agente: revoca sus tokens y desactiva la cuenta. Sus mensajes y tareas quedan como historia. */
export async function disableOrgAgent(viewerId: string, orgId: string, agentId: string) {
  await canManage(viewerId, orgId, agentId);
  await tx(async (c) => {
    await c.query('UPDATE mcp_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [agentId]);
    await c.query('UPDATE users SET disabled_at = now() WHERE id = $1', [agentId]);
    await audit(c, viewerId, 'agent.disabled', { type: 'user', id: agentId }, { orgId });
    await notifyOrg(c, orgId);
  });
  return { ok: true };
}
