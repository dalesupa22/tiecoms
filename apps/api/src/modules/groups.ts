import type { z } from 'zod';
import type { CreateGroupInput, CreateGroupResultDTO, OversightDTO } from '@tiecoms/contracts';
import { conversationAccess, workspaceAccess } from '../access.ts';
import { audit, pool, tx, type Tx } from '../db.ts';
import { badRequest, forbidden } from '../errors.ts';
import { appendMessage } from './messages.ts';
import { ensureNotBlocked } from './safety.ts';
import { OVERSIGHT_SCOPE } from './oversight-scope.ts';
import { addConversationMembers, createInvitation, primaryOrg, scopeChanged } from './workspaces.ts';

const sys = (k: string, p: Record<string, unknown> = {}) => JSON.stringify({ k, ...p });
const ACTIVE_WM = 'wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at > now())';

/** Espacio casa de la empresa («Tu organización»). Se crea la primera vez que alguien arma un grupo interno. */
async function orgHome(c: Tx, orgId: string, userId: string): Promise<string> {
  const found = await c.query('SELECT id FROM workspaces WHERE owning_org_id = $1 AND is_org_home AND archived_at IS NULL', [orgId]);
  if (found.rows[0]) return found.rows[0].id;
  const org = await c.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
  const w = await c.query(
    `INSERT INTO workspaces (owning_org_id, name, is_org_home, created_by) VALUES ($1,$2,true,$3)
     ON CONFLICT (owning_org_id) WHERE is_org_home AND archived_at IS NULL DO NOTHING RETURNING id`,
    [orgId, org.rows[0].name, userId],
  );
  if (!w.rows[0]) return orgHome(c, orgId, userId);
  await c.query('INSERT INTO workspace_organizations (workspace_id, org_id) VALUES ($1,$2)', [w.rows[0].id, orgId]);
  return w.rows[0].id;
}

