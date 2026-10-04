import type { ConversationEvent, EventsPage, ForwardedInfo, MessageDTO, SendMessageInput } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { enqueueOutbox, pool, tx, type Db, type Tx } from '../db.ts';
import { badRequest, conflict, forbidden, notFound, viewOnceConflict } from '../errors.ts';
import { sha256 } from '../security.ts';
import { claimForMessage, hideForMessage, linkToMessage } from './attachments.ts';
import { maybeQueue as ggQueue } from './gg.ts';
import { queueAgentEvents } from './agents.ts';
import { markMentionsRead, normalizeMentions, saveMentions } from './mentions.ts';
import { dropLinks, indexLinks } from './links.ts';
import { normalizeRefs } from './refs.ts';

/** Si el texto trae un enlace, el worker arma su vista previa (fuera de la transacción del envío). */
async function queuePreview(c: Tx, messageId: string, body: string) {
  if (/\bhttps?:\/\//i.test(body)) await c.query("INSERT INTO jobs (kind, payload, max_attempts) VALUES ('link.preview', $1, 2)", [JSON.stringify({ messageId })]);
}

/** Push de un mensaje nuevo: solo si alguien más de la conversación tiene un dispositivo registrado. */
async function queuePush(c: Tx, messageId: string, conversationId: string, authorId: string) {
  await c.query(
    `INSERT INTO jobs (kind, payload, max_attempts)
     SELECT 'push.message', $1, 2 WHERE EXISTS (
       SELECT 1 FROM conversation_memberships cm
         JOIN sessions s ON s.user_id = cm.user_id AND s.revoked_at IS NULL AND s.expires_at > now()
         JOIN push_subscriptions ps ON ps.session_id = s.id AND ps.provider IN ('apns', 'fcm')
        WHERE cm.conversation_id = $2 AND cm.removed_at IS NULL AND cm.user_id <> $3)`,
    [JSON.stringify({ messageId }), conversationId, authorId],
  );
}

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
    ...(!r.view_once && !deleted && r.display_body!==null && r.display_body!==undefined ? { displayBody:r.display_body } : {}),
    replyTo: r.reply_to,
    mergedFrom: r.merged_from_conversation_id ?? null,
    ...(r.merged_kind ? { mergedKind: r.merged_kind } : {}),
    forwarded: r.forwarded ?? null,
    linkPreview: deleted ? null : r.link_preview ?? null,
    linkPreviews: deleted ? [] : r.link_previews ?? (r.link_preview ? [r.link_preview] : []),
    reactions: deleted ? [] : r.reactions ?? [],
    attachments: deleted ? [] : r.attachments ?? [],
    mentions: deleted ? [] : r.mentions ?? [],
    topicId: deleted ? null : r.topic_id ?? null,
    topicBy: deleted ? null : r.topic_by ?? null,
    ...(!deleted && r.refs?.length ? { refs: r.refs } : {}),
    // Una sola vista: la fila ya guarda body '' y adjuntos sin URL; el estado personal lo pone forViewer.
    ...(r.view_once ? { viewOnce: true, viewOnceState: 'unopened' as const, openedBy: r.view_once_opened ?? [] } : {}),
    createdAt: new Date(r.created_at).toISOString(),
    editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
    deletedAt: deleted ? new Date(r.deleted_at).toISOString() : null,
  };
}

/** Estado de una sola vista para esta persona: 'sent' si es su autor, 'opened' si ya lo abrió. */
export function forViewer(m: MessageDTO, userId: string): MessageDTO {
  if (!m.viewOnce) return m;
  const state = m.authorId === userId ? 'sent' : (m.openedBy ?? []).some((o) => o.userId === userId) ? 'opened' : 'unopened';
  return { ...m, viewOnceState: state };
}

