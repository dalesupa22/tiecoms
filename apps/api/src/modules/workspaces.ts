import type { z } from 'zod';
import type {
  AcceptInvitationInput, AddMembersInput, CreateConversationInput, CreateInvitationInput, CreateWorkspaceInput, InvitationPreviewDTO,
} from '@tiecoms/contracts';
import { conversationAccess, workspaceAccess } from '../access.ts';
import { audit, enqueueOutbox, pool, tx, type Tx } from '../db.ts';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { randomToken, sha256 } from '../security.ts';
import { deliverInvitation, prepareInvitationFor } from './invitations.ts';
import { appendEvent, appendMessage, toMessageDTO } from './messages.ts';
import { ensureNotBlocked } from './safety.ts';
import { getSummarizer } from './voice-providers.ts';

/** Mensaje de sistema estructurado: cada cliente lo muestra en su idioma. */
const sys = (k: string, p: Record<string, unknown> = {}) => JSON.stringify({ k, ...p });

async function primaryOrg(c: Tx, userId: string, orgId?: string) {
  const { rows } = await c.query(
    `SELECT om.org_id, u.name FROM organization_memberships om JOIN users u ON u.id = om.user_id
      WHERE om.user_id = $1 AND ($2::uuid IS NULL OR om.org_id = $2)
      ORDER BY (om.org_id = u.primary_org_id) DESC LIMIT 1`,
    [userId, orgId ?? null],
  );
  if (!rows[0]) throw forbidden('Debes pertenecer a una empresa para hacer esto');
  return { orgId: rows[0].org_id as string, userName: rows[0].name as string };
}

async function activeMemberIds(c: Tx, conversationId: string): Promise<string[]> {
  const { rows } = await c.query('SELECT user_id FROM conversation_memberships WHERE conversation_id = $1 AND removed_at IS NULL ORDER BY joined_at', [conversationId]);
  return rows.map((r) => r.user_id);
}

/** Avisa a los sockets de estos usuarios que entren a la sala y que refresquen su alcance. */
async function scopeChanged(c: Tx, userIds: string[], reason: string, join?: { conversationId: string }, leave?: { conversationId: string }) {
  if (!userIds.length) return;
  if (join) await enqueueOutbox(c, 'rooms.join', { userIds, conversationId: join.conversationId });
  if (leave) await enqueueOutbox(c, 'rooms.leave', { userIds, conversationId: leave.conversationId });
  await enqueueOutbox(c, 'account.event', { userIds, event: { type: 'scope.changed', reason } });
}

async function addConversationMembers(c: Tx, conversationId: string, userIds: string[], addedBy: string, history: 'now' | 'all', manage = false) {
  const { rows } = await c.query('SELECT last_message_seq FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
  const from = history === 'all' ? 0 : rows[0].last_message_seq;
  const added: string[] = [];
  for (const uid of userIds) {
    // Reingresar no restaura silenciosamente el historial anterior: se fija de nuevo.
    const r = await c.query(
      `INSERT INTO conversation_memberships (conversation_id, user_id, can_manage, history_from_seq, added_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (conversation_id, user_id) DO UPDATE
         SET removed_at = NULL, history_from_seq = EXCLUDED.history_from_seq, joined_at = now(), added_by = EXCLUDED.added_by
         WHERE conversation_memberships.removed_at IS NOT NULL
       RETURNING user_id`,
      [conversationId, uid, manage, from, addedBy],
    );
    if (r.rowCount) added.push(uid);
  }
  if (added.length) {
    await appendEvent(c, conversationId, { type: 'members.changed', conversationId, memberIds: await activeMemberIds(c, conversationId) });
    await scopeChanged(c, added, 'conversation.joined', { conversationId });
  }
  return added;
}

export async function createWorkspace(userId: string, input: z.infer<typeof CreateWorkspaceInput>) {
  return tx(async (c) => {
    const { orgId } = await primaryOrg(c, userId, input.orgId);
    const w = await c.query(
      'INSERT INTO workspaces (owning_org_id, name, department, glyph, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [orgId, input.name, input.department ?? null, input.glyph ?? null, userId],
    );
    const workspaceId: string = w.rows[0].id;
    await c.query('INSERT INTO workspace_organizations (workspace_id, org_id) VALUES ($1,$2)', [workspaceId, orgId]);
    await c.query("INSERT INTO workspace_memberships (workspace_id, user_id, org_id, role) VALUES ($1,$2,$3,'lead')", [workspaceId, userId, orgId]);
    const general = await c.query(
      "INSERT INTO conversations (workspace_id, kind, level, name, created_by) VALUES ($1,'group','operativo','General',$2) RETURNING id",
      [workspaceId, userId],
    );
    const internal = await c.query(
      "INSERT INTO conversations (workspace_id, kind, name, internal_org_id, created_by) VALUES ($1,'internal','Equipo interno',$2,$3) RETURNING id",
      [workspaceId, orgId, userId],
    );
    for (const conv of [general.rows[0].id, internal.rows[0].id]) {
      await c.query('INSERT INTO conversation_memberships (conversation_id, user_id, can_manage, added_by) VALUES ($1,$2,true,$2)', [conv, userId]);
      await enqueueOutbox(c, 'rooms.join', { userIds: [userId], conversationId: conv });
    }
    await appendMessage(c, { conversationId: general.rows[0].id, authorId: userId, kind: 'system', body: sys('workspace.created', { name: input.name }) });
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'scope.changed', reason: 'workspace.created' } });
    await audit(c, userId, 'workspace.created', { type: 'workspace', id: workspaceId, workspaceId });
    return { id: workspaceId, generalConversationId: general.rows[0].id as string };
  });
}

