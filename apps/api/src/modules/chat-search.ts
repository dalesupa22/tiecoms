/**
 * Buscar dentro del chat (docs/TANDA-1.7.md §6): cuerpo de los mensajes de texto, nombres de adjuntos y
 * transcripciones de notas de voz, sin mayúsculas ni tildes (tiecoms_fold, migración 037). Respeta el historial
 * visible y los borrados; nunca devuelve mensajes de una sola vista. `from:Nombre` filtra por autor.
 */
import type { ChatSearchPageDTO, ChatSearchResultDTO } from '@tiecoms/contracts';
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
