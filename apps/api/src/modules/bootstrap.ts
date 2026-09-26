import { CONTRACT_VERSION, type BootstrapDTO, type ConversationDTO, type OrganizationDTO, type PersonDTO, type WorkspaceDTO } from '@tiecoms/contracts';
import { pool } from '../db.ts';
import { loadUser } from './auth.ts';
import { orgVerification } from './domains.ts';
import { summarize } from './attachments.ts';

const ACTIVE_WM = `wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at > now())`;

/**
 * Snapshot autorizado de la cuenta: todo lo que el cliente necesita para
 * dibujar la barra lateral y reconciliar tras una desconexión larga.
 * Nada fuera del alcance de la persona sale de aquí (ni nombres de grupos).
 */
export async function bootstrap(userId: string): Promise<BootstrapDTO> {
  const me = await loadUser(pool, userId);
  const digest = await pool.query('SELECT link_digest FROM users WHERE id = $1', [userId]);
  me.linkDigest = !!digest.rows[0]?.link_digest;

  const [ws, convs, people] = await Promise.all([
    pool.query(
      `SELECT w.id, w.name, w.department, w.glyph, w.owning_org_id, w.created_at, wm.role, w.is_org_home, w.counterpart_name,
              (SELECT wp.pinned_at FROM workspace_prefs wp WHERE wp.workspace_id = w.id AND wp.user_id = wm.user_id) AS pinned_at,
              ARRAY(SELECT org_id FROM workspace_organizations wo WHERE wo.workspace_id = w.id AND wo.left_at IS NULL ORDER BY wo.joined_at) AS org_ids,
              CASE WHEN wm.role = 'guest' THEN '{}'::uuid[] ELSE ARRAY(SELECT o.user_id FROM workspace_memberships o WHERE o.workspace_id = w.id
                AND o.revoked_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > now()) ORDER BY o.joined_at) END AS member_ids
         FROM workspace_memberships wm JOIN workspaces w ON w.id = wm.workspace_id
        WHERE wm.user_id = $1 AND ${ACTIVE_WM} AND w.archived_at IS NULL
        ORDER BY w.created_at`,
      [userId],
    ),
    pool.query(
      `SELECT c.id, c.workspace_id, c.kind, c.level, c.name, c.internal_org_id, c.last_message_seq, c.last_event_seq, c.last_message_at,
              c.parent_conversation_id, c.parent_message_id, (SELECT pm.seq FROM messages pm WHERE pm.id = c.parent_message_id) AS parent_message_seq, c.derive_kind, c.derive_reason, c.returned_at, c.avatar_file_id,
              (SELECT count(*) FROM issues i WHERE i.conversation_id = c.id AND i.status NOT IN ('done','cancelled'))::int AS open_issues,
              (SELECT count(*) FROM message_mentions mm WHERE mm.user_id = m.user_id AND mm.conversation_id = c.id
                  AND mm.seq > GREATEST(COALESCE(rc.last_read_seq, 0), m.history_from_seq))::int AS unread_mentions,
              m.can_post, m.can_manage, m.history_from_seq, wm.role AS workspace_role, cp.pinned_at, cp.muted_until, cp.link_previews,
              (SELECT count(*) FROM message_links ml WHERE ml.conversation_id = c.id AND ml.seq > m.history_from_seq)::int AS link_count,
              COALESCE(rc.last_read_seq, 0) AS last_read_seq,
              ARRAY(SELECT user_id FROM conversation_memberships x WHERE x.conversation_id = c.id AND x.removed_at IS NULL ORDER BY x.joined_at) AS member_ids,
              (SELECT CASE WHEN lm.deleted_at IS NULL THEN left(lm.body, 140) ELSE '' END FROM messages lm
                WHERE lm.conversation_id = c.id AND lm.seq = c.last_message_seq AND lm.seq > m.history_from_seq) AS preview,
              (SELECT lm.attachments FROM messages lm
                WHERE lm.conversation_id = c.id AND lm.seq = c.last_message_seq AND lm.seq > m.history_from_seq AND lm.deleted_at IS NULL) AS preview_attachments,
              -- Último mensaje de una persona (o agente) entre los últimos 20 visibles, aunque después haya avisos de sistema.
              (SELECT json_build_object('id', hm.id, 'seq', hm.seq, 'authorId', hm.author_id, 'body', left(hm.body, 140), 'attachments', hm.attachments, 'createdAt', hm.created_at)
                 FROM messages hm WHERE hm.conversation_id = c.id AND hm.kind = 'text' AND hm.deleted_at IS NULL
                  AND hm.seq > GREATEST(m.history_from_seq, c.last_message_seq - 20)
                ORDER BY hm.seq DESC LIMIT 1) AS human
         FROM conversation_memberships m
         JOIN conversations c ON c.id = m.conversation_id AND c.archived_at IS NULL
         LEFT JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id AND wm.user_id = m.user_id
         LEFT JOIN read_cursors rc ON rc.conversation_id = c.id AND rc.user_id = m.user_id
         LEFT JOIN conversation_prefs cp ON cp.conversation_id = c.id AND cp.user_id = m.user_id
        WHERE m.user_id = $1 AND m.removed_at IS NULL
          AND (c.workspace_id IS NULL OR (wm.user_id IS NOT NULL AND ${ACTIVE_WM}))
        ORDER BY c.last_message_at DESC NULLS LAST`,
      [userId],
    ),
    // Directorio: quienes comparten un grupo conmigo y, si no soy tercero, todo el espacio.
    pool.query(
      `WITH visible AS (
         SELECT DISTINCT other.user_id FROM conversation_memberships mine
           JOIN conversation_memberships other ON other.conversation_id = mine.conversation_id AND other.removed_at IS NULL
          WHERE mine.user_id = $1 AND mine.removed_at IS NULL
         UNION
         SELECT DISTINCT o.user_id FROM workspace_memberships wm
           JOIN workspace_memberships o ON o.workspace_id = wm.workspace_id AND o.revoked_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > now())
          WHERE wm.user_id = $1 AND wm.role <> 'guest' AND ${ACTIVE_WM}
         UNION
         -- Colegas de mis empresas.
         SELECT DISTINCT o.user_id FROM organization_memberships mine
           JOIN organization_memberships o ON o.org_id = mine.org_id
          WHERE mine.user_id = $1
         UNION SELECT $1::uuid
       )
       SELECT u.id, u.name, u.kind, u.primary_org_id, u.avatar_file_id, om.title, om.area,
              (SELECT bool_and(g.role = 'guest') FROM workspace_memberships g WHERE g.user_id = u.id AND g.revoked_at IS NULL) AS guest,
              (SELECT max(g.expires_at) FROM workspace_memberships g WHERE g.user_id = u.id AND g.role = 'guest' AND g.revoked_at IS NULL) AS guest_until
         FROM visible v JOIN users u ON u.id = v.user_id AND u.disabled_at IS NULL
         LEFT JOIN organization_memberships om ON om.user_id = u.id AND om.org_id = u.primary_org_id
        ORDER BY u.name`,
      [userId],
    ),
  ]);

  const workspaces: WorkspaceDTO[] = ws.rows.map((r) => ({
    id: r.id, name: r.name, department: r.department, glyph: r.glyph, owningOrgId: r.owning_org_id,
    organizationIds: r.org_ids, memberIds: r.member_ids, myRole: r.role, createdAt: new Date(r.created_at).toISOString(),
    pinnedAt: r.pinned_at ? new Date(r.pinned_at).toISOString() : null,
    isOrgHome: r.is_org_home, counterpartName: r.counterpart_name,
  }));

  const conversations: ConversationDTO[] = convs.rows.map((r) => {
    const readFrom = Math.max(r.last_read_seq, r.history_from_seq);
    return {
      id: r.id, workspaceId: r.workspace_id, kind: r.kind, level: r.level, name: r.name, internalOrgId: r.internal_org_id,
      memberIds: r.member_ids, lastMessageSeq: r.last_message_seq, lastEventSeq: r.last_event_seq,
      lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
      // Clientes viejos: un mensaje solo con adjuntos muestra un ícono en vez de quedar vacío.
      lastMessagePreview: r.preview === '' && r.preview_attachments?.length ? legacyAttachmentPreview(r.preview_attachments) : r.preview,
      lastReadSeq: r.last_read_seq,
      unread: Math.max(0, r.last_message_seq - readFrom),
      canPost: r.can_post, canManage: r.can_manage || ['lead', 'admin'].includes(r.workspace_role),
      historyFromSeq: r.history_from_seq,
      parentId: r.parent_conversation_id, parentMessageId: r.parent_message_id, parentMessageSeq: r.parent_message_seq ?? null, deriveKind: r.derive_kind,
      deriveReason: r.derive_reason, returnedAt: r.returned_at ? new Date(r.returned_at).toISOString() : null,
      openIssues: r.open_issues,
      pinnedAt: r.pinned_at ? new Date(r.pinned_at).toISOString() : null,
      mutedUntil: r.muted_until && new Date(r.muted_until) > new Date() ? new Date(r.muted_until).toISOString() : null,
      avatarUrl: r.avatar_file_id ? `/api/v1/avatars/${r.avatar_file_id}` : null,
      unreadMentions: r.unread_mentions ?? 0,
      ...(r.link_previews ? { linkPreviews: r.link_previews } : {}),
      linkCount: r.link_count ?? 0,
      lastHumanPreview: r.human ? {
        messageId: r.human.id, seq: Number(r.human.seq), authorId: r.human.authorId, body: r.human.body ?? '',
        attachments: summarize(r.human.attachments), createdAt: new Date(r.human.createdAt).toISOString(),
      } : null,
    };
  });

  const personList: PersonDTO[] = people.rows.map((r) => ({
    id: r.id, name: r.name, kind: r.kind, orgId: r.guest ? null : r.primary_org_id, title: r.title, area: r.area,
    guest: Boolean(r.guest), guestUntil: r.guest_until ? new Date(r.guest_until).toISOString() : null,
    avatarUrl: r.avatar_file_id ? `/api/v1/avatars/${r.avatar_file_id}` : null,
  }));

  const orgIds = new Set<string>();
  workspaces.forEach((w) => w.organizationIds.forEach((o) => orgIds.add(o)));
  personList.forEach((p) => p.orgId && orgIds.add(p.orgId));
  if (me.primaryOrgId) orgIds.add(me.primaryOrgId);
  const orgs = await pool.query(
    `SELECT o.id, o.name, o.mark, o.color_bg, o.color_fg, o.join_policy, o.reaction_actions, om.role AS my_role FROM organizations o
       LEFT JOIN organization_memberships om ON om.org_id = o.id AND om.user_id = $2 WHERE o.id = ANY($1) ORDER BY o.name`,
    [[...orgIds], userId],
  );
  const verified = await orgVerification(pool, [...orgIds]);
  const organizations: OrganizationDTO[] = orgs.rows.map((r) => ({
    id: r.id, name: r.name, mark: r.mark, colorBg: r.color_bg, colorFg: r.color_fg, ...(r.my_role ? { myRole: r.my_role } : {}),
    verification: verified.get(r.id)?.level ?? 'none', verifiedDomain: verified.get(r.id)?.domain ?? null,
    ...(['owner', 'admin'].includes(r.my_role) ? { joinPolicy: r.join_policy } : {}),
    ...(r.my_role ? { reactionActions: r.reaction_actions } : {}),
  }));

  return { contract: CONTRACT_VERSION, serverTime: new Date().toISOString(), me, organizations, workspaces, conversations, people: personList };
}

function legacyAttachmentPreview(list: { contentType: string; name: string }[]) {
  const s = summarize(list as any)!;
  if (s.voices && s.voices === s.count) return '🎤';
  if (s.images === s.count) return s.count === 1 ? '📷' : `📷 ×${s.count}`;
  if (s.videos === s.count) return s.count === 1 ? '🎬' : `🎬 ×${s.count}`;
  return s.count === 1 ? `📎 ${s.firstName ?? ''}`.trim() : `📎 ×${s.count}`;
}