export async function createConversation(userId: string, workspaceId: string, input: z.infer<typeof CreateConversationInput>) {
  return tx(async (c) => {
    const wa = await workspaceAccess(c, userId, workspaceId, 'nonguest');
    const internalOrgId = input.kind === 'internal' ? wa.orgId : null;
    if (input.kind === 'internal' && !internalOrgId) throw badRequest('No perteneces a una empresa en este espacio');
    const others = [...new Set(input.memberIds.filter((id) => id !== userId))];
    await ensureNotBlocked(c, userId, others);
    if (others.length) {
      const { rows } = await c.query(
        `SELECT user_id, org_id FROM workspace_memberships
          WHERE workspace_id = $1 AND user_id = ANY($2) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
        [workspaceId, others],
      );
      if (rows.length !== others.length) throw badRequest('Todas las personas deben participar en el espacio');
      if (internalOrgId && rows.some((r) => r.org_id !== internalOrgId)) throw badRequest('Un grupo interno solo admite personas de tu empresa');
    }
    const conv = await c.query(
      'INSERT INTO conversations (workspace_id, kind, level, name, internal_org_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [workspaceId, input.kind, input.level, input.name, internalOrgId, userId],
    );
    const conversationId: string = conv.rows[0].id;
    await addConversationMembers(c, conversationId, [userId], userId, 'all', true);
    if (others.length) await addConversationMembers(c, conversationId, others, userId, 'all');
    await appendMessage(c, { conversationId, authorId: userId, kind: 'system', body: sys('group.created', { name: input.name }) });
    await audit(c, userId, 'conversation.created', { type: 'conversation', id: conversationId, workspaceId });
    return { id: conversationId };
  });
}

export async function addMembers(userId: string, conversationId: string, input: z.infer<typeof AddMembersInput>) {
  return tx(async (c) => {
    const a = await conversationAccess(c, userId, conversationId, 'manage');
    if (a.kind === 'direct') throw badRequest('Los directos no admiten más personas');
    await ensureNotBlocked(c, userId, input.userIds);
    let rows: { user_id: string; org_id: string | null; name: string }[];
    const side = a.kind === 'multi' ? (await c.query("SELECT parent_conversation_id, parent_message_id FROM conversations WHERE id = $1 AND derive_kind = 'side'", [conversationId])).rows[0] : null;
    if (side) {
      // Lateral: la misma regla que al abrirla (participantes del origen o colegas de mis empresas).
      const { outsiders } = await sideAudience(c, userId, side.parent_conversation_id, side.parent_message_id, [...new Set(input.userIds)]);
      if (outsiders.length) throw sideOutsider(outsiders);
      rows = (await c.query('SELECT id AS user_id, primary_org_id AS org_id, name FROM users WHERE id = ANY($1)', [input.userIds])).rows;
    } else if (a.kind === 'multi') {
      // Chat grupal: basta con que quien suma comparta un espacio o la empresa con cada persona.
      const ok = await reachable(c, userId, [...new Set(input.userIds)]);
      if (ok.length !== new Set(input.userIds).size) throw forbidden('Solo puedes sumar personas con las que compartes un espacio o tu empresa');
      rows = (await c.query('SELECT id AS user_id, primary_org_id AS org_id, name FROM users WHERE id = ANY($1)', [ok])).rows;
    } else {
      rows = (await c.query(
        `SELECT wm.user_id, wm.org_id, u.name FROM workspace_memberships wm JOIN users u ON u.id = wm.user_id
          WHERE wm.workspace_id = $1 AND wm.user_id = ANY($2) AND wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at > now())`,
        [a.workspaceId, input.userIds],
      )).rows;
      if (rows.length !== new Set(input.userIds).size) throw badRequest('Todas las personas deben participar en el espacio');
    }
    if (a.kind === 'internal' && rows.some((r) => r.org_id !== a.internalOrgId)) throw badRequest('Un grupo interno solo admite personas de su empresa');
    const added = await addConversationMembers(c, conversationId, input.userIds, userId, input.history);
    if (added.length) {
      const names = rows.filter((r) => added.includes(r.user_id)).map((r) => r.name).join(', ');
      await appendMessage(c, { conversationId, authorId: userId, kind: 'system', body: sys('members.added', { names, history: input.history }) });
      await audit(c, userId, 'conversation.members_added', { type: 'conversation', id: conversationId, workspaceId: a.workspaceId }, { added, history: input.history });
    }
    return { added };
  });
}

export async function removeMember(userId: string, conversationId: string, targetId: string) {
  return tx(async (c) => {
    const a = await conversationAccess(c, userId, conversationId, targetId === userId ? 'read' : 'manage');
    if (a.kind === 'direct') throw badRequest('No se puede salir de un directo');
    await c.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
    const r = await c.query(
      'UPDATE conversation_memberships SET removed_at = now() WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL RETURNING user_id',
      [conversationId, targetId],
    );
    if (!r.rowCount) throw notFound('Participante');
    const name = (await c.query('SELECT name FROM users WHERE id = $1', [targetId])).rows[0]?.name ?? 'Alguien';
    await appendMessage(c, { conversationId, authorId: userId, kind: 'system', body: sys(targetId === userId ? 'member.left' : 'member.removed', { name }) });
    await appendEvent(c, conversationId, { type: 'members.changed', conversationId, memberIds: await activeMemberIds(c, conversationId) });
    await scopeChanged(c, [targetId], 'conversation.left', undefined, { conversationId });
    await audit(c, userId, 'conversation.member_removed', { type: 'conversation', id: conversationId, workspaceId: a.workspaceId }, { targetId });
  });
}

/**
 * A quién puedes escribir: personas con las que compartes un espacio activo o
 * tu empresa. Devuelve el subconjunto alcanzable de ids.
 */
async function reachable(c: Tx, userId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  await ensureNotBlocked(c, userId, ids);
  const { rows } = await c.query(
    `SELECT DISTINCT u.id FROM users u
      WHERE u.id = ANY($2) AND u.disabled_at IS NULL AND (
        EXISTS (SELECT 1 FROM workspace_memberships a JOIN workspace_memberships b ON b.workspace_id = a.workspace_id
                 WHERE a.user_id = $1 AND b.user_id = u.id AND a.revoked_at IS NULL AND b.revoked_at IS NULL
                   AND (a.expires_at IS NULL OR a.expires_at > now()) AND (b.expires_at IS NULL OR b.expires_at > now()))
        OR EXISTS (SELECT 1 FROM organization_memberships a JOIN organization_memberships b ON b.org_id = a.org_id
                    WHERE a.user_id = $1 AND b.user_id = u.id))`,
    [userId, ids],
  );
  return rows.map((r) => r.id as string);
}

/** Nuevo chat: una persona → directo; varias (de una o varias empresas) → chat grupal fuera de los espacios. */
export async function createChat(userId: string, input: { userIds: string[]; name?: string }) {
  const others = [...new Set(input.userIds)].filter((u) => u !== userId);
  if (!others.length) throw badRequest('Elige al menos a una persona');
  if (others.length === 1 && !input.name) return { ...(await getOrCreateDirect(userId, others[0]!)), kind: 'direct' as const };
  return tx(async (c) => {
    const ok = await reachable(c, userId, others);
    if (ok.length !== others.length) throw forbidden('Solo puedes sumar personas con las que compartes un espacio o tu empresa');
    const { rows } = await c.query("INSERT INTO conversations (kind, name, created_by) VALUES ('multi', $1, $2) RETURNING id", [input.name ?? null, userId]);
    const id: string = rows[0].id;
    // Quien crea administra; el resto participa y puede sumar a más gente.
    await c.query('INSERT INTO conversation_memberships (conversation_id, user_id, can_manage, added_by) VALUES ($1,$2,true,$2)', [id, userId]);
    for (const uid of others) await c.query('INSERT INTO conversation_memberships (conversation_id, user_id, can_manage, added_by) VALUES ($1,$2,true,$3)', [id, uid, userId]);
    const { rows: names } = await c.query('SELECT name FROM users WHERE id = ANY($1) ORDER BY name', [others]);
    await appendMessage(c, { conversationId: id, authorId: userId, kind: 'system', body: sys('chat.created', { names: names.map((r) => r.name).join(', ') }) });
    await audit(c, userId, 'conversation.created', { type: 'conversation', id }, { kind: 'multi', members: others.length + 1 });
    await scopeChanged(c, [userId, ...others], 'chat.created', { conversationId: id });
    return { id, created: true, kind: 'multi' as const };
  });
}

export async function getOrCreateDirect(userId: string, otherId: string) {
  if (otherId === userId) throw badRequest('No puedes abrir un directo contigo');
  return tx(async (c) => {
    if ((await reachable(c, userId, [otherId])).length !== 1) throw forbidden('Solo puedes escribir a personas con las que compartes un espacio o tu empresa');
    const key = [userId, otherId].sort().join(':');
    const ins = await c.query(
      "INSERT INTO conversations (kind, dm_key, created_by) VALUES ('direct',$1,$2) ON CONFLICT (dm_key) DO NOTHING RETURNING id",
      [key, userId],
    );
    if (ins.rowCount) {
      const id: string = ins.rows[0].id;
      for (const uid of [userId, otherId]) {
        await c.query('INSERT INTO conversation_memberships (conversation_id, user_id, added_by) VALUES ($1,$2,$3)', [id, uid, userId]);
      }
      await scopeChanged(c, [userId, otherId], 'direct.created', { conversationId: id });
      return { id, created: true };
    }
    const { rows } = await c.query('SELECT id FROM conversations WHERE dm_key = $1', [key]);
    return { id: rows[0].id as string, created: false };
  });
}

// ---------- Invitaciones ----------
export async function createInvitation(userId: string, workspaceId: string, input: z.infer<typeof CreateInvitationInput>) {
  const inv = await tx(async (c) => {
    await workspaceAccess(c, userId, workspaceId, 'nonguest');
    if (input.role === 'admin') await workspaceAccess(c, userId, workspaceId, 'admin');
    if (input.conversationIds.length) {
      // Solo puedes invitar a conversaciones donde tú mismo participas.
      const { rows } = await c.query(
        `SELECT c.id FROM conversations c JOIN conversation_memberships m ON m.conversation_id = c.id AND m.user_id = $2 AND m.removed_at IS NULL
          WHERE c.workspace_id = $1 AND c.id = ANY($3) AND c.kind = 'group'`,
        [workspaceId, userId, input.conversationIds],
      );
      if (rows.length !== new Set(input.conversationIds).size) throw badRequest('Solo puedes invitar a grupos compartidos donde participas');
    }
    if (input.role === 'guest' && !input.conversationIds.length) throw badRequest('Un tercero invitado debe entrar a grupos concretos');
    if (input.email) await prepareInvitationFor(c, 'workspace', workspaceId, input.email);
    const token = randomToken(24);
    const { rows } = await c.query(
      `INSERT INTO invitations (token_hash, workspace_id, invited_by, email, role, conversation_ids, history, access_until, expires_at, lang)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(days => $9), $10) RETURNING id, expires_at`,
      [sha256(token), workspaceId, userId, input.email ?? null, input.role, input.conversationIds, input.history, input.accessUntil ?? null, input.expiresInDays, input.lang],
    );
    await audit(c, userId, 'invitation.created', { type: 'invitation', id: rows[0].id, workspaceId }, { role: input.role, email: input.email ?? null });
    return { id: rows[0].id as string, token, expiresAt: rows[0].expires_at as Date };
  });
  const mail = input.email ? await deliverInvitation('workspace', inv.id, inv.token) : null;
  return { ...inv, emailSent: mail?.status === 'sent', emailStatus: mail?.status ?? null };
}

export async function previewInvitation(token: string): Promise<InvitationPreviewDTO> {
  const { rows } = await pool.query(
    `SELECT i.role, i.email, i.expires_at, i.accepted_at, i.revoked_at, w.name AS workspace_name, u.name AS inviter, o.name AS inviter_org
       FROM invitations i JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.invited_by
       LEFT JOIN organizations o ON o.id = u.primary_org_id WHERE i.token_hash = $1`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) throw notFound('Invitación');
  return {
    workspaceName: r.workspace_name, invitedByName: r.inviter, invitedByOrg: r.inviter_org ?? '', role: r.role, email: r.email,
    expiresAt: new Date(r.expires_at).toISOString(),
    valid: !r.accepted_at && !r.revoked_at && new Date(r.expires_at) > new Date(),
  };
}

export async function acceptInvitation(userId: string, token: string, input: z.infer<typeof AcceptInvitationInput>) {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM invitations WHERE token_hash = $1 FOR UPDATE', [sha256(token)]);
    const inv = rows[0];
    if (!inv) throw notFound('Invitación');
    if (inv.accepted_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) throw conflict('La invitación ya no es válida');
    const me = await c.query('SELECT email, name FROM users WHERE id = $1', [userId]);
    if (inv.email && inv.email.toLowerCase() !== String(me.rows[0].email).toLowerCase()) {
      throw forbidden('Esta invitación es para otro correo');
    }
    const { orgId } = await primaryOrg(c, userId, input.orgId);
    const existing = await c.query('SELECT role, revoked_at FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2', [inv.workspace_id, userId]);
    if (existing.rows[0] && !existing.rows[0].revoked_at && existing.rows[0].role !== 'guest' && inv.role === 'guest') {
      // Ya es participante pleno: no se degrada a tercero.
    } else {
      await c.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, org_id, role, sponsor_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role, sponsor_id = EXCLUDED.sponsor_id,
           expires_at = EXCLUDED.expires_at, revoked_at = NULL, joined_at = CASE WHEN workspace_memberships.revoked_at IS NULL THEN workspace_memberships.joined_at ELSE now() END`,
        [inv.workspace_id, userId, inv.role === 'guest' ? null : orgId, inv.role, inv.invited_by, inv.role === 'guest' ? inv.access_until : null],
      );
    }
    // Un tercero no suma su empresa al espacio: participa a título propio.
    if (inv.role !== 'guest') {
      await c.query(
        'INSERT INTO workspace_organizations (workspace_id, org_id) VALUES ($1,$2) ON CONFLICT (workspace_id, org_id) DO UPDATE SET left_at = NULL',
        [inv.workspace_id, orgId],
      );
    }
    for (const convId of inv.conversation_ids as string[]) {
      const added = await addConversationMembers(c, convId, [userId], inv.invited_by, inv.history);
      if (added.length) await appendMessage(c, { conversationId: convId, authorId: userId, kind: 'system', body: sys('member.joined', { name: me.rows[0].name }) });
    }
    await c.query('UPDATE invitations SET accepted_by = $2, accepted_at = now() WHERE id = $1', [inv.id, userId]);
    // Los demás participantes del espacio ven a la persona nueva en su directorio.
    const others = await c.query('SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND revoked_at IS NULL', [inv.workspace_id]);
    await scopeChanged(c, others.rows.map((r) => r.user_id), 'workspace.member_joined');
    await audit(c, userId, 'invitation.accepted', { type: 'invitation', id: inv.id, workspaceId: inv.workspace_id }, { role: inv.role, orgId });
    return { workspaceId: inv.workspace_id as string, conversationIds: inv.conversation_ids as string[] };
  });
}

