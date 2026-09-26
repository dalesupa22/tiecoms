/**
 * Reacciones con emoji. Viajan dentro del mensaje (MessageDTO.reactions) con message.updated: no suben el
 * contador de no leídos, no marcan el mensaje como editado y los clientes viejos las ignoran.
 * Reacciones con acción (si la empresa de quien reacciona las tiene activas):
 *   👀 «lo reviso» → recordatorio personal sobre el mensaje (quitar la reacción lo cancela);
 *   ✅ «hecho» → cierra mis recordatorios de ese mensaje y reemplaza mi 👀.
 * Al autor le llega un solo push agrupado (dedupe por mensaje en ventanas de 2 minutos).
 */
import { MAX_REACTIONS_PER_MESSAGE, REACTION_ACTIONS, normalizeEmoji, type ReactionDTO, type ReminderDTO } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { enqueueOutbox, pool, tx, type Tx } from '../db.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { appendEvent, toMessageDTO } from './messages.ts';

/** Espera del push de reacciones: junta las que llegan casi juntas en un solo aviso. */
const PUSH_DELAY_S = 20;
const LOOK_REMINDER_HOURS = 3;

/** Agregado que se guarda en messages.reactions: por emoji, en el orden de su primera reacción. */
export async function aggregate(c: Tx | typeof pool, messageId: string, external: Record<string, { emoji: string; name: string; source?: string }> | null): Promise<ReactionDTO[]> {
  const { rows } = await c.query(
    `SELECT emoji, array_agg(user_id ORDER BY created_at) AS user_ids, min(created_at) AS first
       FROM message_reactions WHERE message_id = $1 GROUP BY emoji ORDER BY first`,
    [messageId],
  );
  const out: ReactionDTO[] = rows.map((r) => ({ emoji: r.emoji, userIds: r.user_ids }));
  for (const e of Object.values(external ?? {})) {
    let item = out.find((x) => x.emoji === e.emoji);
    if (!item) { item = { emoji: e.emoji, userIds: [] }; out.push(item); }
    (item.external ??= []).push({ name: e.name, source: (e.source as any) ?? 'whatsapp' });
  }
  return out;
}

async function publish(c: Tx, conversationId: string, messageId: string, external: any) {
  const reactions = await aggregate(c, messageId, external);
  const { rows } = await c.query('UPDATE messages SET reactions = $2 WHERE id = $1 RETURNING *', [messageId, reactions.length ? JSON.stringify(reactions) : null]);
  const message = toMessageDTO(rows[0]);
  await appendEvent(c, conversationId, { type: 'message.updated', conversationId, message }, messageId);
  return message;
}

const reminderDTO = (r: any): ReminderDTO => ({
  id: r.id, conversationId: r.conversation_id, messageId: r.message_id, messageSeq: r.message_seq ?? null, note: r.note,
  remindAt: new Date(r.remind_at).toISOString(), firedAt: r.fired_at ? new Date(r.fired_at).toISOString() : null, doneAt: r.done_at ? new Date(r.done_at).toISOString() : null,
});

export interface ReactResult {
  message: import('@tiecoms/contracts').MessageDTO;
  /** 👀: el recordatorio que se creó. */
  reminder?: ReminderDTO;
  /** ✅ o quitar 👀: recordatorios que se cerraron. */
  closedReminderIds?: string[];
  /** ✅ sobre el mensaje que abrió un asunto abierto: el cliente ofrece cerrarlo. */
  openIssueId?: string;
}

