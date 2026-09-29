/**
 * Buscar dentro del chat (docs/TANDA-1.7.md §6): cuerpo de los mensajes de texto, nombres de adjuntos y
 * transcripciones de notas de voz, sin mayúsculas ni tildes (tiecoms_fold, migración 037). Respeta el historial
 * visible y los borrados; nunca devuelve mensajes de una sola vista. `from:Nombre` filtra por autor.
 */
import type { ChatSearchPageDTO, ChatSearchResultDTO, GlobalSearchPageDTO } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { pool } from '../db.ts';
import { badRequest } from '../errors.ts';
import { forViewer, toMessageDTO } from './messages.ts';
import { fold, parseQuery, snippetFor } from './search-text.ts';

export { fold, parseQuery, snippetFor };

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function searchConversation(userId: string, conversationId: string, q: { q: string; before?: number; limit: number }): Promise<ChatSearchPageDTO> {
  const a = await conversationAccess(pool, userId, conversationId, 'read');
  const { text, from } = parseQuery(q.q);
  if (text.length < 2 && !from) throw badRequest('Escribe al menos 2 caracteres');
  let authorIds: string[] | null = null;
  if (from) {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id FROM conversation_memberships cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = $1 AND tiecoms_fold(u.name) LIKE '%' || $2 || '%' ESCAPE '\\'`,
      [conversationId, likeEscape(fold(from))],
    );
    authorIds = rows.map((r) => r.id);
    if (!authorIds.length) return { results: [], hasMore: false };
  }
  const needle = text.length >= 2 ? likeEscape(fold(text)) : null;
  const { rows } = await pool.query(
    `SELECT m.*,
            (SELECT json_agg(json_build_object('name', x.name, 'transcript', x.transcript->>'text') ORDER BY x.position)
               FROM attachments x WHERE x.message_id = m.id AND x.deleted_at IS NULL) AS att_text
       FROM messages m
      WHERE m.conversation_id = $1 AND m.seq > $2 AND ($3::bigint IS NULL OR m.seq < $3)
        AND m.kind = 'text' AND m.deleted_at IS NULL AND NOT m.view_once
        AND ($5::uuid[] IS NULL OR m.author_id = ANY($5))
        AND ($4::text IS NULL OR tiecoms_fold(m.body) LIKE '%' || $4 || '%' ESCAPE '\\' OR EXISTS (
              SELECT 1 FROM attachments x WHERE x.message_id = m.id AND x.deleted_at IS NULL
                AND (tiecoms_fold(x.name) LIKE '%' || $4 || '%' ESCAPE '\\' OR tiecoms_fold(x.transcript->>'text') LIKE '%' || $4 || '%' ESCAPE '\\')))
      ORDER BY m.seq DESC LIMIT $6`,
    [conversationId, a.historyFromSeq, q.before ?? null, needle, authorIds, q.limit + 1],
  );
  const results: ChatSearchResultDTO[] = rows.slice(0, q.limit).map((r) => {
    const message = forViewer(toMessageDTO(r), userId);
    const plain = text.length >= 2 ? text : '';
    const f = fold(plain);
    const atts: { name: string; transcript: string | null }[] = r.att_text ?? [];
    if (!plain || fold(String(r.body)).includes(f)) return { message, ...snippetFor(String(r.body || atts[0]?.name || ''), plain), field: 'body' as const };
    const byName = atts.find((x) => fold(x.name ?? '').includes(f));
    if (byName) return { message, ...snippetFor(byName.name, plain), field: 'attachment' as const };
    const byVoice = atts.find((x) => x.transcript && fold(x.transcript).includes(f));
    return { message, ...snippetFor(byVoice?.transcript ?? String(r.body), plain), field: 'transcript' as const };
  });
  return { results, hasMore: rows.length > q.limit };
}


/**
 * Buscar en todos mis chats (pedido de Danny, 29-sep-2026): mensajes de texto, adjuntos por nombre, notas de voz y
 * correos o WhatsApps compartidos (asunto y texto). Solo chats donde sigo, con su historial visible; nada de una sola
 * vista ni borrado. `from:Nombre` filtra por autor (personas que veo). Más recientes primero; `before` pagina por fecha.
 */
export async function searchAll(userId: string, q: { q: string; before?: string; limit: number }): Promise<GlobalSearchPageDTO> {
  const { text, from } = parseQuery(q.q);
  if (text.length < 2 && !from) throw badRequest('Escribe al menos 2 caracteres');
  const needle = text.length >= 2 ? likeEscape(fold(text)) : null;
  const fromLike = from ? likeEscape(fold(from)) : null;
  const { rows } = await pool.query(
    `WITH mine AS (
       SELECT cm.conversation_id, cm.history_from_seq FROM conversation_memberships cm
         JOIN conversations c ON c.id = cm.conversation_id AND c.archived_at IS NULL
        WHERE cm.user_id = $1 AND cm.removed_at IS NULL
     )
     SELECT m.*, u.name AS author_name,
            (SELECT json_agg(json_build_object('name', x.name, 'transcript', x.transcript->>'text') ORDER BY x.position)
               FROM attachments x WHERE x.message_id = m.id AND x.deleted_at IS NULL) AS att_text,
            se.subject AS mail_subject, se.body_text AS mail_body, se.provider AS mail_provider
       FROM mine
       JOIN messages m ON m.conversation_id = mine.conversation_id AND m.seq > mine.history_from_seq
       LEFT JOIN users u ON u.id = m.author_id
       LEFT JOIN shared_emails se ON se.message_id = m.id
      WHERE m.deleted_at IS NULL AND NOT m.view_once
        AND ($3::timestamptz IS NULL OR m.created_at < $3)
        AND ($4::text IS NULL OR tiecoms_fold(u.name) LIKE '%' || $4 || '%' ESCAPE '\\')
        AND (
          (m.kind = 'text' AND ($2::text IS NULL OR tiecoms_fold(m.body) LIKE '%' || $2 || '%' ESCAPE '\\' OR EXISTS (
            SELECT 1 FROM attachments x WHERE x.message_id = m.id AND x.deleted_at IS NULL
              AND (tiecoms_fold(x.name) LIKE '%' || $2 || '%' ESCAPE '\\' OR tiecoms_fold(x.transcript->>'text') LIKE '%' || $2 || '%' ESCAPE '\\'))))
          OR (se.id IS NOT NULL AND $2::text IS NOT NULL AND (tiecoms_fold(se.subject) LIKE '%' || $2 || '%' ESCAPE '\\' OR tiecoms_fold(se.body_text) LIKE '%' || $2 || '%' ESCAPE '\\'))
        )
      ORDER BY m.created_at DESC LIMIT $5`,
    [userId, needle, q.before ?? null, fromLike, q.limit + 1],
  );
  const plain = text.length >= 2 ? text : '';
  const f = fold(plain);
  const results: ChatSearchResultDTO[] = rows.slice(0, q.limit).map((r) => {
    const message = forViewer(toMessageDTO(r), userId);
    if (r.mail_subject != null) {
      const inSubject = !plain || fold(String(r.mail_subject)).includes(f);
      return { message, ...snippetFor(inSubject ? String(r.mail_subject) : String(r.mail_body ?? ''), plain), field: 'mail' as const };
    }
    const atts: { name: string; transcript: string | null }[] = r.att_text ?? [];
    if (!plain || fold(String(r.body)).includes(f)) return { message, ...snippetFor(String(r.body || atts[0]?.name || ''), plain), field: 'body' as const };
    const byName = atts.find((x) => fold(x.name ?? '').includes(f));
    if (byName) return { message, ...snippetFor(byName.name, plain), field: 'attachment' as const };
    const byVoice = atts.find((x) => x.transcript && fold(x.transcript).includes(f));
    return { message, ...snippetFor(byVoice?.transcript ?? String(r.body), plain), field: 'transcript' as const };
  });
  return { results, hasMore: rows.length > q.limit };
}