// ---------- Bifurcaciones: derivar y devolver ----------
/**
 * Deriva una conversación nueva desde un mensaje, para resolver algo aparte sin
 * mover el hilo original:
 *  - same: misma audiencia que el origen.
 *  - internal: solo las personas de mi empresa que están en el origen.
 *  - directive: quien deriva, el autor del mensaje y quienes lideran o administran el espacio.
 * La derivada empieza sin historial. En el origen queda un aviso sin el nombre,
 * porque no todos los del origen pueden ver la derivada.
 */
export async function deriveConversation(userId: string, parentId: string, input: { messageId: string; kind: 'same' | 'internal' | 'directive'; name?: string; reason?: string }) {
  return tx(async (c) => {
    const a = await conversationAccess(c, userId, parentId, 'post', true);
    if (!a.workspaceId) throw badRequest('Solo se deriva desde conversaciones de un espacio');
    const wa = await workspaceAccess(c, userId, a.workspaceId, 'nonguest');
    const msg = await c.query('SELECT id, author_id, body, kind, seq FROM messages WHERE id = $1 AND conversation_id = $2', [input.messageId, parentId]);
    const m = msg.rows[0];
    if (!m || m.seq <= a.historyFromSeq || m.kind !== 'text') throw badRequest('Solo se deriva desde un mensaje visible de esta conversación');
    const parent = (await c.query('SELECT name, level FROM conversations WHERE id = $1', [parentId])).rows[0];

    const members = (await c.query(
      `SELECT cm.user_id, wm.org_id, wm.role FROM conversation_memberships cm
         JOIN workspace_memberships wm ON wm.workspace_id = $2 AND wm.user_id = cm.user_id AND wm.revoked_at IS NULL
          AND (wm.expires_at IS NULL OR wm.expires_at > now())
        WHERE cm.conversation_id = $1 AND cm.removed_at IS NULL`,
      [parentId, a.workspaceId],
    )).rows as { user_id: string; org_id: string | null; role: string }[];
    let ids: string[];
    let kind: 'group' | 'internal' = 'group';
    let level: string | null = parent.level ?? 'operativo';
    let internalOrgId: string | null = null;
    if (input.kind === 'same') ids = members.map((x) => x.user_id);
    else if (input.kind === 'internal') {
      if (!wa.orgId) throw badRequest('No perteneces a una empresa en este espacio');
      kind = 'internal'; level = null; internalOrgId = wa.orgId;
      ids = members.filter((x) => x.org_id === wa.orgId).map((x) => x.user_id);
    } else {
      level = 'directivo';
      const leads = (await c.query("SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND role IN ('lead','admin') AND revoked_at IS NULL", [a.workspaceId])).rows.map((r) => r.user_id);
      ids = [userId, m.author_id, ...leads];
    }
    ids = [...new Set([userId, ...ids])];
    await ensureNotBlocked(c, userId, ids.filter((id) => id !== userId));

    const excerpt = String(m.body).replace(/\s+/g, ' ').trim().slice(0, 80);
    const prefix = input.kind === 'internal' ? 'Diagnóstico' : input.kind === 'directive' ? 'Decisión' : 'Derivada';
    const name = input.name ?? `${prefix} · ${excerpt.slice(0, 40).replace(/\s+\S*$/, '')}`;
    const conv = await c.query(
      `INSERT INTO conversations (workspace_id, kind, level, name, internal_org_id, created_by, parent_conversation_id, parent_message_id, derive_kind, derive_reason, derived_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$6) RETURNING id`,
      [a.workspaceId, kind, level, name, internalOrgId, userId, parentId, m.id, input.kind, input.reason ?? null],
    );
    const childId: string = conv.rows[0].id;
    await addConversationMembers(c, childId, [userId], userId, 'all', true);
    const others = ids.filter((x) => x !== userId);
    if (others.length) await addConversationMembers(c, childId, others, userId, 'all');
    await appendMessage(c, { conversationId: childId, authorId: userId, kind: 'system', body: sys('derived.here', { parent: parent.name, excerpt, reason: input.reason ?? null }) });
    await appendMessage(c, { conversationId: parentId, authorId: userId, kind: 'system', body: sys('derived.from', { kind: input.kind, childId, messageId: m.id }) });
    await audit(c, userId, 'conversation.derived', { type: 'conversation', id: childId, workspaceId: a.workspaceId }, { parentId, kind: input.kind });
    return { id: childId };
  });
}