export async function react(userId: string, messageId: string, rawEmoji: string, on: boolean, opts: { remindAt?: string } = {}): Promise<ReactResult> {
  const emoji = normalizeEmoji(rawEmoji);
  if (!emoji) throw badRequest('Eso no es un emoji');
  return tx(async (c) => {
    const { rows } = await c.query('SELECT id, conversation_id, seq, kind, author_id, deleted_at FROM messages WHERE id = $1', [messageId]);
    const m = rows[0];
    if (!m) throw notFound('Mensaje');
    const a = await conversationAccess(c, userId, m.conversation_id, 'post', true);
    if (m.seq <= a.historyFromSeq || m.kind !== 'text' || m.deleted_at) throw badRequest('A ese mensaje no se le puede reaccionar');
    const cur = (await c.query('SELECT external_reactions FROM messages WHERE id = $1 FOR UPDATE', [messageId])).rows[0];
    const out: Omit<ReactResult, 'message'> = {};
    const actions = (await c.query('SELECT COALESCE(o.reaction_actions, true) AS on FROM users u LEFT JOIN organizations o ON o.id = u.primary_org_id WHERE u.id = $1', [userId])).rows[0]?.on !== false;
    if (on) {
      const had = await c.query('SELECT 1 FROM message_reactions WHERE message_id = $1 AND emoji = $2 AND user_id = $3', [messageId, emoji, userId]);
      if (had.rowCount) return { message: toMessageDTO((await c.query('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0]) };
      const distinct = await c.query('SELECT count(DISTINCT emoji)::int AS n, bool_or(emoji = $2) AS has FROM message_reactions WHERE message_id = $1', [messageId, emoji]);
      if (!distinct.rows[0].has && distinct.rows[0].n >= MAX_REACTIONS_PER_MESSAGE) throw conflict(`Ese mensaje ya tiene ${MAX_REACTIONS_PER_MESSAGE} reacciones distintas`);
      await c.query('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [messageId, userId, emoji]);
      if (actions && emoji === REACTION_ACTIONS.look) {
        const at = opts.remindAt && Date.parse(opts.remindAt) > Date.now() ? opts.remindAt : new Date(Date.now() + LOOK_REMINDER_HOURS * 3600_000).toISOString();
        const r = await c.query(
          `INSERT INTO reminders (user_id, conversation_id, message_id, note, remind_at, via_reaction) VALUES ($1,$2,$3,NULL,$4,$5)
           RETURNING *, $6::bigint AS message_seq`,
          [userId, m.conversation_id, messageId, at, emoji, m.seq],
        );
        out.reminder = reminderDTO(r.rows[0]);
      }
      if (actions && emoji === REACTION_ACTIONS.done) {
        const closed = await c.query('UPDATE reminders SET done_at = now() WHERE user_id = $1 AND message_id = $2 AND done_at IS NULL RETURNING id', [userId, messageId]);
        if (closed.rowCount) out.closedReminderIds = closed.rows.map((r) => r.id);
        // «Hecho» reemplaza a «lo reviso».
        await c.query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [messageId, userId, REACTION_ACTIONS.look]);
        const issue = await c.query("SELECT id FROM issues WHERE origin_message_id = $1 AND status NOT IN ('done','cancelled') LIMIT 1", [messageId]);
        if (issue.rows[0]) out.openIssueId = issue.rows[0].id;
      }
      if (m.author_id && m.author_id !== userId) {
        await c.query(
          `INSERT INTO jobs (kind, payload, max_attempts, run_at, dedupe_key) VALUES ('push.reaction', $1, 2, now() + make_interval(secs => $2), $3)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [JSON.stringify({ messageId }), PUSH_DELAY_S, `react:${messageId}:${Math.floor(Date.now() / 120_000)}`],
        );
      }
    } else {
      const del = await c.query('DELETE FROM message_reactions WHERE message_id = $1 AND emoji = $2 AND user_id = $3', [messageId, emoji, userId]);
      if (!del.rowCount) return { message: toMessageDTO((await c.query('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0]) };
      if (emoji === REACTION_ACTIONS.look) {
        const closed = await c.query('UPDATE reminders SET done_at = now() WHERE user_id = $1 AND message_id = $2 AND via_reaction = $3 AND done_at IS NULL RETURNING id', [userId, messageId, emoji]);
        if (closed.rowCount) out.closedReminderIds = closed.rows.map((r) => r.id);
      }
    }
    if (out.reminder || out.closedReminderIds) {
      // Los otros dispositivos de la persona vuelven a pedir sus recordatorios.
      await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'reminders.changed' } });
    }
    const message = await publish(c, m.conversation_id, messageId, cur.external_reactions);
    return { message, ...out };
  });
}

/**
 * Reacción que llega por el puente de WhatsApp sobre un mensaje reenviado a TieComs.
 * emoji vacío = la persona quitó su reacción.
 */
export async function externalReaction(messageId: string, key: string, emoji: string | null, name: string, source = 'whatsapp') {
  const e = emoji ? normalizeEmoji(emoji) : null;
  if (emoji && !e) return;
  await tx(async (c) => {
    const cur = (await c.query('SELECT conversation_id, deleted_at, external_reactions FROM messages WHERE id = $1 FOR UPDATE', [messageId])).rows[0];
    if (!cur || cur.deleted_at) return;
    const ext = { ...(cur.external_reactions ?? {}) } as Record<string, any>;
    if (e) ext[key] = { emoji: e, name: name.slice(0, 80), source };
    else delete ext[key];
    await c.query('UPDATE messages SET external_reactions = $2 WHERE id = $1', [messageId, Object.keys(ext).length ? JSON.stringify(ext) : null]);
    await publish(c, cur.conversation_id, messageId, ext);
  });
}

/** Quién reaccionó recién (para el push del autor): nombres y emojis de los últimos minutos, sin el autor. */
export async function recentReactions(messageId: string) {
  const { rows } = await pool.query(
    `SELECT r.emoji, u.name, r.user_id FROM message_reactions r JOIN messages m ON m.id = r.message_id JOIN users u ON u.id = r.user_id
      WHERE r.message_id = $1 AND r.user_id <> m.author_id AND r.created_at > now() - interval '5 minutes'
      ORDER BY r.created_at`,
    [messageId],
  );
  return rows as { emoji: string; name: string; user_id: string }[];
}

/** Administración de la empresa: activa o apaga las reacciones con acción para su gente. */
export async function setReactionActions(userId: string, orgId: string, enabled: boolean) {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT role FROM organization_memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
    if (!rows[0]) throw notFound('Empresa');
    if (!['owner', 'admin'].includes(rows[0].role)) throw forbidden('Solo la administración de la empresa puede cambiarlo');
    await c.query('UPDATE organizations SET reaction_actions = $2 WHERE id = $1', [orgId, enabled]);
    const members = await c.query('SELECT user_id FROM organization_memberships WHERE org_id = $1', [orgId]);
    await enqueueOutbox(c, 'account.event', { userIds: members.rows.map((r) => r.user_id), event: { type: 'scope.changed', reason: 'org.settings' } });
    return { reactionActions: enabled };
  });
}
