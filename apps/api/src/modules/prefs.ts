import { conversationAccess, workspaceAccess } from '../access.ts';
import { enqueueOutbox, tx } from '../db.ts';

/** Fijar y silenciar son preferencias personales: solo cambian la vista de quien las pone. */
export async function setConversationPrefs(userId: string, conversationId: string, input: { pinned?: boolean; mutedUntil?: string | null }) {
  return tx(async (c) => {
    await conversationAccess(c, userId, conversationId, 'read');
    await c.query(
      `INSERT INTO conversation_prefs (user_id, conversation_id, pinned_at, muted_until) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, conversation_id) DO UPDATE SET
         pinned_at = CASE WHEN $5 THEN EXCLUDED.pinned_at ELSE conversation_prefs.pinned_at END,
         muted_until = CASE WHEN $6 THEN EXCLUDED.muted_until ELSE conversation_prefs.muted_until END,
         updated_at = now()`,
      [userId, conversationId, input.pinned ? new Date() : null, input.mutedUntil ?? null, input.pinned !== undefined, input.mutedUntil !== undefined],
    );
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'prefs.updated', conversationId } });
    return { ok: true };
  });
}

export async function setWorkspacePrefs(userId: string, workspaceId: string, pinned: boolean) {
  return tx(async (c) => {
    await workspaceAccess(c, userId, workspaceId, 'member');
    await c.query(
      `INSERT INTO workspace_prefs (user_id, workspace_id, pinned_at) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, workspace_id) DO UPDATE SET pinned_at = EXCLUDED.pinned_at, updated_at = now()`,
      [userId, workspaceId, pinned ? new Date() : null],
    );
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'prefs.updated', workspaceId } });
    return { ok: true };
  });
}