/** Devuelve el resultado de una derivada a su origen: publica el cierre allí y marca el reencuentro. */
export async function returnResult(userId: string, childId: string, summary: string) {
  return tx(async (c) => {
    await conversationAccess(c, userId, childId, 'post', true);
    const { rows } = await c.query('SELECT name, parent_conversation_id, returned_at, derive_kind FROM conversations WHERE id = $1', [childId]);
    const child = rows[0];
    if (!child?.parent_conversation_id) throw badRequest('Esta conversación no se derivó de otra');
    if (child.returned_at) throw conflict('Esta derivada ya devolvió su resultado');
    // Quien devuelve también debe poder escribir en el origen.
    await conversationAccess(c, userId, child.parent_conversation_id, 'post', true);
    const msg = await appendMessage(c, { conversationId: child.parent_conversation_id, authorId: userId, body: summary, mergedFrom: childId });
    if (child.derive_kind) {
      // El origen sabe de qué tipo vino (p. ej. «Desde un sidechat») aunque no pueda abrir la conversación.
      const { rows: up } = await c.query('UPDATE messages SET merged_kind = $2 WHERE id = $1 RETURNING *', [msg.id, child.derive_kind]);
      const message = toMessageDTO(up[0]);
      await appendEvent(c, child.parent_conversation_id, { type: 'message.updated', conversationId: child.parent_conversation_id, message }, msg.id);
    }
    await c.query('UPDATE conversations SET returned_at = now(), returned_message_id = $2 WHERE id = $1', [childId, msg.id]);
    await appendMessage(c, { conversationId: childId, authorId: userId, kind: 'system', body: sys('returned', {}) });
    const members = (await c.query('SELECT user_id FROM conversation_memberships WHERE conversation_id = ANY($1) AND removed_at IS NULL', [[childId, child.parent_conversation_id]])).rows.map((r) => r.user_id);
    await scopeChanged(c, [...new Set(members)], 'conversation.returned');
    await audit(c, userId, 'conversation.returned', { type: 'conversation', id: childId }, { parentId: child.parent_conversation_id });
    return { parentId: child.parent_conversation_id as string, messageId: msg.id };
  });
}