/** Adjunto de una sola vista tal como lo ven todos: sin URL, nombre, onda ni transcripción. */
export const sealAttachment = (a: import('@tiecoms/contracts').AttachmentDTO): import('@tiecoms/contracts').AttachmentDTO => ({
  ...a, name: '', url: '', thumbUrl: null, provenance: null, ...(a.kind === 'voice' ? { waveform: null, transcript: null } : {}),
});

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
  clientMessageId?: string | null; replyTo?: string | null; mergedFrom?: string | null; forwarded?: ForwardedInfo | null;
  attachments?: import('@tiecoms/contracts').AttachmentDTO[] | null; hash?: Buffer | null; mentions?: import('@tiecoms/contracts').MentionDTO[] | null;
  topicId?: string | null; refs?: import('@tiecoms/contracts').MessageRefDTO[] | null;
  /** Una sola vista: el contenido real (body queda ''). */
  viewOnceBody?: string | null; displayBody?: string | null;
}): Promise<MessageDTO> {
  const { rows } = await c.query('SELECT tiecoms_append_message($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) AS m', [
    p.conversationId, p.authorId, p.clientMessageId ?? null, p.kind ?? 'text', p.body, p.replyTo ?? null, p.mergedFrom ?? null,
    p.forwarded ? JSON.stringify(p.forwarded) : null, p.attachments?.length ? JSON.stringify(p.attachments) : null, p.hash ?? null,
    p.mentions?.length ? JSON.stringify(p.mentions) : null, p.topicId ?? null,
    p.refs?.length ? JSON.stringify(p.refs) : null, p.viewOnceBody ?? null, p.displayBody ?? null,
  ]);
  const m = rows[0].m as MessageDTO;
  if ((p.kind ?? 'text') === 'text') await queuePush(c, m.id, p.conversationId, p.authorId);
  return m;
}

async function findByClientId(conversationId: string, authorId: string, clientMessageId: string, db: Db = pool) {
  const { rows } = await db.query(
    'SELECT * FROM messages WHERE conversation_id = $1 AND author_id = $2 AND client_message_id = $3',
    [conversationId, authorId, clientMessageId],
  );
  return rows[0];
}

/** Hash de idempotencia: el texto y, si hay, los ids de adjuntos (propios y reenviados) en orden. */
export function contentHash(body: string, own: string[] = [], fwd: string[] = []) {
  return own.length || fwd.length ? sha256(`${body}\u001fatt:${own.join(',')}|fwd:${fwd.join(',')}`) : sha256(body);
}

function sameBody(row: any, input: { body: string; attachmentIds?: string[]; forwardAttachmentIds?: string[] }) {
  return Buffer.compare(row.body_sha256, contentHash(input.body, input.attachmentIds, input.forwardAttachmentIds)) === 0;
}

/**
 * Envío idempotente: reintentar con el mismo clientMessageId devuelve el mismo
 * mensaje; reutilizarlo con otro contenido se rechaza. El ACK sale solo tras el commit.
 */
/** Texto para citar la tarjeta de un correo o un WhatsApp compartido (mail.shared / wa.shared); null si no es una. */
export function cardExcerpt(body: string): string | null {
  if (!body.startsWith('{"k":"mail.shared"') && !body.startsWith('{"k":"wa.shared"')) return null;
  try {
    const p = JSON.parse(body);
    return p.k === 'mail.shared' ? `✉ ${p.subject || '(sin asunto)'}${p.from ? ` · ${p.from}` : ''}` : `WhatsApp${p.chatName ? ` · ${p.chatName}` : ''}: ${p.text ?? ''}`;
  } catch { return null; }
}

