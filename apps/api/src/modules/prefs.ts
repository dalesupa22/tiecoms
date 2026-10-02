import { conversationAccess, workspaceAccess } from '../access.ts';
import type { z } from 'zod';
import type { AvailabilityDTO, AvailabilityMode, SleepDTO, SleepInput } from '@tiecoms/contracts';
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
    await c.query('UPDATE users SET dnd_until = $2, availability_revision=availability_revision+1 WHERE id = $1', [userId, value]);
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'me.dnd', dndUntil: value } });
    await publishAvailability(c, userId);
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
              sleep_tz = COALESCE($5, sleep_tz), sleep_tz_auto = COALESCE($6, sleep_tz_auto), availability_revision=availability_revision+1
        WHERE id = $1 RETURNING sleep_on, sleep_start, sleep_end, sleep_tz, sleep_tz_auto`,
      [userId, input.on ?? null, input.start ?? null, input.end ?? null, input.tz ?? null, tzAuto ?? null],
    );
    const sleep = toSleep(rows[0]);
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'me.sleep', sleep } });
    await publishAvailability(c, userId);
    return { sleep };
  });
}

/** Public effective state only; schedules/reasons remain private. */
export function effectiveAvailability(r: any): AvailabilityDTO {
  const manualActive = !!r.availability_mode && (!r.availability_until || new Date(r.availability_until).getTime() > Date.now());
  const manualSilent = manualActive && ['focus','dnd','rest'].includes(r.availability_mode);
  const dnd = activeDnd(r.dnd_until);
  const manualUntil = manualActive && r.availability_until ? new Date(r.availability_until).toISOString() : null;
  if (dnd) return { mode: manualSilent && manualUntil === dnd ? r.availability_mode : 'dnd', until: dnd, silent: true, revision: Number(r.availability_revision ?? 0) };
  if (manualSilent) return { mode: r.availability_mode, until: manualUntil, silent: true, revision: Number(r.availability_revision ?? 0) };
  if (r.sleeping) return { mode: 'rest', until: r.sleep_until ? new Date(r.sleep_until).toISOString() : null, silent: true, revision: Number(r.availability_revision ?? 0) };
  return { mode: manualActive ? r.availability_mode : null, until: manualUntil, silent: false, revision: Number(r.availability_revision ?? 0) };
}

export const AVAILABILITY_SQL = `u.availability_mode,u.availability_until,u.availability_revision,u.dnd_until,
  tiecoms_sleeping(u.sleep_on,u.sleep_start,u.sleep_end,u.sleep_tz) AS sleeping,
  (((now() AT TIME ZONE u.sleep_tz)::date + u.sleep_end + CASE WHEN u.sleep_end <= (now() AT TIME ZONE u.sleep_tz)::time THEN interval '1 day' ELSE interval '0 day' END) AT TIME ZONE u.sleep_tz) AS sleep_until`;

async function publishAvailability(c: import('../db.ts').Tx, userId: string) {
  const state = (await c.query(`SELECT ${AVAILABILITY_SQL} FROM users u WHERE u.id=$1`, [userId])).rows[0];
  await c.query('UPDATE users SET availability_sleeping=$2 WHERE id=$1',[userId,state.sleeping]);
  // Inverse of the bootstrap directory visibility, including non-reciprocal guest scopes.
  const audience = await c.query(`SELECT DISTINCT u.id FROM users u WHERE u.disabled_at IS NULL AND (u.id=$1 OR
    EXISTS (SELECT 1 FROM conversation_memberships mine JOIN conversation_memberships other ON other.conversation_id=mine.conversation_id
      JOIN conversations chat ON chat.id=mine.conversation_id AND chat.archived_at IS NULL
      LEFT JOIN workspace_memberships wm ON wm.workspace_id=chat.workspace_id AND wm.user_id=mine.user_id
      LEFT JOIN workspaces w ON w.id=chat.workspace_id AND w.archived_at IS NULL
      WHERE mine.user_id=u.id AND other.user_id=$1 AND mine.removed_at IS NULL AND other.removed_at IS NULL
      AND (chat.workspace_id IS NULL OR (w.id IS NOT NULL AND wm.revoked_at IS NULL AND (wm.expires_at IS NULL OR wm.expires_at>now())))) OR
    EXISTS (SELECT 1 FROM workspace_memberships mine JOIN workspace_memberships other ON other.workspace_id=mine.workspace_id
      JOIN workspaces w ON w.id=mine.workspace_id AND w.archived_at IS NULL
      WHERE mine.user_id=u.id AND other.user_id=$1 AND mine.role<>'guest' AND mine.revoked_at IS NULL AND other.revoked_at IS NULL
      AND (mine.expires_at IS NULL OR mine.expires_at>now()) AND (other.expires_at IS NULL OR other.expires_at>now())) OR
    EXISTS (SELECT 1 FROM organization_memberships mine JOIN organization_memberships other ON other.org_id=mine.org_id WHERE mine.user_id=u.id AND other.user_id=$1))`, [userId]);
  await enqueueOutbox(c, 'account.event', { userIds: audience.rows.map((r) => r.id), event: { type: 'person.availability', userId, availability: effectiveAvailability(state) } });
  return effectiveAvailability(state);
}

export async function setAvailability(userId: string, input: { mode: AvailabilityMode | null; until?: string | null }) {
  const silent = input.mode !== null && ['focus','dnd','rest'].includes(input.mode);
  const until = input.until ? activeDnd(input.until) : null;
  if(input.until && !until) throw badRequest('Elige una duración futura');
  if (silent && !until) throw badRequest('Elige una duración futura para el modo silencioso');
  return tx(async (c) => {
    await c.query(`UPDATE users SET
      dnd_until=CASE WHEN $4 THEN $3::timestamptz WHEN availability_mode IN ('focus','dnd','rest') AND dnd_until=availability_until AND NOT $4 THEN NULL ELSE dnd_until END,
      availability_mode=$2, availability_until=$3, availability_revision=availability_revision+1 WHERE id=$1`, [userId,input.mode,until,silent]);
    const state = await publishAvailability(c,userId);
    const dnd = (await c.query('SELECT dnd_until FROM users WHERE id=$1',[userId])).rows[0];
    await enqueueOutbox(c,'account.event',{userIds:[userId],event:{type:'me.dnd',dndUntil:activeDnd(dnd.dnd_until)}});
    return { availability: state };
  });
}

/** One minute worker sweep: only changed deadlines/sleep boundaries fan out; server remains authoritative. */
export async function expireAvailability() {
  return tx(async c=>{
    const candidates=await c.query(`SELECT u.id FROM users u WHERE disabled_at IS NULL AND
      ((availability_mode IS NOT NULL AND availability_until<=now()) OR dnd_until<=now()
       OR (sleep_on AND tiecoms_sleeping(sleep_on,sleep_start,sleep_end,sleep_tz) IS DISTINCT FROM availability_sleeping)
       OR (NOT sleep_on AND availability_sleeping IS TRUE)) ORDER BY u.id LIMIT 1000 FOR UPDATE SKIP LOCKED`);
    for(const {id} of candidates.rows) {
      await c.query(`UPDATE users SET availability_mode=CASE WHEN availability_until<=now() THEN NULL ELSE availability_mode END,
        availability_until=CASE WHEN availability_until<=now() THEN NULL ELSE availability_until END,
        dnd_until=CASE WHEN dnd_until<=now() THEN NULL ELSE dnd_until END,availability_revision=availability_revision+1 WHERE id=$1`,[id]);
      await publishAvailability(c,id);
      const row=(await c.query('SELECT dnd_until FROM users WHERE id=$1',[id])).rows[0];
      await enqueueOutbox(c,'account.event',{userIds:[id],event:{type:'me.dnd',dndUntil:activeDnd(row.dnd_until)}});
    }
    return candidates.rowCount ?? 0;
  });
}