// ---------- Conversaciones laterales ----------
const sideOutsider = (userIds: string[]) =>
  new ApiError(403, 'side_outsider', 'Solo puedes sumar a participantes de la conversación de origen o a colegas de tu empresa', { userIds });

/** Recorta un extracto a un límite sin cortar la última palabra (si hace falta recortar). */
function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max).replace(/\s+\S*$/, '');
  return `${cut || text.slice(0, max)}…`;
}

/**
 * Quién puede entrar a una lateral: participantes del origen que ven el mensaje ancla
 * y colegas de mis empresas. Nadie más, para que el contenido no pase a otra empresa.
 */
async function sideAudience(c: Tx, actorId: string, parentId: string | null, anchorId: string | null, ids: string[]) {
  const anchorSeq = anchorId ? (await c.query('SELECT seq FROM messages WHERE id = $1', [anchorId])).rows[0]?.seq ?? null : null;
  const { rows } = await c.query(
    `SELECT u.id, EXISTS (SELECT 1 FROM organization_memberships a JOIN organization_memberships b ON b.org_id = a.org_id
                           WHERE a.user_id = $1 AND b.user_id = u.id) AS colleague
       FROM users u WHERE u.id = ANY($2) AND u.disabled_at IS NULL`,
    [actorId, ids],
  );
  const known = new Map(rows.map((r) => [r.id as string, r.colleague as boolean]));
  const readsOrigin = new Set<string>();
  const outsiders: string[] = [];
  for (const id of ids) {
    let inOrigin = false;
    if (parentId && known.has(id)) {
      try {
        const acc = await conversationAccess(c, id, parentId, 'read');
        inOrigin = anchorSeq === null || anchorSeq > acc.historyFromSeq;
      } catch { inOrigin = false; }
    }
    if (inOrigin) readsOrigin.add(id);
    if (!inOrigin && !known.get(id)) outsiders.push(id);
  }
  return { outsiders, readsOrigin };
}