/** Suma colegas de la empresa al espacio (casa o relación nueva) para que puedan estar en el grupo. */
async function joinColleagues(c: Tx, workspaceId: string, orgId: string, userIds: string[], leadId?: string) {
  if (userIds.length) {
    const { rows } = await c.query('SELECT user_id FROM organization_memberships WHERE org_id = $1 AND user_id = ANY($2)', [orgId, userIds]);
    if (rows.length !== new Set(userIds).size) throw badRequest('Solo puedes sumar directamente a personas de tu empresa; a las demás invítalas por correo');
  }
  for (const uid of userIds) {
    await c.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, org_id, role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET revoked_at = NULL, expires_at = NULL,
         role = CASE WHEN workspace_memberships.role = 'guest' OR workspace_memberships.revoked_at IS NOT NULL THEN EXCLUDED.role ELSE workspace_memberships.role END,
         org_id = EXCLUDED.org_id`,
      [workspaceId, uid, orgId, uid === leadId ? 'lead' : 'member'],
    );
  }
}

/**
 * El «+» de Grupos: un grupo interno de mi empresa, un grupo dentro de una relación existente o una
 * relación nueva con otra empresa. Cualquier participante que no sea tercero puede crear grupos.
 */
export async function createGroup(userId: string, input: z.infer<typeof CreateGroupInput>): Promise<CreateGroupResultDTO> {
  const others = [...new Set(input.memberIds.filter((id) => id !== userId))];
  const t = input.target;
  const made = await tx(async (c) => {
    await ensureNotBlocked(c, userId, others);
    let workspaceId: string;
    if (t.kind === 'workspace') {
      await workspaceAccess(c, userId, t.workspaceId, 'nonguest');
      workspaceId = t.workspaceId;
      if (others.length) {
        const { rows } = await c.query(
          `SELECT user_id FROM workspace_memberships wm WHERE workspace_id = $1 AND user_id = ANY($2) AND ${ACTIVE_WM}`, [workspaceId, others]);
        if (rows.length !== others.length) throw badRequest('Todas las personas deben participar en el espacio');
      }
    } else {
      const { orgId } = await primaryOrg(c, userId, t.orgId);
      if (t.kind === 'org') {
        workspaceId = await orgHome(c, orgId, userId);
        await joinColleagues(c, workspaceId, orgId, [userId]);
      } else {
        const w = await c.query(
          'INSERT INTO workspaces (owning_org_id, name, counterpart_name, created_by) VALUES ($1,$2,$2,$3) RETURNING id',
          [orgId, t.companyName, userId],
        );
        workspaceId = w.rows[0].id;
        await c.query('INSERT INTO workspace_organizations (workspace_id, org_id) VALUES ($1,$2)', [workspaceId, orgId]);
        await joinColleagues(c, workspaceId, orgId, [userId], userId);
        await appendAudit(c, userId, workspaceId);
      }
      await joinColleagues(c, workspaceId, orgId, others);
    }
    // Grupo solo de mi empresa dentro de una relación: su propio canal, que la otra empresa no ve.
    let internalOrgId: string | null = null;
    if (input.internal && t.kind !== 'org') {
      internalOrgId = (await c.query('SELECT org_id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId])).rows[0]?.org_id ?? null;
      if (!internalOrgId) throw badRequest('No perteneces a una empresa en este espacio');
      if (others.length) {
        const { rows } = await c.query('SELECT user_id FROM organization_memberships WHERE org_id = $1 AND user_id = ANY($2)', [internalOrgId, others]);
        if (rows.length !== others.length) throw badRequest('Un grupo solo de tu empresa admite solo a gente de tu empresa');
      }
    }
    const conv = await c.query(
      'INSERT INTO conversations (workspace_id, kind, name, internal_org_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [workspaceId, internalOrgId ? 'internal' : 'group', input.name, internalOrgId, userId],
    );
    const conversationId: string = conv.rows[0].id;
    await addConversationMembers(c, conversationId, [userId], userId, 'all', true);
    if (others.length) await addConversationMembers(c, conversationId, others, userId, 'all');
    await appendMessage(c, { conversationId, authorId: userId, kind: 'system', body: sys('group.created', { name: input.name }) });
    await scopeChanged(c, [userId, ...others], 'group.created');
    await audit(c, userId, 'conversation.created', { type: 'conversation', id: conversationId, workspaceId }, { target: t.kind });
    return { workspaceId, conversationId };
  });

  // Invitaciones por correo (cada una en su transacción, como el diálogo de invitar). En un grupo
  // interno quien viene de fuera entra como tercero; quien ya está en el espacio se suma directo.
  if (input.internal && t.kind !== 'org' && (input.inviteEmails.length || input.shareLink)) {
    // Un canal solo de mi empresa no recibe invitaciones de fuera (el API de invitaciones solo admite grupos compartidos).
    return { ...made, invited: 0 };
  }
  const role = t.kind === 'org' ? 'guest' : input.inviteRole;
  let invited = 0;
  for (const email of [...new Set(input.inviteEmails)]) {
    const existing = await pool.query(
      `SELECT u.id FROM users u JOIN workspace_memberships wm ON wm.user_id = u.id AND wm.workspace_id = $1
        WHERE u.email = $2 AND ${ACTIVE_WM}`, [made.workspaceId, email]);
    if (existing.rows[0]) {
      await tx((c) => addConversationMembers(c, made.conversationId, [existing.rows[0].id], userId, 'all'));
      invited++;
      continue;
    }
    await createInvitation(userId, made.workspaceId, {
      email, role, conversationIds: [made.conversationId], expiresInDays: 14, history: 'all', lang: input.lang,
    });
    invited++;
  }
  if (!input.shareLink) return { ...made, invited };
  const link = await createInvitation(userId, made.workspaceId, {
    role, conversationIds: [made.conversationId], expiresInDays: 14, history: 'all', lang: input.lang, multiUse: true,
  });
  return { ...made, invited, inviteUrl: link.url, inviteCode: link.code };
}

async function appendAudit(c: Tx, userId: string, workspaceId: string) {
  await audit(c, userId, 'workspace.created', { type: 'workspace', id: workspaceId, workspaceId }, { via: 'group' });
}

// ---------- Supervisión ----------
export async function listOversight(userId: string, orgId: string): Promise<OversightDTO> {
  const role = await pool.query('SELECT role FROM organization_memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  if (!['owner', 'admin'].includes(role.rows[0]?.role)) throw forbidden('Solo quien administra la empresa ve la supervisión');
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.kind, c.workspace_id, w.name AS workspace_name, w.owning_org_id, c.last_message_at,
            ARRAY(SELECT org_id FROM workspace_organizations wo WHERE wo.workspace_id = w.id AND wo.left_at IS NULL ORDER BY wo.joined_at) AS org_ids,
            (SELECT count(*) FROM conversation_memberships x WHERE x.conversation_id = c.id AND x.removed_at IS NULL)::int AS member_count,
            ARRAY(SELECT x.user_id FROM conversation_memberships x JOIN organization_memberships om ON om.user_id = x.user_id AND om.org_id = $1
                   WHERE x.conversation_id = c.id AND x.removed_at IS NULL ORDER BY x.joined_at) AS mine,
            EXISTS (SELECT 1 FROM conversation_memberships x WHERE x.conversation_id = c.id AND x.user_id = $2 AND x.removed_at IS NULL) AS i_am_member
       FROM conversations c JOIN workspaces w ON w.id = c.workspace_id AND w.archived_at IS NULL
      WHERE ${OVERSIGHT_SCOPE.replaceAll('$ORG', '$1')}
      ORDER BY c.last_message_at DESC NULLS LAST, c.id`,
    [orgId, userId],
  );
  return {
    orgId,
    groups: rows.map((r) => ({
      conversationId: r.id, name: r.name, kind: r.kind, workspaceId: r.workspace_id, workspaceName: r.workspace_name,
      owningOrgId: r.owning_org_id, organizationIds: r.org_ids, memberCount: r.member_count, myOrgMemberIds: r.mine,
      lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null, iAmMember: r.i_am_member,
    })),
  };
}