export async function sendMessage(userId: string, conversationId: string, input: SendMessageInput,
  afterCreate?: (c: Tx, message: MessageDTO) => Promise<void>, existingTx?: Tx,
): Promise<{ message: MessageDTO; duplicate: boolean; droppedMentions?: string[] }> {
  const existing = await findByClientId(conversationId, userId, input.clientMessageId, existingTx ?? pool);
  if (existing) {
    // Aun así revalida el acceso: un duplicado no debe filtrar datos a quien perdió permiso.
    await conversationAccess(existingTx ?? pool, userId, conversationId, 'read');
    if (!sameBody(existing, input)) throw conflict('clientMessageId reutilizado con otro contenido');
    return { message: forViewer(toMessageDTO(existing), userId), duplicate: true };
  }
  // Una sola vista: texto, fotos y notas de voz propias; nunca reenvíos (docs/TANDA-1.7.md §7).
  if (input.viewOnce && (input.forwarded || input.forwardAttachmentIds?.length)) throw badRequest('Un mensaje de una sola vista no puede ser un reenvío');
  try {
    let dropped: string[] = [];
    const run = async (c: Tx) => {
      const access = await conversationAccess(c, userId, conversationId, 'post', true);
      if (input.replyTo) {
        const { rowCount } = await c.query('SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2', [input.replyTo, conversationId]);
        if (!rowCount) throw badRequest('El mensaje citado no está en esta conversación');
      }
      if (input.topicId) {
        // Solo un tema activo del mismo chat (docs/TEMAS.md).
        const { rowCount } = await c.query('SELECT 1 FROM conversation_topics WHERE id = $1 AND conversation_id = $2 AND archived_at IS NULL', [input.topicId, conversationId]);
        if (!rowCount) throw badRequest('Ese tema no está activo en esta conversación');
      }
      let forwarded: ForwardedInfo | null = null;
      if (input.forwarded) {
        // Reenviar desde otra conversación exige poder leerla: no se puede atribuir contenido ajeno.
        const from = input.forwarded.fromConversationId ?? null;
        const src = from ? await conversationAccess(c, userId, from, 'read') : null;
        const originalId = input.forwarded.messageId ?? null;
        let quote: { messageSeq: number; excerpt: string } | null = null;
        if (originalId) {
          // «Responder en privado»: el mensaje original debe ser visible para quien responde.
          // El extracto lo pone el servidor desde el original (no lo declara el cliente).
          const o = src ? (await c.query('SELECT seq, body, kind, deleted_at, view_once FROM messages WHERE id = $1 AND conversation_id = $2', [originalId, from])).rows[0] : null;
          // También se responde en privado a la tarjeta de un correo o un WhatsApp compartido.
          const card = o?.kind === 'system' ? cardExcerpt(String(o.body)) : null;
          if (!o || o.seq <= src!.historyFromSeq || (o.kind !== 'text' && !card) || o.deleted_at) throw badRequest('El mensaje original no está en la conversación de origen');
          if (o.view_once) throw viewOnceConflict();
          const flat = (card ?? String(o.body)).replace(/\s+/g, ' ').trim();
          quote = { messageSeq: o.seq, excerpt: flat.length > 200 ? `${flat.slice(0, 199)}…` : flat };
        }
        forwarded = { source: input.forwarded.source, author: input.forwarded.author ?? null, sentAt: input.forwarded.sentAt ?? null, fromConversationId: from, messageId: originalId, ...(quote ?? {}) };
      }
      const claimed = await claimForMessage(c, userId, conversationId, input.attachmentIds ?? [], input.forwardAttachmentIds ?? []);
      const once = input.viewOnce === true;
      if (once && claimed.some((x) => x.dto.kind !== 'voice' && !x.dto.contentType.startsWith('image/'))) throw badRequest('Una sola vista solo aplica a texto, fotos y notas de voz');
      // En una sola vista no hay menciones, #grupos, enlaces indexados ni vista previa: nada del contenido sale de la fila.
      const mentions = once ? { mentions: [], dropped: (input.mentions ?? []).map((x) => x.userId), userIds: [], all: false } : await normalizeMentions(c, conversationId, userId, input.body, input.mentions, access);
      dropped = mentions.dropped;
      const refs = once ? [] : await normalizeRefs(c, userId, input.body, input.refs);
      const credits=[...new Set(claimed.map((x)=>x.dto.provenance?.attribution).filter((x):x is string=>!!x))];
      const displayBody=credits.length ? (credits.includes(input.body) ? '' : input.body) : null;
      const fullBody=credits.length ? [displayBody,...credits].filter(Boolean).join('\n\n') : input.body;
      const m = await appendMessage(c, {
        displayBody, conversationId, authorId: userId, body: once ? '' : fullBody, clientMessageId: input.clientMessageId, replyTo: input.replyTo ?? null, forwarded,
        attachments: claimed.map((x) => (once ? sealAttachment(x.dto) : x.dto)), hash: contentHash(input.body, input.attachmentIds, input.forwardAttachmentIds), mentions: mentions.mentions,
        topicId: input.topicId ?? null, refs, viewOnceBody: once ? fullBody : null,
      });
      if (claimed.length) await linkToMessage(c, m.id, claimed.map((x) => x.id));
      if (mentions.userIds.length) await saveMentions(c, m.id, conversationId, m.seq, mentions as any);
      if (!once) {
        await indexLinks(c, { id: m.id, conversation_id: conversationId, seq: m.seq, author_id: userId, body: input.body, display_body:displayBody, attachments:claimed.map(x=>x.dto), created_at: m.createdAt });
        await queuePreview(c, m.id, displayBody ?? input.body);
      }
      // Datos asociados que deben quedar confirmados junto al mensaje (sin I/O externo).
      if (afterCreate) await afterCreate(c, m);
      // gg: su chat o @gg en cualquier chat (el worker responde; aquí solo se encola).
      await ggQueue(c, m);
      // Agentes miembro con webhook a quienes va dirigido (docs/AGENTES.md).
      await queueAgentEvents(c, m);
      return m;
    };
    const message = existingTx ? await run(existingTx) : await tx(run);
    return { message: forViewer(message, userId), duplicate: false, ...(dropped.length ? { droppedMentions: dropped } : {}) };
  } catch (err: any) {
    // Dos reintentos simultáneos: el segundo choca con la restricción única y devuelve el primero.
    if (!existingTx && err?.code === '23505') {
      const row = await findByClientId(conversationId, userId, input.clientMessageId);
      if (row && sameBody(row, input)) return { message: forViewer(toMessageDTO(row), userId), duplicate: true };
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
  const messages = rows.reverse().map((r) => forViewer(toMessageDTO(r), userId));
  return { messages, hasMore: rows.length === limit && (messages[0]?.seq ?? 0) > a.historyFromSeq + 1, lastEventSeq: a.lastEventSeq };
}

export async function listEvents(userId: string, conversationId: string, after: number, limit: number): Promise<EventsPage> {
  const a = await conversationAccess(pool, userId, conversationId, 'read');
  if (a.lastEventSeq - after > MAX_CATCHUP_EVENTS) return { events: [], resetRequired: true, lastEventSeq: a.lastEventSeq };
  const { rows } = await pool.query(
    `SELECT e.payload, m.seq AS message_seq, m.deleted_at AS message_deleted_at, iv.visibility AS issue_visibility FROM conversation_events e
       LEFT JOIN messages m ON m.id = e.message_id
       LEFT JOIN issues iv ON e.type = 'issue.updated' AND iv.id = (e.payload->'issue'->>'id')::uuid
      WHERE e.conversation_id = $1 AND e.event_seq > $2 ORDER BY e.event_seq LIMIT $3`,
    [conversationId, after, limit],
  );
  // Los eventos de mensajes anteriores al historial concedido se omiten; su seq igual avanza el cursor.
  const events = rows.map((r) => {
    if (r.message_seq !== null && r.message_seq <= a.historyFromSeq) {
      return { type: 'redacted', conversationId, eventSeq: r.payload.eventSeq } as ConversationEvent;
    }
    // Un mensaje eliminado después no reenvía su contenido anterior al ponerse al día.
    if (r.message_deleted_at && r.payload.message) {
      return { ...r.payload, message: { ...r.payload.message, body: '', attachments: [], mentions: [], linkPreview: null, linkPreviews: [], reactions: [], deletedAt: new Date(r.message_deleted_at).toISOString() } } as ConversationEvent;
    }
    // Un asunto que después quedó restringido no se reenvía por la conversación al ponerse al día.
    if (r.payload.type === 'issue.updated' && r.issue_visibility && r.issue_visibility !== 'all') {
      return { type: 'redacted', conversationId, eventSeq: r.payload.eventSeq } as ConversationEvent;
    }
    return r.payload as ConversationEvent;
  });
  return { events, resetRequired: false, lastEventSeq: a.lastEventSeq };
}

export async function markRead(userId: string, conversationId: string, seq: number) {
  return tx(async (c) => {
    const a = await conversationAccess(c, userId, conversationId, 'read');
    const target = Math.max(a.historyFromSeq, Math.min(seq, a.lastMessageSeq));
    const { rows } = await c.query(
      `INSERT INTO read_cursors (conversation_id, user_id, last_read_seq, revision) VALUES ($1,$2,$3,1)
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_seq = GREATEST(read_cursors.last_read_seq, EXCLUDED.last_read_seq), updated_at = now(), revision=read_cursors.revision+1
       RETURNING last_read_seq, revision`,
      [conversationId, userId, target],
    );
    const lastRead: number = rows[0].last_read_seq;
    await markMentionsRead(c, userId, conversationId, lastRead);
    // Sincroniza los no leídos entre los dispositivos de la misma cuenta.
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'read.updated', conversationId, seq: lastRead, readRevision: Number(rows[0].revision) } });
    return { lastReadSeq: lastRead, readRevision: Number(rows[0].revision) };
  });
}

