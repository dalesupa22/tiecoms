import type { ConversationEvent, EventsPage, MessageDTO, SendMessageInput } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { enqueueOutbox, pool, tx, type Tx } from '../db.ts';
import { badRequest, conflict } from '../errors.ts';
import { sha256 } from '../security.ts';

/** Eventos más antiguos que esto obligan al cliente a pedir un snapshot nuevo. */
const MAX_CATCHUP_EVENTS = 5000;

export function toMessageDTO(r: any): MessageDTO {
  const deleted = r.deleted_at !== null && r.deleted_at !== undefined;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: r.seq,
    authorId: r.author_id,
    clientMessageId: r.client_message_id,
    kind: r.kind,
    body: deleted ? '' : r.body,
    replyTo: r.reply_to,
    createdAt: new Date(r.created_at).toISOString(),
    editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
    deletedAt: deleted ? new Date(r.deleted_at).toISOString() : null,
  };
}

/** Reserva el siguiente event_seq. La fila de la conversación queda bloqueada hasta el commit. */
export async function appendEvent(c: Tx, conversationId: string, event: Omit<ConversationEvent, 'eventSeq'> & Record<string, unknown>, messageId: string | null = null) {
  const { rows } = await c.query(
    'UPDATE conversations SET last_event_seq = last_event_seq + 1 WHERE id = $1 RETURNING last_event_seq',
    [conversationId],
  );
  const eventSeq: number = rows[0].last_event_seq;
  const full = { ...event, eventSeq } as ConversationEvent;
  await c.query(
    'INSERT INTO conversation_events (conversation_id, event_seq, type, message_id, payload) VALUES ($1,$2,$3,$4,$5)',
    [conversationId, eventSeq, event.type, messageId, JSON.stringify(full)],
  );
  await enqueueOutbox(c, 'conv.event', full);
  return full;
}

/**
 * Inserta un mensaje dentro de una transacción ya autorizada (ver
 * migrations/002): seq bajo bloqueo de fila, evento durable, cursor y outbox en un viaje.
 */
export async function appendMessage(c: Tx, p: {
  conversationId: string; authorId: string; body: string; kind?: 'text' | 'system';
  clientMessageId?: string | null; replyTo?: string | null;
}): Promise<MessageDTO> {
  const { rows } = await c.query('SELECT tiecoms_append_message($1, $2, $3, $4, $5, $6) AS m', [
    p.conversationId, p.authorId, p.clientMessageId ?? null, p.kind ?? 'text', p.body, p.replyTo ?? null,
  ]);
  return rows[0].m as MessageDTO;
}

async function findByClientId(conversationId: string, authorId: string, clientMessageId: string) {
  const { rows } = await pool.query(
    'SELECT * FROM messages WHERE conversation_id = $1 AND author_id = $2 AND client_message_id = $3',
    [conversationId, authorId, clientMessageId],
  );
  return rows[0];
}

function sameBody(row: any, body: string) {
  return Buffer.compare(row.body_sha256, sha256(body)) === 0;
}

/**
 * Envío idempotente: reintentar con el mismo clientMessageId devuelve el mismo
 * mensaje; reutilizarlo con otro contenido se rechaza. El ACK sale solo tras el commit.
 */
export async function sendMessage(userId: string, conversationId: string, input: SendMessageInput): Promise<{ message: MessageDTO; duplicate: boolean }> {
  const existing = await findByClientId(conversationId, userId, input.clientMessageId);
  if (existing) {
    // Aun así revalida el acceso: un duplicado no debe filtrar datos a quien perdió permiso.
    await conversationAccess(pool, userId, conversationId, 'read');
    if (!sameBody(existing, input.body)) throw conflict('clientMessageId reutilizado con otro contenido');
    return { message: toMessageDTO(existing), duplicate: true };
  }
  try {
    const message = await tx(async (c) => {
      await conversationAccess(c, userId, conversationId, 'post', true);
      if (input.replyTo) {
        const { rowCount } = await c.query('SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2', [input.replyTo, conversationId]);
        if (!rowCount) throw badRequest('El mensaje citado no está en esta conversación');
      }
      return appendMessage(c, { conversationId, authorId: userId, body: input.body, clientMessageId: input.clientMessageId, replyTo: input.replyTo ?? null });
    });
    return { message, duplicate: false };
  } catch (err: any) {
    // Dos reintentos simultáneos: el segundo choca con la restricción única y devuelve el primero.
    if (err?.code === '23505') {
      const row = await findByClientId(conversationId, userId, input.clientMessageId);
      if (row && sameBody(row, input.body)) return { message: toMessageDTO(row), duplicate: true };
      if (row) throw conflict('clientMessageId reutilizado con otro contenido');
    }
    throw err;
  }
}

export async function listMessages(userId: string, conversationId: string, before: number | undefined, limit: number) {
  const a = await conversationAccess(pool, userId, conversationId, 'read');
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE conversation_id = $1 AND seq > $2 AND ($3::bigint IS NULL OR seq < $3)
      ORDER BY seq DESC LIMIT $4`,
    [conversationId, a.historyFromSeq, before ?? null, limit],
  );
  const messages = rows.reverse().map(toMessageDTO);
  return { messages, hasMore: rows.length === limit && (messages[0]?.seq ?? 0) > a.historyFromSeq + 1, lastEventSeq: a.lastEventSeq };
}

export async function listEvents(userId: string, conversationId: string, after: number, limit: number): Promise<EventsPage> {
  const a = await conversationAccess(pool, userId, conversationId, 'read');
  if (a.lastEventSeq - after > MAX_CATCHUP_EVENTS) return { events: [], resetRequired: true, lastEventSeq: a.lastEventSeq };
  const { rows } = await pool.query(
    `SELECT e.payload, m.seq AS message_seq FROM conversation_events e
       LEFT JOIN messages m ON m.id = e.message_id
      WHERE e.conversation_id = $1 AND e.event_seq > $2 ORDER BY e.event_seq LIMIT $3`,
    [conversationId, after, limit],
  );
  // Los eventos de mensajes anteriores al historial concedido se omiten; su seq igual avanza el cursor.
  const events = rows.map((r) => {
    if (r.message_seq !== null && r.message_seq <= a.historyFromSeq) {
      return { type: 'redacted', conversationId, eventSeq: r.payload.eventSeq } as ConversationEvent;
    }
    return r.payload as ConversationEvent;
  });
  return { events, resetRequired: false, lastEventSeq: a.lastEventSeq };
}

export async function markRead(userId: string, conversationId: string, seq: number) {
  return tx(async (c) => {
    const a = await conversationAccess(c, userId, conversationId, 'read');
    const target = Math.min(seq, a.lastMessageSeq);
    const { rows } = await c.query(
      `INSERT INTO read_cursors (conversation_id, user_id, last_read_seq) VALUES ($1,$2,$3)
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_seq = GREATEST(read_cursors.last_read_seq, EXCLUDED.last_read_seq), updated_at = now()
       RETURNING last_read_seq`,
      [conversationId, userId, target],
    );
    const lastRead: number = rows[0].last_read_seq;
    // Sincroniza los no leídos entre los dispositivos de la misma cuenta.
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'read.updated', conversationId, seq: lastRead } });
    return { lastReadSeq: lastRead };
  });
}
