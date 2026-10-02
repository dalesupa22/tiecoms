import { PersonalPreferencesInput, type NoteDTO, type NoteInput, type PersonalPreferencesDTO } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { pool, tx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { getIssue } from './issues.ts';

async function dto(db: Db, row: any): Promise<NoteDTO> {
  const files = row.file_ids.length ? await db.query(
    `SELECT id, folder_id, name, content_type, size_bytes, owner_id, created_at, updated_at
       FROM files WHERE id = ANY($1) AND owner_id = $2 AND workspace_id IS NULL AND conversation_id IS NULL AND purpose = 'document' AND deleted_at IS NULL`, [row.file_ids, row.owner_id],
  ) : { rows: [] };
  return { id: row.id, title: row.title, body: row.body, tags: row.tags, fileIds: row.file_ids, links: row.links,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    files: files.rows.map((f) => ({ id: f.id, folderId: f.folder_id, name: f.name, contentType: f.content_type, size: f.size_bytes, visibility: 'private' as const, createdBy: f.owner_id, createdAt: new Date(f.created_at).toISOString(), updatedAt: new Date(f.updated_at).toISOString() })),
  };
}

export async function listNotes(userId: string) {
  const { rows } = await pool.query('SELECT * FROM personal_notes WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT 1000', [userId]);
  return Promise.all(rows.map((row) => dto(pool, row)));
}

async function checkInput(db: Db, userId: string, input: NoteInput) {
  for (const tag of input.tags) {
    if (tag.kind === 'conversation') await conversationAccess(db, userId, tag.id!, 'read');
    if (tag.kind === 'issue') await getIssue(userId, tag.id!, db);
  }
  if (input.fileIds.length) {
    const ids = [...new Set(input.fileIds)];
    const files = await db.query("SELECT id FROM files WHERE id = ANY($1) AND owner_id = $2 AND workspace_id IS NULL AND conversation_id IS NULL AND purpose = 'document' AND deleted_at IS NULL", [ids, userId]);
    if (files.rowCount !== ids.length) throw badRequest('Los adjuntos de una nota deben estar en tus archivos privados');
  }
}

/** The only owner is the authenticated account. Labels do not alter chat membership or create messages. */
export async function saveNote(userId: string, input: NoteInput, id?: string) {
  return tx(async (db) => {
    if (id && !(await db.query('SELECT 1 FROM personal_notes WHERE id = $1 AND owner_id = $2 FOR UPDATE', [id, userId])).rowCount) throw notFound('Nota');
    await checkInput(db, userId, input);
    const values = [userId, input.title, input.body, JSON.stringify(input.tags), [...new Set(input.fileIds)], JSON.stringify(input.links)];
    const { rows } = id
      ? await db.query('UPDATE personal_notes SET title=$2, body=$3, tags=$4, file_ids=$5, links=$6, updated_at=now() WHERE owner_id=$1 AND id=$7 RETURNING *', [...values, id])
      : await db.query('INSERT INTO personal_notes (owner_id,title,body,tags,file_ids,links) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', values);
    return dto(db, rows[0]);
  });
}

export async function deleteNote(userId: string, id: string) {
  const { rowCount } = await pool.query('DELETE FROM personal_notes WHERE id = $1 AND owner_id = $2', [id, userId]);
  if (!rowCount) throw notFound('Nota');
  return { ok: true };
}

export async function getPersonalPreferences(userId: string): Promise<PersonalPreferencesDTO> {
  const { rows } = await pool.query('SELECT preferences FROM user_personal_preferences WHERE user_id=$1', [userId]);
  return { sections: [], conversations: {}, ...rows[0]?.preferences };
}

export async function setPersonalPreferences(userId: string, input: Partial<Omit<PersonalPreferencesDTO,'appearance'>> & { appearance?: Partial<NonNullable<PersonalPreferencesDTO['appearance']>> }, merge = false, presentKeys = Object.keys(input)) {
  return tx(async (db) => {
    // Lock the owner even before a preferences row exists, preventing first-write races.
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const old = await db.query('SELECT preferences FROM user_personal_preferences WHERE user_id=$1', [userId]);
    const previous = { sections: [], conversations: {}, ...old.rows[0]?.preferences };
    const chosen = Object.fromEntries(Object.entries(input).filter(([key]) => presentKeys.includes(key)));
    const combined = { ...previous, ...chosen,
      ...(chosen.issues ? { issues: { ...previous.issues, ...input.issues } } : {}),
      ...(merge && chosen.appearance ? { appearance: { mode: 'system', accent: null, ...previous.appearance, ...input.appearance } } : {}),
    };
    const value = PersonalPreferencesInput.parse(combined);
    for (const id of Object.keys(value.conversations)) if (!Object.hasOwn(previous.conversations, id)) await conversationAccess(db, userId, id, 'read');
    await db.query('INSERT INTO user_personal_preferences (user_id,preferences) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET preferences=EXCLUDED.preferences, updated_at=now()', [userId, JSON.stringify(value)]);
    return value;
  });
}