/**
 * «Marcar como leído» desde la lista: el grupo y sus conversaciones derivadas (hilos, ramas, internas)
 * donde participo, cada una hasta el seq que el cliente vio (no se tragan mensajes que llegaron después).
 * Los sidechats (derive_kind 'side') viven en DMs y se marcan aparte.
 */
export async function markTreeRead(userId: string, rootId: string, items: { conversationId: string; seq: number }[]) {
  await conversationAccess(pool, userId, rootId, 'read');
  const ids = [...new Set(items.map((i) => i.conversationId))];
  const { rows } = await pool.query(
    `SELECT c.id FROM conversations c JOIN conversation_memberships cm ON cm.conversation_id = c.id AND cm.user_id = $1 AND cm.removed_at IS NULL
      WHERE c.id = ANY($2) AND (c.id = $3 OR (c.parent_conversation_id = $3 AND COALESCE(c.derive_kind, '') <> 'side'))`,
    [userId, ids, rootId],
  );
  const allowed = new Set(rows.map((r) => r.id as string));
  const out: { conversationId: string; lastReadSeq: number;readRevision:number }[] = [];
  for (const it of items) {
    if (!allowed.has(it.conversationId)) continue;
    const r = await markRead(userId, it.conversationId, it.seq);
    out.push({ conversationId: it.conversationId, lastReadSeq: r.lastReadSeq,readRevision:r.readRevision });
  }
  return { marked: out };
}

