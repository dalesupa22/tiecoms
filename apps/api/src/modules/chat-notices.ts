/**
 * Avisos de la tanda 1.7 en el chat (docs/TANDA-1.7.md §2–§5): comentarios agrupados de tareas y eventos,
 * «es hoy» de los eventos y «No cumplimos» de las tareas vencidas.
 */
import { tx, type Tx } from '../db.ts';
import { appendEvent, appendMessage, toMessageDTO } from './messages.ts';
import { localDate, todayDecision } from './today.ts';

export { localDate, todayDecision };

const sys = (k: string, p: Record<string, unknown> = {}) => JSON.stringify({ k, ...p });
/** El aviso se actualiza si está entre los últimos N mensajes del chat. */
export const COMMENT_WINDOW = 15;
const excerptOf = (s: string) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 120 ? `${t.slice(0, 119)}…` : t; };

/**
 * Un comentario nuevo en una tarea visible para todos o en un evento: actualiza el último aviso de ese
 * elemento si sigue entre los últimos 15 mensajes (message.updated, sin subir no leídos) o publica uno nuevo.
 */
export async function bumpCommentNotice(c: Tx, p: {
  kind: 'issue' | 'event' | 'mail'; conversationId: string; itemId: string; title: string; actorId: string; actorName: string; body: string;
}) {
  const key = p.kind === 'issue' ? 'issue.comments' : p.kind === 'mail' ? 'mail.comments' : 'event.comments';
  const idField = p.kind === 'issue' ? 'issueId' : p.kind === 'mail' ? 'emailId' : 'eventId';
  // Bloquea la conversación: dos comentarios simultáneos no crean dos avisos.
  const conv = (await c.query('SELECT last_message_seq FROM conversations WHERE id = $1 FOR UPDATE', [p.conversationId])).rows[0];
  if (!conv) return null;
  const { rows } = await c.query(
    `SELECT * FROM messages WHERE conversation_id = $1 AND seq > $2 AND kind = 'system' AND deleted_at IS NULL AND body LIKE $3 ORDER BY seq DESC`,
    [p.conversationId, Number(conv.last_message_seq) - COMMENT_WINDOW, `{"k":"${key}"%`],
  );
  const last = { lastById: p.actorId, lastByName: p.actorName, lastExcerpt: excerptOf(p.body) };
  for (const r of rows) {
    let b: any;
    try { b = JSON.parse(r.body); } catch { continue; }
    if (b[idField] !== p.itemId) continue;
    const { k: _k, ...prev } = b;
    const body = sys(key, { ...prev, title: p.title, count: Number(b.count ?? 1) + 1, ...last });
    const up = await c.query('UPDATE messages SET body = $2 WHERE id = $1 RETURNING *', [r.id, body]);
    const message = toMessageDTO(up.rows[0]);
    await appendEvent(c, p.conversationId, { type: 'message.updated', conversationId: p.conversationId, message }, r.id);
    return message;
  }
  return appendMessage(c, { conversationId: p.conversationId, authorId: p.actorId, kind: 'system', body: sys(key, { [idField]: p.itemId, title: p.title, count: 1, ...last }) });
}

/** Lo llama el worker cada 15 s: el aviso «es hoy» de cada evento, una sola vez. */
export async function fireTodayEvents(now = new Date()): Promise<number> {
  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, conversation_id, organizer_id, title, starts_at, ends_at, created_at, timezone FROM calendar_events
        WHERE today_posted_at IS NULL AND cancelled_at IS NULL AND starts_at < now() + interval '24 hours' AND starts_at > now() - interval '2 days'
        ORDER BY starts_at LIMIT 200 FOR UPDATE SKIP LOCKED`,
    );
    let posted = 0;
    for (const r of rows) {
      let d: 'post' | 'wait' | 'skip';
      try { d = todayDecision({ startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at), createdAt: new Date(r.created_at), timezone: r.timezone }, now); } catch { d = 'skip'; }
      if (d === 'wait') continue;
      await c.query('UPDATE calendar_events SET today_posted_at = now() WHERE id = $1', [r.id]);
      if (d === 'skip') continue;
      await appendMessage(c, {
        conversationId: r.conversation_id, authorId: r.organizer_id, kind: 'system',
        body: sys('event.today', { eventId: r.id, title: r.title, startsAt: new Date(r.starts_at).toISOString(), timezone: r.timezone }),
      });
      posted++;
    }
    return posted;
  });
}

/** Zona de la organización para los vencimientos (por ahora una sola). */
export const ORG_TZ = 'America/Bogota';

/**
 * Lo llama el worker cada minuto: tareas abiertas con fecha límite anterior a hoy (en ORG_TZ), una vez por
 * fecha. Las visibles para todos publican «No cumplimos» en su chat; todas avisan por push al responsable.
 */
export async function fireOverdueIssues(now = new Date()): Promise<number> {
  const today = localDate(now, ORG_TZ);
  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT i.id, i.title, i.conversation_id, i.owner_id, i.created_by, i.visibility, to_char(i.due_date, 'YYYY-MM-DD') AS due, u.name AS owner_name
         FROM issues i LEFT JOIN users u ON u.id = i.owner_id
        WHERE i.due_date IS NOT NULL AND i.due_date < $1::date AND i.status NOT IN ('done', 'cancelled')
          AND (i.overdue_posted_for IS NULL OR i.overdue_posted_for <> i.due_date)
        ORDER BY i.due_date LIMIT 200 FOR UPDATE OF i SKIP LOCKED`,
      [today],
    );
    for (const r of rows) {
      await c.query('UPDATE issues SET overdue_posted_for = due_date WHERE id = $1', [r.id]);
      if (r.conversation_id && r.visibility === 'all') {
        const archived = (await c.query('SELECT archived_at FROM conversations WHERE id = $1', [r.conversation_id])).rows[0]?.archived_at;
        if (!archived) {
          await appendMessage(c, {
            conversationId: r.conversation_id, authorId: r.owner_id ?? r.created_by, kind: 'system',
            body: sys('issue.overdue', { issueId: r.id, title: r.title, ownerId: r.owner_id ?? null, ownerName: r.owner_name ?? null, dueDate: r.due }),
          });
        }
      }
      if (r.owner_id) await c.query("INSERT INTO jobs (kind, payload, max_attempts) VALUES ('push.issue_overdue', $1, 2)", [JSON.stringify({ issueId: r.id, ownerId: r.owner_id, dueDate: r.due })]);
    }
    return rows.length;
  });
}