/**
 * Abre una conversación lateral desde un mensaje: un chat multi privado con
 * parentId/parentMessageId del origen y deriveKind 'side'. En el origen no se
 * publica nada; solo sus miembros la ven (y su cliente pinta el chip bajo el ancla).
 */
export async function createSideConversation(userId: string, parentId: string, input: { messageId: string; userIds: string[]; question?: string }) {
  return tx(async (c) => {
    const a = await conversationAccess(c, userId, parentId, 'read', true);
    const { rows: mr } = await c.query(
      'SELECT m.id, m.author_id, m.body, m.kind, m.seq, m.deleted_at, u.name AS author_name FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = $1 AND m.conversation_id = $2',
      [input.messageId, parentId],
    );
    const m = mr[0];
    if (!m || m.seq <= a.historyFromSeq || m.kind !== 'text' || m.deleted_at) throw badRequest('Solo se abre una lateral desde un mensaje visible de esta conversación');
    const others = [...new Set(input.userIds)].filter((u) => u !== userId);
    if (!others.length) throw badRequest('Elige al menos a una persona');
    await ensureNotBlocked(c, userId, others);
    const { outsiders, readsOrigin } = await sideAudience(c, userId, parentId, m.id, others);
    if (outsiders.length) throw sideOutsider(outsiders);

    const parent = (await c.query('SELECT name FROM conversations WHERE id = $1', [parentId])).rows[0];
    const excerpt = clip(String(m.body).replace(/\s+/g, ' ').trim(), 80);
    const name = `Sidechat · ${clip(excerpt.replace(/…$/, ''), 40)}`;
    const { rows } = await c.query(
      `INSERT INTO conversations (kind, name, created_by, parent_conversation_id, parent_message_id, derive_kind, derived_by)
       VALUES ('multi', $1, $2, $3, $4, 'side', $2) RETURNING id`,
      [name, userId, parentId, m.id],
    );
    const id: string = rows[0].id;
    // Como en los chats grupales: todos pueden sumar a alguien más (con la misma regla de la lateral).
    await c.query('INSERT INTO conversation_memberships (conversation_id, user_id, can_manage, added_by) VALUES ($1,$2,true,$2)', [id, userId]);
    for (const uid of others) await c.query('INSERT INTO conversation_memberships (conversation_id, user_id, can_manage, added_by) VALUES ($1,$2,true,$3)', [id, uid, userId]);
    // El nombre del origen solo se muestra si todos los de la lateral pueden leerlo.
    const everyoneReads = others.every((u) => readsOrigin.has(u));
    await appendMessage(c, { conversationId: id, authorId: userId, kind: 'system', body: sys('side.started', {
      excerpt, authorName: m.author_name, parentName: everyoneReads ? parent?.name ?? null : null, messageId: m.id,
    }) });
    if (input.question) await appendMessage(c, { conversationId: id, authorId: userId, body: input.question });
    await audit(c, userId, 'conversation.side_created', { type: 'conversation', id, workspaceId: a.workspaceId }, { parentId, members: others.length + 1 });
    await scopeChanged(c, [userId, ...others], 'side.created', { conversationId: id });
    return { id };
  });
}