// ---------- Editar, eliminar, no leído, fijar ----------
/** Lo que se trajo arrastrando a un chat (un correo o un mensaje de WhatsApp): entra como mensaje de sistema de quien lo trajo. */
const SHARED_KINDS = new Set(['mail.shared', 'wa.shared']);
export function sharedKind(m: { kind: string; body: string }): string | null {
  if (m.kind !== 'system') return null;
  try { const k = JSON.parse(m.body)?.k; return typeof k === 'string' && SHARED_KINDS.has(k) ? k : null; } catch { return null; }
}

/** `shared`: también lo que la persona trajo arrastrando (solo para borrarlo; no se edita). */
async function ownMessage(c: Tx, userId: string, messageId: string, shared = false) {
  const { rows } = await c.query('SELECT * FROM messages WHERE id = $1', [messageId]);
  const m = rows[0];
  if (!m) throw notFound('Mensaje');
  const access = await conversationAccess(c, userId, m.conversation_id, 'post', true);
  if (m.author_id !== userId || !(m.kind === 'text' || (shared && sharedKind(m)))) throw forbidden('Solo puedes cambiar tus propios mensajes');
  if (m.deleted_at) throw conflict('El mensaje ya fue eliminado');
  return Object.assign(m, { access });
}

async function editableMessage(c: Tx, userId: string, messageId: string) {
  const m = await ownMessage(c, userId, messageId);
  if (m.view_once) throw viewOnceConflict();
  return m;
}