/**
 * Archivar un grupo (lo puede quien lo administra: su creador o quien lidera/administra el espacio). Sale de las
 * listas de todos. Si era el último grupo de un espacio que no es casa, el espacio también se archiva.
 */
export async function archiveGroup(userId: string, conversationId: string) {
  return tx(async (c) => {
    const a = await conversationAccess(c, userId, conversationId, 'manage', true);
    if (a.kind !== 'group' && a.kind !== 'internal') throw badRequest('Solo se archivan grupos');
    const members = (await c.query('SELECT user_id FROM conversation_memberships WHERE conversation_id = $1 AND removed_at IS NULL', [conversationId])).rows.map((r) => r.user_id as string);
    await c.query('UPDATE conversations SET archived_at = now() WHERE id = $1', [conversationId]);
    let workspaceArchived = false;
    if (a.workspaceId) {
      const left = await c.query('SELECT 1 FROM conversations WHERE workspace_id = $1 AND archived_at IS NULL LIMIT 1', [a.workspaceId]);
      if (!left.rowCount) {
        const w = await c.query('UPDATE workspaces SET archived_at = now() WHERE id = $1 AND NOT is_org_home AND archived_at IS NULL RETURNING id', [a.workspaceId]);
        workspaceArchived = !!w.rowCount;
      }
    }
    await scopeChanged(c, members, 'group.archived', undefined, { conversationId });
    await audit(c, userId, 'conversation.archived', { type: 'conversation', id: conversationId, workspaceId: a.workspaceId }, { workspaceArchived });
    return { archived: true, workspaceArchived };
  });
}
