import type { z } from 'zod';
import type { CalendarEventDTO, CreateEventInput, UpdateEventInput } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { audit, pool, tx, type Db, type Tx } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { appendEvent, appendMessage } from './messages.ts';

const sys = (k: string, p: Record<string, unknown> = {}) => JSON.stringify({ k, ...p });
const iso = (d: any) => (d ? new Date(d).toISOString() : null);

async function load(db: Db, id: string): Promise<CalendarEventDTO> {
  const { rows } = await db.query(
    `SELECT e.*, COALESCE(json_agg(json_build_object('userId', i.user_id, 'rsvp', i.rsvp)) FILTER (WHERE i.user_id IS NOT NULL), '[]') AS invitees
       FROM calendar_events e LEFT JOIN calendar_event_invitees i ON i.event_id = e.id WHERE e.id = $1 GROUP BY e.id`,
    [id],
  );
  const r = rows[0];
  if (!r) throw notFound('Reunión');
  return {
    id: r.id, workspaceId: r.workspace_id, conversationId: r.conversation_id, originMessageId: r.origin_message_id, title: r.title,
    description: r.description, location: r.location, startsAt: iso(r.starts_at)!, endsAt: iso(r.ends_at)!, timezone: r.timezone,
    organizerId: r.organizer_id, invitees: r.invitees, cancelledAt: iso(r.cancelled_at), updatedAt: iso(r.updated_at)!,
  };
}

const publish = (c: Tx, ev: CalendarEventDTO) => appendEvent(c, ev.conversationId, { type: 'calendar.updated', conversationId: ev.conversationId, event: ev });