export async function editMessage(userId: string, messageId: string, body: string, mentionsInput?: { userId: string; start: number; length: number }[],
  refsInput?: { conversationId: string; start: number; length: number }[]) {
  return tx(async (c) => {
    const m = await editableMessage(c, userId, messageId);
    // Menciones: las nuevas si llegan; si no llegan y el texto cambió, las anteriores ya no apuntan bien y se quitan.
    const mentions = await normalizeMentions(c, m.conversation_id, userId, body, mentionsInput ?? (body === m.body ? m.mentions ?? [] : []), m.access);
    await saveMentions(c, messageId, m.conversation_id, m.seq, mentions);
    // Otro texto, otra vista previa: se quita la anterior y el worker lee el enlace nuevo.
    // #grupos: igual que las menciones (las nuevas si llegan; si el texto cambió sin refs, se quitan).
    const refs = await normalizeRefs(c, userId, body, refsInput ?? (body === m.body ? m.refs ?? [] : []));
    const credits=[...new Set((m.attachments ?? []).map((x:any)=>x.provenance?.attribution).filter((x:any)=>!!x))] as string[];
    const displayBody=credits.length ? (credits.includes(body) ? '' : body) : null;
    const fullBody=credits.length ? [displayBody,...credits].filter(Boolean).join('\n\n') : body;
    const { rows } = await c.query('UPDATE messages SET body = $2, display_body=$6, body_sha256 = $3, edited_at = now(), link_preview = NULL, link_previews = NULL, mentions = $4, refs = $5 WHERE id = $1 RETURNING *',
      [messageId, fullBody, sha256(body), mentions.mentions.length ? JSON.stringify(mentions.mentions) : null, refs.length ? JSON.stringify(refs) : null, displayBody]);
    await indexLinks(c, rows[0]);
    await queuePreview(c, messageId, displayBody ?? body);
    const message = toMessageDTO(rows[0]);
    await appendEvent(c, m.conversation_id, { type: 'message.updated', conversationId: m.conversation_id, message }, messageId);
    return message;
  });
}

export async function deleteMessage(userId: string, messageId: string) {
  return tx(async (c) => {
    const m = await ownMessage(c, userId, messageId, true);
    // Lo traído arrastrando (correo o WhatsApp): la tarjeta, su hilo de comentarios y sus respuestas dejan de existir para todos.
    if (sharedKind(m)) await c.query('DELETE FROM shared_emails WHERE message_id = $1', [messageId]);
    // Borrado lógico: se conserva el orden y queda la marca; el contenido deja de servirse. Queda como texto
    // borrado para que todas las apps (web, escritorio, iOS, Android) lo pinten como «Mensaje eliminado».
    const { rows } = await c.query("UPDATE messages SET kind = 'text', body = '', attachments = NULL, mentions = NULL, refs = NULL, view_once_body = NULL, link_preview = NULL, link_previews = NULL, reactions = NULL, external_reactions = NULL, deleted_at = now() WHERE id = $1 RETURNING *", [messageId]);
    await c.query('DELETE FROM message_mentions WHERE message_id = $1', [messageId]);
    await c.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);
    await dropLinks(c, messageId);
    await hideForMessage(c, messageId);
    await c.query('DELETE FROM message_pins WHERE message_id = $1', [messageId]);
    const message = toMessageDTO(rows[0]);
    await appendEvent(c, m.conversation_id, { type: 'message.updated', conversationId: m.conversation_id, message }, messageId);
    return message;
  });
}

/** Marca como no leído desde un mensaje: el cursor queda justo antes de él. */
export async function markUnread(userId: string, conversationId: string, seq: number) {
  return tx(async (c) => {
    const a = await conversationAccess(c, userId, conversationId, 'read');
    const target = Math.max(a.historyFromSeq, Math.min(seq, a.lastMessageSeq) - 1);
    const read = await c.query(
      `INSERT INTO read_cursors (conversation_id, user_id, last_read_seq, revision) VALUES ($1,$2,$3,1)
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_seq = EXCLUDED.last_read_seq, updated_at = now(), revision=read_cursors.revision+1 RETURNING revision`,
      [conversationId, userId, target],
    );
    await c.query('UPDATE message_mentions SET read_at = NULL WHERE user_id = $1 AND conversation_id = $2 AND seq > $3', [userId, conversationId, target]);
    await enqueueOutbox(c, 'account.event', { userIds: [userId], event: { type: 'read.updated', conversationId, seq: target, readRevision: Number(read.rows[0].revision) } });
    return { lastReadSeq: target, readRevision: Number(read.rows[0].revision) };
  });
}

