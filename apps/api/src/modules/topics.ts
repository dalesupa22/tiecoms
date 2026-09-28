import { TOPIC_COLORS, TOPIC_LIMIT, type TopicColor, type TopicDTO } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { pool, tx, type Tx } from '../db.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { appendEvent, toMessageDTO } from './messages.ts';

/**
 * Temas de una conversación (docs/TEMAS.md): banderitas fijas; TOPIC_LIMIT activas es solo un tope técnico.
 * Cualquiera que pueda escribir en el chat crea, edita, archiva o quita temas y etiqueta cualquier mensaje.
 */
const toDTO = (r: any): TopicDTO => ({
  id: r.id, conversationId: r.conversation_id, name: r.name, color: r.color, icon: r.icon, position: r.position,
  archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(),
});

async function all(c: Tx | typeof pool, conversationId: string) {
  const { rows } = await c.query('SELECT * FROM conversation_topics WHERE conversation_id = $1 ORDER BY archived_at NULLS FIRST, position, created_at', [conversationId]);
  return rows.map(toDTO);
}

async function changed(c: Tx, conversationId: string) {
  const topics = await all(c, conversationId);
  await appendEvent(c, conversationId, { type: 'topics.changed', conversationId, topics });
  return topics;
}

async function activeCount(c: Tx, conversationId: string) {
  // Bloquea la fila del chat para que dos altas simultáneas no pasen del límite.
  await c.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
  const { rows } = await c.query('SELECT count(*)::int AS n FROM conversation_topics WHERE conversation_id = $1 AND archived_at IS NULL', [conversationId]);
  return rows[0].n as number;
}

const nameTaken = (e: any) => e?.code === '23505' ? conflict('Ya hay un tema con ese nombre') : e;

async function topicRow(c: Tx, userId: string, topicId: string) {
  const { rows } = await c.query('SELECT * FROM conversation_topics WHERE id = $1', [topicId]);
  if (!rows[0]) throw notFound('Tema');
  await conversationAccess(c, userId, rows[0].conversation_id, 'post', true);
  return rows[0];
}

export async function listTopics(userId: string, conversationId: string) {
  await conversationAccess(pool, userId, conversationId, 'read');
  return all(pool, conversationId);
}

export async function createTopic(userId: string, conversationId: string, input: { name: string; color?: TopicColor; icon?: string }) {
  return tx(async (c) => {
    await conversationAccess(c, userId, conversationId, 'post', true);
    const n = await activeCount(c, conversationId);
    if (n >= TOPIC_LIMIT) throw conflict(`Máximo ${TOPIC_LIMIT} temas activos: archiva los que ya no uses`);
    const { rows: used } = await c.query('SELECT color, max(position) OVER () AS top FROM conversation_topics WHERE conversation_id = $1', [conversationId]);
    const taken = new Set(used.map((r) => r.color));
    const color = input.color ?? TOPIC_COLORS.find((x) => !taken.has(x)) ?? TOPIC_COLORS[n % TOPIC_COLORS.length]!;
    const position = (used[0]?.top ?? -1) + 1;
    try {
      const { rows } = await c.query(
        'INSERT INTO conversation_topics (conversation_id, name, color, icon, position, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [conversationId, input.name, color, input.icon ?? '#', position, userId],
      );
      const topics = await changed(c, conversationId);
      return { topic: toDTO(rows[0]), topics };
    } catch (e) { throw nameTaken(e); }
  });
}

export async function updateTopic(userId: string, topicId: string, input: { name?: string; color?: TopicColor; icon?: string; archived?: boolean; position?: number }) {
  return tx(async (c) => {
    const t = await topicRow(c, userId, topicId);
    // Restaurar un archivado cuenta contra el límite.
    if (input.archived === false && t.archived_at && await activeCount(c, t.conversation_id) >= TOPIC_LIMIT) {
      throw conflict(`Máximo ${TOPIC_LIMIT} temas activos: archiva los que ya no uses`);
    }
    try {
      await c.query(
        `UPDATE conversation_topics SET name = COALESCE($2, name), color = COALESCE($3, color), icon = COALESCE($4, icon), position = COALESCE($5, position),
           archived_at = CASE WHEN $6::boolean IS NULL THEN archived_at WHEN $6 THEN COALESCE(archived_at, now()) ELSE NULL END WHERE id = $1`,
        [topicId, input.name ?? null, input.color ?? null, input.icon ?? null, input.position ?? null, input.archived ?? null],
      );
    } catch (e) { throw nameTaken(e); }
    return { topics: await changed(c, t.conversation_id) };
  });
}

/** Quitar un tema: se borra la banderita y sus mensajes y tareas quedan sin tema (ON DELETE SET NULL). */
export async function deleteTopic(userId: string, topicId: string) {
  return tx(async (c) => {
    const t = await topicRow(c, userId, topicId);
    const { rows } = await c.query('UPDATE messages SET topic_id = NULL, topic_by = NULL WHERE topic_id = $1 RETURNING *', [topicId]);
    await c.query('DELETE FROM conversation_topics WHERE id = $1', [topicId]);
    // Los clientes con el chat abierto limpian la etiqueta sin recargar.
    for (const r of rows) await appendEvent(c, t.conversation_id, { type: 'message.updated', conversationId: t.conversation_id, message: toMessageDTO(r) }, r.id);
    return { topics: await changed(c, t.conversation_id), cleared: rows.length };
  });
}

/** Etiquetar un mensaje (de cualquiera): solo con un tema activo del mismo chat. null lo deja sin tema. */
export async function setMessageTopic(userId: string, messageId: string, topicId: string | null) {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT conversation_id, seq, kind, deleted_at FROM messages WHERE id = $1', [messageId]);
    const m = rows[0];
    if (!m) throw notFound('Mensaje');
    const a = await conversationAccess(c, userId, m.conversation_id, 'post', true);
    if (m.seq <= a.historyFromSeq || m.kind !== 'text' || m.deleted_at) throw badRequest('Ese mensaje no se puede etiquetar');
    if (topicId) {
      const { rowCount } = await c.query('SELECT 1 FROM conversation_topics WHERE id = $1 AND conversation_id = $2 AND archived_at IS NULL', [topicId, m.conversation_id]);
      if (!rowCount) throw badRequest('Ese tema no está activo en esta conversación');
    }
    const { rows: out } = await c.query('UPDATE messages SET topic_id = $2, topic_by = $3 WHERE id = $1 RETURNING *', [messageId, topicId, topicId ? userId : null]);
    const message = toMessageDTO(out[0]);
    await appendEvent(c, m.conversation_id, { type: 'message.updated', conversationId: m.conversation_id, message }, messageId);
    return message;
  });
}
