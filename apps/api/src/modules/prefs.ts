import { conversationAccess, workspaceAccess } from '../access.ts';
import type { z } from 'zod';
import type { SleepDTO, SleepInput } from '@tiecoms/contracts';
import { enqueueOutbox, pool, tx } from '../db.ts';
import { badRequest } from '../errors.ts';

/** Fijar y silenciar son preferencias personales: solo cambian la vista de quien las pone. */
export async function setConversationPrefs(userId: string, conversationId: string, input: { pinned?: boolean; mutedUntil?: string | null; linkPreviews?: 'large' | 'compact' | 'none'; sound?: string | null }) {
  return tx(async (c) => {
    await conversationAccess(c, userId, conversationId, 'read');
    await c.query(
      `INSERT INTO conversation_prefs (user_id, conversation_id, pinned_at, muted_until, link_previews, sound) VALUES ($1,$2,$3,$4,$7,$8)
       ON CONFLICT (user_id, conversation_id) DO UPDATE SET
         pinned_at = CASE WHEN $5 THEN EXCLUDED.pinned_at ELSE conversation_prefs.pinned_at END,
         muted_until = CASE WHEN $6 THEN EXCLUDED.muted_until ELSE conversation_prefs.muted_until END,
         link_previews = COALESCE(EXCLUDED.link_previews, conversation_prefs.link_previews),
         sound = CASE WHEN $9 THEN EXCLUDED.sound ELSE conversation_prefs.sound END,
         updated_at = now()`,
      [userId, conversationId, input.pinned ? new Date() : null, input.mutedUntil ?? null, input.pinned !== undefined, input.mutedUntil !== undefined, input.linkPreviews ?? null, input.sound ?? null, input.sound !== undefined],
    );
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'prefs.updated', conversationId } });
    return { ok: true };
  });
}

/** Sonido predeterminado de los chats y tono de llamada de la persona (en todos sus dispositivos). */
export async function setSounds(userId: string, input: { messageSound?: string | null; ringtone?: string | null }) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE users SET message_sound = CASE WHEN $2 THEN $3 ELSE message_sound END, ringtone = CASE WHEN $4 THEN $5 ELSE ringtone END
        WHERE id = $1 RETURNING message_sound, ringtone`,
      [userId, input.messageSound !== undefined, input.messageSound ?? null, input.ringtone !== undefined, input.ringtone ?? null],
    );
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'prefs.updated' } });
    return { messageSound: rows[0].message_sound, ringtone: rows[0].ringtone };
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

const hhmm = (t: string) => String(t).slice(0, 5);
export const toSleep = (r: any): SleepDTO => ({ on: !!r.sleep_on, start: hhmm(r.sleep_start), end: hhmm(r.sleep_end), tz: r.sleep_tz, tzAuto: !!r.sleep_tz_auto });

/**
 * Modo sueño: horario diario sin sonidos, en la zona horaria de la persona. La zona se valida contra
 * las de PostgreSQL. Si llega `tz` sin `tzAuto`, la persona la fijó a mano (ya no se ajusta sola).
 */
export async function setSleep(userId: string, input: z.infer<typeof SleepInput>) {
  if (input.tz) {
    const ok = await pool.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [input.tz]);
    if (!ok.rowCount) throw badRequest('Zona horaria desconocida');
  }
  return tx(async (c) => {
    const tzAuto = input.tzAuto ?? (input.tz ? false : undefined);
    const { rows } = await c.query(
      `UPDATE users SET sleep_on = COALESCE($2, sleep_on), sleep_start = COALESCE($3::time, sleep_start), sleep_end = COALESCE($4::time, sleep_end),
              sleep_tz = COALESCE($5, sleep_tz), sleep_tz_auto = COALESCE($6, sleep_tz_auto)
        WHERE id = $1 RETURNING sleep_on, sleep_start, sleep_end, sleep_tz, sleep_tz_auto`,
      [userId, input.on ?? null, input.start ?? null, input.end ?? null, input.tz ?? null, tzAuto ?? null],
    );
    const sleep = toSleep(rows[0]);
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'me.sleep', sleep } });
    return { sleep };
  });
}
