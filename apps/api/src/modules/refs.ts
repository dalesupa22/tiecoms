/**
 * #grupos (docs/TANDA-1.7.md §1): tramos del body que empiezan con «#» y apuntan a una conversación que el
 * AUTOR puede leer. Lo inválido se descarta sin error (como las menciones). Se guarda el nombre de ese momento.
 */
import type { MessageRefDTO } from '@tiecoms/contracts';
import { MAX_REFS_PER_MESSAGE } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import type { Db } from '../db.ts';

export async function normalizeRefs(
  db: Db, authorId: string, body: string, input: { conversationId: string; start: number; length: number }[] | undefined,
): Promise<MessageRefDTO[]> {
  if (!input?.length) return [];
  const out: MessageRefDTO[] = [];
  const sorted = [...input].sort((a, b) => a.start - b.start);
  let lastEnd = -1;
  const names = new Map<string, string | null>();
  for (const r of sorted) {
    if (out.length >= MAX_REFS_PER_MESSAGE) break;
    if (!(r.start >= 0 && r.start + r.length <= body.length && body[r.start] === '#' && r.start >= lastEnd)) continue;
    if (!names.has(r.conversationId)) names.set(r.conversationId, await refName(db, authorId, r.conversationId));
    const name = names.get(r.conversationId);
    if (!name) continue;
    out.push({ conversationId: r.conversationId, name, start: r.start, length: r.length });
    lastEnd = r.start + r.length;
  }
  return out;
}

/** Nombre visible para el autor, o null si no puede leer la conversación. */
async function refName(db: Db, authorId: string, conversationId: string): Promise<string | null> {
  try {
    await conversationAccess(db, authorId, conversationId, 'read');
  } catch { return null; }
  const { rows } = await db.query(
    `SELECT c.name, c.kind,
            ARRAY(SELECT u.name FROM conversation_memberships cm JOIN users u ON u.id = cm.user_id
                   WHERE cm.conversation_id = c.id AND cm.removed_at IS NULL AND cm.user_id <> $2 ORDER BY cm.joined_at LIMIT 3) AS others
       FROM conversations c WHERE c.id = $1`,
    [conversationId, authorId],
  );
  const c = rows[0];
  if (!c) return null;
  const name = c.name || (c.others as string[]).join(', ');
  return name ? String(name).slice(0, 120) : 'chat';
}