/**
 * Resumen sugerido para «Llevar al hilo» un sidechat. Con DeepSeek: redactado con autor y contexto;
 * sin llave (o si falla): las últimas respuestas de los demás. No publica nada.
 */
export async function suggestSideReturn(userId: string, sideId: string, lang: 'es' | 'en', aiConsent = false) {
  await conversationAccess(pool, userId, sideId, 'post');
  const { rows } = await pool.query(
    `SELECT c.parent_conversation_id, c.parent_message_id, c.derive_kind, p.name AS parent_name, am.body AS anchor_body, am.deleted_at AS anchor_deleted, au.name AS anchor_author
       FROM conversations c LEFT JOIN conversations p ON p.id = c.parent_conversation_id
       LEFT JOIN messages am ON am.id = c.parent_message_id LEFT JOIN users au ON au.id = am.author_id WHERE c.id = $1`,
    [sideId],
  );
  const side = rows[0];
  if (!side?.parent_conversation_id) throw badRequest('Esta conversación no se derivó de otra');
  const me = (await pool.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]?.name ?? '';
  const msgs = (await pool.query(
    `SELECT m.author_id, m.body, u.name FROM messages m JOIN users u ON u.id = m.author_id
      WHERE m.conversation_id = $1 AND m.kind = 'text' AND m.deleted_at IS NULL AND m.body <> '' ORDER BY m.seq DESC LIMIT 40`,
    [sideId],
  )).rows.reverse();
  const fallback = () => {
    const replies = msgs.filter((m) => m.author_id !== userId).slice(-3);
    const pick = replies.length ? replies : msgs.slice(-3);
    return pick.map((m) => (pick.every((x) => x.author_id === pick[0]!.author_id) ? m.body : `${m.name}: ${m.body}`)).join('\n').slice(0, 4000);
  };
  const ai = aiConsent ? getSummarizer() : null;
  if (ai?.suggestSideReturn && msgs.length) {
    try {
      const summary = await ai.suggestSideReturn({
        language: lang, publisherName: me, originName: side.parent_name ?? null,
        anchor: { authorName: side.anchor_author ?? '', text: side.anchor_deleted ? '' : String(side.anchor_body ?? '') },
        messages: msgs.map((m) => ({ authorName: m.name, text: m.body })),
      });
      if (summary) return { summary, source: 'ai' as const };
    } catch (e: any) { console.error('[side] resumen sugerido', e?.message); }
  }
  return { summary: fallback(), source: 'fallback' as const };
}
