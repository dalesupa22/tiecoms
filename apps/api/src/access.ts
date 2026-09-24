import type { Db } from './db.ts';
import { forbidden, notFound } from './errors.ts';
import { ensureNotBlocked } from './modules/safety.ts';

export interface ConversationAccess {
  id: string;
  kind: 'group' | 'internal' | 'direct' | 'multi';
  workspaceId: string | null;
  internalOrgId: string | null;
  lastMessageSeq: number;
  lastEventSeq: number;
  canPost: boolean;
  canManage: boolean;
  historyFromSeq: number;
  workspaceRole: string | null;
}

/**
 * Único punto de autorización para conversaciones. Comprueba membresía activa
 * en la conversación y, si pertenece a un espacio, que la membresía del
 * espacio no esté revocada ni vencida (terceros). Se usa en HTTP, sockets y
 * sincronización. `lock` bloquea la fila de la conversación para asignar seq.
 */
export async function conversationAccess(
  db: Db, userId: string, conversationId: string, need: 'read' | 'post' | 'manage', lock = false,
): Promise<ConversationAccess> {
  const { rows } = await db.query(
    `SELECT c.id, c.kind, c.workspace_id, c.internal_org_id, c.last_message_seq, c.last_event_seq,
            m.can_post, m.can_manage, m.history_from_seq, wm.role AS workspace_role
       FROM conversations c
       JOIN conversation_memberships m
         ON m.conversation_id = c.id AND m.user_id = $2 AND m.removed_at IS NULL
       JOIN users actor ON actor.id = m.user_id AND actor.disabled_at IS NULL
       LEFT JOIN workspace_memberships wm
         ON wm.workspace_id = c.workspace_id AND wm.user_id = $2
      WHERE c.id = $1 AND c.archived_at IS NULL
        AND (c.workspace_id IS NULL OR (wm.user_id IS NOT NULL AND wm.revoked_at IS NULL
             AND (wm.expires_at IS NULL OR wm.expires_at > now())))
      ${lock ? 'FOR UPDATE OF c' : ''}`,
    [conversationId, userId],
  );
  const r = rows[0];
  if (!r) throw notFound('Conversación');
  const a: ConversationAccess = {
    id: r.id, kind: r.kind, workspaceId: r.workspace_id, internalOrgId: r.internal_org_id,
    lastMessageSeq: r.last_message_seq, lastEventSeq: r.last_event_seq,
    canPost: r.can_post, canManage: r.can_manage || ['lead', 'admin'].includes(r.workspace_role),
    historyFromSeq: r.history_from_seq, workspaceRole: r.workspace_role,
  };
  if (need === 'post' && !a.canPost) throw forbidden('No puedes publicar en esta conversación');
  if (need === 'post' && a.kind === 'direct') {
    const peers = await db.query('SELECT user_id FROM conversation_memberships WHERE conversation_id = $1 AND user_id <> $2 AND removed_at IS NULL', [conversationId, userId]);
    await ensureNotBlocked(db, userId, peers.rows.map((p) => p.user_id as string));
  }
  if (need === 'manage' && !a.canManage) throw forbidden('No puedes administrar esta conversación');
  return a;
}

export interface WorkspaceAccess { workspaceId: string; role: string; orgId: string | null }

export async function workspaceAccess(db: Db, userId: string, workspaceId: string, need: 'member' | 'nonguest' | 'admin'): Promise<WorkspaceAccess> {
  const { rows } = await db.query(
    `SELECT wm.role, wm.org_id FROM workspace_memberships wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.workspace_id = $1 AND wm.user_id = $2 AND wm.revoked_at IS NULL
        AND (wm.expires_at IS NULL OR wm.expires_at > now()) AND w.archived_at IS NULL`,
    [workspaceId, userId],
  );
  const r = rows[0];
  if (!r) throw notFound('Espacio');
  if (need === 'nonguest' && r.role === 'guest') throw forbidden('Los terceros invitados no pueden hacer esto');
  if (need === 'admin' && !['lead', 'admin'].includes(r.role)) throw forbidden('Solo quien lidera o administra el espacio');
  return { workspaceId, role: r.role, orgId: r.org_id };
}