function validTz(tz: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Invitados: deben estar en la conversación (su audiencia). Por defecto, todos sus miembros. */
async function inviteeIds(c: Tx, conversationId: string, wanted: string[] | undefined, organizer: string) {
  const { rows } = await c.query('SELECT user_id FROM conversation_memberships WHERE conversation_id = $1 AND removed_at IS NULL', [conversationId]);
  const members = new Set(rows.map((r) => r.user_id as string));
  const ids = wanted ? [...new Set([organizer, ...wanted])] : [...members];
  if (ids.some((id) => !members.has(id))) throw badRequest('Los invitados deben participar en la conversación');
  return ids;
}

export async function createEvent(userId: string, conversationId: string, input: z.infer<typeof CreateEventInput>) {
  if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) throw badRequest('La reunión debe terminar después de empezar');
  if (!validTz(input.timezone)) throw badRequest('Zona horaria inválida');
  return tx(async (c) => {
    const a = await conversationAccess(c, userId, conversationId, 'post', true);
    if (!a.workspaceId) throw badRequest('Las reuniones viven en conversaciones de un espacio');
    const { rows } = await c.query(
      `INSERT INTO calendar_events (workspace_id, conversation_id, origin_message_id, title, description, location, starts_at, ends_at, timezone, organizer_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [a.workspaceId, conversationId, input.originMessageId ?? null, input.title, input.description ?? null, input.location ?? null, input.startsAt, input.endsAt, input.timezone, userId],
    );
    const id: string = rows[0].id;
    for (const uid of await inviteeIds(c, conversationId, input.inviteeIds, userId)) {
      await c.query('INSERT INTO calendar_event_invitees (event_id, user_id, rsvp, responded_at) VALUES ($1,$2,$3,$4)', [id, uid, uid === userId ? 'yes' : 'pending', uid === userId ? new Date() : null]);
    }
    await appendMessage(c, { conversationId, authorId: userId, kind: 'system', body: sys('event.created', { title: input.title, eventId: id, startsAt: input.startsAt, timezone: input.timezone }) });
    const ev = await load(c, id);
    await publish(c, ev);
    await audit(c, userId, 'event.created', { type: 'event', id, workspaceId: a.workspaceId });
    return ev;
  });
}

async function editable(c: Tx, userId: string, id: string) {
  const { rows } = await c.query('SELECT * FROM calendar_events WHERE id = $1 FOR UPDATE', [id]);
  const e = rows[0];
  if (!e) throw notFound('Reunión');
  const a = await conversationAccess(c, userId, e.conversation_id, 'post', true);
  if (e.organizer_id !== userId && !a.canManage) throw forbidden('Solo quien organiza o administra el grupo puede cambiar la reunión');
  return e;
}

export async function updateEvent(userId: string, id: string, input: z.infer<typeof UpdateEventInput>) {
  return tx(async (c) => {
    const e = await editable(c, userId, id);
    const starts = input.startsAt ?? iso(e.starts_at)!, ends = input.endsAt ?? iso(e.ends_at)!;
    if (Date.parse(ends) <= Date.parse(starts)) throw badRequest('La reunión debe terminar después de empezar');
    if (input.timezone && !validTz(input.timezone)) throw badRequest('Zona horaria inválida');
    await c.query(
      `UPDATE calendar_events SET title = COALESCE($2, title), description = CASE WHEN $3 THEN $4 ELSE description END,
         location = CASE WHEN $5 THEN $6 ELSE location END, starts_at = $7, ends_at = $8, timezone = COALESCE($9, timezone), updated_at = now()
       WHERE id = $1`,
      [id, input.title ?? null, input.description !== undefined, input.description ?? null, input.location !== undefined, input.location ?? null, starts, ends, input.timezone ?? null],
    );
    if (input.inviteeIds) {
      const ids = await inviteeIds(c, e.conversation_id, input.inviteeIds, e.organizer_id);
      await c.query('DELETE FROM calendar_event_invitees WHERE event_id = $1 AND NOT (user_id = ANY($2))', [id, ids]);
      for (const uid of ids) await c.query('INSERT INTO calendar_event_invitees (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, uid]);
    }
    const moved = input.startsAt && input.startsAt !== iso(e.starts_at);
    if (moved) await appendMessage(c, { conversationId: e.conversation_id, authorId: userId, kind: 'system', body: sys('event.moved', { title: input.title ?? e.title, eventId: id, startsAt: starts, timezone: input.timezone ?? e.timezone }) });
    const ev = await load(c, id);
    await publish(c, ev);
    return ev;
  });
}

export async function cancelEvent(userId: string, id: string) {
  return tx(async (c) => {
    const e = await editable(c, userId, id);
    if (e.cancelled_at) return load(c, id);
    await c.query('UPDATE calendar_events SET cancelled_at = now(), updated_at = now() WHERE id = $1', [id]);
    await appendMessage(c, { conversationId: e.conversation_id, authorId: userId, kind: 'system', body: sys('event.cancelled', { title: e.title, eventId: id }) });
    const ev = await load(c, id);
    await publish(c, ev);
    return ev;
  });
}

export async function rsvp(userId: string, id: string, answer: 'yes' | 'no' | 'maybe') {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT conversation_id FROM calendar_events WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Reunión');
    await conversationAccess(c, userId, rows[0].conversation_id, 'read');
    const r = await c.query('UPDATE calendar_event_invitees SET rsvp = $3, responded_at = now() WHERE event_id = $1 AND user_id = $2', [id, userId, answer]);
    if (!r.rowCount) throw forbidden('No estás invitado a esta reunión');
    const ev = await load(c, id);
    await publish(c, ev);
    return ev;
  });
}

/** Reuniones visibles en un rango: las de conversaciones que la persona puede leer. */
export async function listEvents(userId: string, from: string, to: string, conversationId?: string) {
  const { rows } = await pool.query(
    `SELECT e.id FROM calendar_events e
       JOIN conversation_memberships cm ON cm.conversation_id = e.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
       JOIN workspace_memberships wm ON wm.workspace_id = e.workspace_id AND wm.user_id = $1 AND wm.revoked_at IS NULL
                                     AND (wm.expires_at IS NULL OR wm.expires_at > now())
      WHERE e.starts_at < $3 AND e.ends_at > $2 AND ($4::uuid IS NULL OR e.conversation_id = $4)
      ORDER BY e.starts_at LIMIT 500`,
    [userId, from, to, conversationId ?? null],
  );
  return Promise.all(rows.map((r) => load(pool, r.id)));
}

export async function getEvent(userId: string, id: string) {
  const ev = await load(pool, id);
  await conversationAccess(pool, userId, ev.conversationId, 'read');
  return ev;
}