async function pinIds(c: Tx | typeof pool, conversationId: string) {
  const { rows } = await c.query('SELECT message_id FROM message_pins WHERE conversation_id = $1 ORDER BY pinned_at DESC', [conversationId]);
  return rows.map((r) => r.message_id as string);
}

export async function setPin(userId: string, messageId: string, pinned: boolean) {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT conversation_id, seq, kind, deleted_at, view_once FROM messages WHERE id = $1', [messageId]);
    const m = rows[0];
    if (!m) throw notFound('Mensaje');
    const a = await conversationAccess(c, userId, m.conversation_id, 'post', true);
    if (m.view_once && pinned) throw viewOnceConflict();
    if (m.seq <= a.historyFromSeq || m.kind !== 'text' || m.deleted_at) throw badRequest('Ese mensaje no se puede fijar');
    if (pinned) await c.query('INSERT INTO message_pins (conversation_id, message_id, pinned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [m.conversation_id, messageId, userId]);
    else await c.query('DELETE FROM message_pins WHERE conversation_id = $1 AND message_id = $2', [m.conversation_id, messageId]);
    const messageIds = await pinIds(c, m.conversation_id);
    await appendEvent(c, m.conversation_id, { type: 'pins.changed', conversationId: m.conversation_id, messageIds });
    return { messageIds };
  });
}

/** Mensajes fijados visibles para la persona (respeta su historial). */
export async function listPins(userId: string, conversationId: string) {
  const a = await conversationAccess(pool, userId, conversationId, 'read');
  const { rows } = await pool.query(
    `SELECT m.* FROM message_pins p JOIN messages m ON m.id = p.message_id
      WHERE p.conversation_id = $1 AND m.seq > $2 AND m.deleted_at IS NULL ORDER BY p.pinned_at DESC`,
    [conversationId, a.historyFromSeq],
  );
  return rows.map((r) => forViewer(toMessageDTO(r), userId));
}

/** Only exact server-verified credit text is technical metadata. Arbitrary GIF prefixes/comments stay text. */
export function creditFreeBody(body: string, attachments?: any[] | null) { return attachments?.some((a) => a.provenance?.version === 1 && a.provenance.attribution === body) ? '' : body; }

/** Directed load is bounded and applies the same membership/history and one-view sealing as normal pages. */
export async function messagesAround(userId: string, conversationId: string, target: { messageId?: string; seq?: number }, limit = 50) {
  const a = await conversationAccess(pool,userId,conversationId,'read');
  const found = await pool.query('SELECT seq FROM messages WHERE conversation_id=$1 AND seq>$2 AND (($3::uuid IS NOT NULL AND id=$3) OR ($4::bigint IS NOT NULL AND seq=$4))',[conversationId,a.historyFromSeq,target.messageId ?? null,target.seq ?? null]);
  if (!found.rows[0]) throw notFound('Mensaje');
  const seq = Number(found.rows[0].seq), half = Math.floor(limit / 2);
  const rows = await pool.query(`(SELECT * FROM messages WHERE conversation_id=$1 AND seq>$2 AND seq<$3 ORDER BY seq DESC LIMIT $4)
    UNION ALL (SELECT * FROM messages WHERE conversation_id=$1 AND seq>=$3 ORDER BY seq ASC LIMIT $5) ORDER BY seq`, [conversationId,a.historyFromSeq,seq,half,limit-half]);
  return { messages: rows.rows.map((r)=>forViewer(toMessageDTO(r),userId)), hasMore: Number(rows.rows[0]?.seq ?? 0)>a.historyFromSeq+1, lastEventSeq:a.lastEventSeq };
}
