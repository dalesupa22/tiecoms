/**
 * Medición de almacenamiento (docs/VIDEO.md): bytes en S3 por persona y por empresa, para cobrar más adelante.
 * Todavía no bloquea nada. Suma adjuntos del chat (pendientes incluidos, ocupan espacio hasta la limpieza) y
 * archivos del árbol (Drive). Cada objeto de S3 cuenta UNA vez: el reenvío crea otra fila con el mismo s3_key y
 * la cuenta la lleva la primera fila viva de ese objeto (created_at, id). Lo borrado (deleted_at) no cuenta.
 * Las miniaturas y la variante AAC de las notas de voz no se cuentan (pesan poco y no guardamos su tamaño).
 */
import type { StorageUsageDTO } from '@tiecoms/contracts';
import { pool } from '../db.ts';
import { forbidden, notFound } from '../errors.ts';

const CATEGORY = (t: string) => `CASE WHEN ${t}.content_type LIKE 'video/%' THEN 'videos' WHEN ${t}.content_type LIKE 'image/%' THEN 'photos' ELSE 'files' END`;

/** owners: fragmento SQL que devuelve los owner_id a sumar (con $1). */
async function measure(owners: string, param: string) {
  const { rows } = await pool.query(
    `WITH o AS (${owners}),
     objs AS (
       SELECT a.owner_id, a.size_bytes, CASE WHEN a.kind = 'voice' THEN 'voice' ELSE ${CATEGORY('a')} END AS cat, 'chat' AS src
         FROM attachments a
        WHERE a.owner_id IN (SELECT id FROM o) AND a.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM attachments b WHERE b.s3_key = a.s3_key AND b.deleted_at IS NULL AND (b.created_at, b.id) < (a.created_at, a.id))
       UNION ALL
       SELECT f.owner_id, f.size_bytes, ${CATEGORY('f')}, 'drive'
         FROM files f
        WHERE f.owner_id IN (SELECT id FROM o) AND f.purpose = 'document' AND f.deleted_at IS NULL
     )
     SELECT cat, src, count(*)::int AS n, COALESCE(sum(size_bytes), 0)::bigint AS bytes, count(DISTINCT owner_id)::int AS people
       FROM objs GROUP BY GROUPING SETS ((cat, src), ())`,
    [param],
  );
  const breakdown = { videos: 0, photos: 0, files: 0, voice: 0 };
  const bySource = { chat: 0, drive: 0 };
  let totalBytes = 0, objects = 0, people = 0;
  for (const r of rows) {
    const bytes = Number(r.bytes);
    if (r.cat === null) { totalBytes = bytes; objects = r.n; people = r.people; continue; }
    breakdown[r.cat as keyof typeof breakdown] += bytes;
    bySource[r.src as keyof typeof bySource] += bytes;
  }
  return { totalBytes, objects, breakdown, bySource, people, measuredAt: new Date().toISOString() };
}

export async function myStorage(userId: string): Promise<StorageUsageDTO> {
  const { people: _p, ...m } = await measure('SELECT $1::uuid AS id', userId);
  return { scope: 'user', id: userId, ...m };
}

/** Empresa = personas cuya empresa principal es esta. Solo quien la administra (owner/admin). */
export async function orgStorage(userId: string, orgId: string): Promise<StorageUsageDTO> {
  const { rows } = await pool.query('SELECT role FROM organization_memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  if (!rows[0]) throw notFound('Empresa');
  if (!['owner', 'admin'].includes(rows[0].role)) throw forbidden('Solo quien administra la empresa ve su almacenamiento');
  const m = await measure('SELECT id FROM users WHERE primary_org_id = $1::uuid', orgId);
  return { scope: 'organization', id: orgId, ...m };
}
