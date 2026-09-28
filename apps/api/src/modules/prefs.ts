import { conversationAccess, workspaceAccess } from '../access.ts';
import { enqueueOutbox, pool, tx } from '../db.ts';

/** Fijar y silenciar son preferencias personales: solo cambian la vista de quien las pone. */
export async function setConversationPrefs(userId: string, conversationId: string, input: { pinned?: boolean; mutedUntil?: string | null; linkPreviews?: 'large' | 'compact' | 'none' }) {
  return tx(async (c) => {
    await conversationAccess(c, userId, conversationId, 'read');
    await c.query(
      `INSERT INTO conversation_prefs (user_id, conversation_id, pinned_at, muted_until, link_previews) VALUES ($1,$2,$3,$4,$7)
       ON CONFLICT (user_id, conversation_id) DO UPDATE SET
         pinned_at = CASE WHEN $5 THEN EXCLUDED.pinned_at ELSE conversation_prefs.pinned_at END,
         muted_until = CASE WHEN $6 THEN EXCLUDED.muted_until ELSE conversation_prefs.muted_until END,
         link_previews = COALESCE(EXCLUDED.link_previews, conversation_prefs.link_previews),
         updated_at = now()`,
      [userId, conversationId, input.pinned ? new Date() : null, input.mutedUntil ?? null, input.pinned !== undefined, input.mutedUntil !== undefined, input.linkPreviews ?? null],
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

/** ISO de «No molestar» vigente, o null si está apagado o ya pasó. */
export const activeDnd = (v: Date | string | null | undefined): string | null =>
  v && new Date(v).getTime() > Date.now() ? new Date(v).toISOString() : null;

export async function getDnd(userId: string): Promise<string | null> {
  const { rows } = await pool.query('SELECT dnd_until FROM users WHERE id = $1', [userId]);
  return activeDnd(rows[0]?.dnd_until);
}

/**
 * «No molestar» (silenciar todo): hasta `until` no llega ningún push a esta persona; los no leídos
 * se cuentan igual. «Hasta que lo reactive» = 9999-12-31T00:00:00Z. null o una fecha pasada lo apagan.
 * Avisa a todas mis sesiones con `me.dnd`.
 */
export async function setDnd(userId: string, until: string | null) {
  const value = activeDnd(until);
  return tx(async (c) => {
    await c.query('UPDATE users SET dnd_until = $2 WHERE id = $1', [userId, value]);
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'me.dnd', dndUntil: value } });
    return { dndUntil: value };
  });
}
