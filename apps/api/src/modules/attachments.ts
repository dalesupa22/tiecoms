/**
 * Adjuntos de mensajes: subir (quedan pendientes), usarlos en un mensaje, servirlos
 * a quien puede leer ese mensaje y limpiar los pendientes viejos.
 * Reenviar crea filas nuevas que apuntan al mismo objeto S3: el archivo no se copia,
 * y un objeto solo se borra cuando ninguna fila lo usa (S3_ALLOW_DELETE).
 */
import { randomUUID } from 'node:crypto';
import type { AttachmentDTO, AttachmentSummaryDTO } from '@tiecoms/contracts';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { pool, type Tx } from '../db.ts';
import { ApiError, badRequest, forbidden, notFound } from '../errors.ts';
import { deleteObject, getObject, objectKey, putObject } from '../storage.ts';

export const MAX_THUMB_BYTES = 512 * 1024;
export const MAX_UPLOAD_BYTES = MAX_ATTACHMENT_BYTES;
const PENDING_HOURS = 24;

/** Tipos que se sirven con su propio Content-Type (y en línea); todo lo demás va como descarga octet-stream. */
const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'application/pdf',
]);

export const toDTO = (r: { id: string; name: string; content_type: string; size_bytes: number | string; width: number | null; height: number | null; thumb_key: string | null }): AttachmentDTO => ({
  id: r.id, name: r.name, contentType: r.content_type, sizeBytes: Number(r.size_bytes), width: r.width ?? null, height: r.height ?? null,
  url: `/api/v1/attachments/${r.id}`, thumbUrl: r.thumb_key ? `/api/v1/attachments/${r.id}/thumb` : null,
});

// ---------- Dimensiones sin librerías ----------
/** Tipo real por los primeros bytes (solo imágenes conocidas). */
export function sniffImage(b: Buffer): string | null {
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length > 6 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|heif)$/.test(b.toString('ascii', 8, 12))) return 'image/heic';
  return null;
}

/** Ancho y alto de PNG, JPEG, GIF, WebP y HEIC (caja ispe). null si no se puede leer. */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  try {
    const type = sniffImage(b);
    if (type === 'image/png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (type === 'image/gif') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (type === 'image/webp') {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
      if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
      return null;
    }
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1]!;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = b.readUInt16BE(i + 2);
        // SOF0..SOF15 salvo DHT (C4), JPG (C8) y DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          const height = b.readUInt16BE(i + 5), width = b.readUInt16BE(i + 7);
          return exifRotated(b) ? { width: height, height: width } : { width, height };
        }
        i += 2 + len;
      }
      return null;
    }
    if (type === 'image/heic') {
      const at = b.indexOf('ispe', 0, 'ascii');
      if (at > 0 && at + 16 <= b.length) return { width: b.readUInt32BE(at + 8), height: b.readUInt32BE(at + 12) };
    }
  } catch { /* archivo truncado */ }
  return null;
}

/** Orientación EXIF 5–8 (girada 90°): ancho y alto se invierten al mostrarla. */
function exifRotated(b: Buffer): boolean {
  const app1 = b.indexOf(Buffer.from('Exif\0\0', 'ascii'));
  if (app1 < 0 || app1 > 65536) return false;
  const t = app1 + 6;
  const le = b.toString('ascii', t, t + 2) === 'II';
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = t + u32(t + 4);
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (u16(e) === 0x0112) return u16(e + 8) >= 5 && u16(e + 8) <= 8;
  }
  return false;
}

function cleanName(raw: string | undefined): string {
  let name = '';
  try { name = decodeURIComponent(String(raw ?? '')); } catch { name = String(raw ?? ''); }
  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').replace(/^\.+/, '').trim().slice(0, 200);
  return name || 'archivo';
}

// ---------- Subir ----------
export async function upload(userId: string, conversationId: string, input: { body: Buffer; name?: string; type?: string }) {
  if (!Buffer.isBuffer(input.body) || !input.body.length) throw badRequest('Falta el archivo');
  if (input.body.length > MAX_ATTACHMENT_BYTES) throw new ApiError(413, 'too_large', 'El archivo pesa más de 25 MB');
  await conversationAccess(pool, userId, conversationId, 'post');
  const sniffed = sniffImage(input.body);
  const declared = String(input.type ?? '').toLowerCase().split(';')[0]!.trim();
  // Imágenes: manda el tipo real. Lo declarado como imagen que no lo es se guarda como archivo genérico.
  const contentType = sniffed ?? (declared.startsWith('image/') || !/^[a-z]+\/[\w.+-]+$/.test(declared) ? 'application/octet-stream' : declared);
  const size = sniffed ? imageSize(input.body) : null;
  const id = randomUUID();
  const key = objectKey(`attachments/${conversationId}/${id}`);
  await putObject(key, input.body, contentType);
  const { rows } = await pool.query(
    `INSERT INTO attachments (id, conversation_id, owner_id, name, content_type, size_bytes, width, height, s3_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [id, conversationId, userId, cleanName(input.name), contentType, input.body.length, size?.width ?? null, size?.height ?? null, key],
  );
  return toDTO(rows[0]);
}

/** Miniatura (JPEG/PNG/WebP ≤ 512 KB) que sube el propio cliente mientras el adjunto está pendiente. */
export async function uploadThumb(userId: string, attachmentId: string, body: Buffer) {
  if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Falta la miniatura');
  if (body.length > MAX_THUMB_BYTES) throw new ApiError(413, 'too_large', 'La miniatura pesa más de 512 KB');
  const type = sniffImage(body);
  if (!type || type === 'image/heic' || type === 'image/gif') throw badRequest('La miniatura debe ser JPEG, PNG o WebP');
  const { rows } = await pool.query('SELECT * FROM attachments WHERE id = $1 AND owner_id = $2 AND message_id IS NULL AND deleted_at IS NULL', [attachmentId, userId]);
  const a = rows[0];
  if (!a) throw notFound('Adjunto pendiente');
  const key = `${a.s3_key}.thumb`;
  await putObject(key, body, type);
  const up = await pool.query('UPDATE attachments SET thumb_key = $2, thumb_type = $3 WHERE id = $1 RETURNING *', [attachmentId, key, type]);
  return toDTO(up.rows[0]);
}

// ---------- Usar en un mensaje ----------
/**
 * Valida y bloquea los adjuntos de un envío (dentro de la transacción del mensaje).
 * Propios: míos, pendientes y de esta conversación. Reenviados: de mensajes que puedo leer;
 * se crean filas nuevas en esta conversación que apuntan al mismo objeto S3.
 */
export async function claimForMessage(c: Tx, userId: string, conversationId: string, ownIds: string[], forwardIds: string[]) {
  const own = [...new Set(ownIds)], fwd = [...new Set(forwardIds)];
  if (own.length + fwd.length > MAX_ATTACHMENTS_PER_MESSAGE) throw badRequest('Máximo 10 adjuntos por mensaje');
  const out: { id: string; dto: AttachmentDTO }[] = [];
  if (own.length) {
    const { rows } = await c.query(
      `SELECT * FROM attachments WHERE id = ANY($1) AND owner_id = $2 AND conversation_id = $3 AND message_id IS NULL AND deleted_at IS NULL FOR UPDATE`,
      [own, userId, conversationId],
    );
    if (rows.length !== own.length) throw badRequest('Algún adjunto no existe, ya se usó o es de otra conversación');
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    for (const id of own) out.push({ id, dto: toDTO(byId.get(id)) });
  }
  if (fwd.length) {
    const { rows } = await c.query(
      `SELECT a.*, m.seq AS message_seq FROM attachments a JOIN messages m ON m.id = a.message_id
        WHERE a.id = ANY($1) AND a.deleted_at IS NULL AND m.deleted_at IS NULL`,
      [fwd],
    );
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    for (const id of fwd) {
      const r = byId.get(id);
      if (!r) throw badRequest('Algún adjunto reenviado no existe');
      const acc = await conversationAccess(c, userId, r.conversation_id, 'read');
      if (r.message_seq <= acc.historyFromSeq) throw badRequest('Algún adjunto reenviado no existe');
      const copy = await c.query(
        `INSERT INTO attachments (conversation_id, owner_id, name, content_type, size_bytes, width, height, s3_key, thumb_key, thumb_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [conversationId, userId, r.name, r.content_type, r.size_bytes, r.width, r.height, r.s3_key, r.thumb_key, r.thumb_type],
      );
      out.push({ id: copy.rows[0].id, dto: toDTO(copy.rows[0]) });
    }
  }
  return out;
}

export async function linkToMessage(c: Tx, messageId: string, ids: string[]) {
  for (let i = 0; i < ids.length; i++) await c.query('UPDATE attachments SET message_id = $2, position = $3 WHERE id = $1', [ids[i], messageId, i]);
}

export async function hideForMessage(c: Tx, messageId: string) {
  await c.query('UPDATE attachments SET deleted_at = now() WHERE message_id = $1 AND deleted_at IS NULL', [messageId]);
}

// ---------- Servir ----------
/** Solo quien puede leer el mensaje (respeta historyFromSeq). Los pendientes, solo su dueño. */
export async function readable(userId: string, attachmentId: string) {
  const { rows } = await pool.query(
    'SELECT a.*, m.seq AS message_seq, m.deleted_at AS message_deleted_at FROM attachments a LEFT JOIN messages m ON m.id = a.message_id WHERE a.id = $1',
    [attachmentId],
  );
  const a = rows[0];
  if (!a || a.deleted_at || a.message_deleted_at) throw notFound('Adjunto');
  if (!a.message_id) { if (a.owner_id !== userId) throw notFound('Adjunto'); return a; }
  const acc = await conversationAccess(pool, userId, a.conversation_id, 'read').catch(() => { throw notFound('Adjunto'); });
  if (a.message_seq <= acc.historyFromSeq) throw forbidden('Este adjunto está fuera de tu historial');
  return a;
}

export async function fetchFile(userId: string, attachmentId: string, thumb: boolean) {
  const a = await readable(userId, attachmentId);
  const useThumb = thumb && !!a.thumb_key;
  const obj = await getObject(useThumb ? a.thumb_key : a.s3_key);
  const type = useThumb ? a.thumb_type : a.content_type;
  return { body: obj.body, name: a.name as string, contentType: INLINE_TYPES.has(type) ? type : 'application/octet-stream', inline: INLINE_TYPES.has(type) };
}

// ---------- Resúmenes ----------
export function summarize(list: AttachmentDTO[] | null | undefined): AttachmentSummaryDTO | null {
  if (!list?.length) return null;
  const images = list.filter((a) => a.contentType.startsWith('image/')).length;
  const videos = list.filter((a) => a.contentType.startsWith('video/')).length;
  return { count: list.length, images, videos, files: list.length - images - videos, firstName: list[0]?.name ?? null };
}

/** Texto corto para vistas previas y push. */
export function summaryText(s: AttachmentSummaryDTO, lang: 'es' | 'en') {
  const es = lang === 'es';
  if (s.images === s.count) return s.count === 1 ? (es ? '📷 Foto' : '📷 Photo') : `📷 ${s.count} ${es ? 'fotos' : 'photos'}`;
  if (s.videos === s.count) return s.count === 1 ? '🎬 Video' : `🎬 ${s.count} ${es ? 'videos' : 'videos'}`;
  if (s.images + s.videos === s.count) return `🖼 ${s.count} ${es ? 'fotos y videos' : 'photos and videos'}`;
  return s.count === 1 ? `📎 ${s.firstName ?? (es ? 'Archivo' : 'File')}` : `📎 ${s.count} ${es ? 'archivos' : 'files'}`;
}

// ---------- Limpieza ----------
/** Pendientes de más de 24 h: se borran las filas y el objeto si ninguna otra fila lo usa. */
export async function cleanupPending() {
  const { rows } = await pool.query(
    `DELETE FROM attachments WHERE message_id IS NULL AND created_at < now() - make_interval(hours => $1) RETURNING s3_key, thumb_key`,
    [PENDING_HOURS],
  );
  for (const r of rows) {
    const still = await pool.query('SELECT 1 FROM attachments WHERE s3_key = $1 LIMIT 1', [r.s3_key]);
    if (still.rowCount) continue;
    await deleteObject(r.s3_key).catch(() => {});
    if (r.thumb_key) await deleteObject(r.thumb_key).catch(() => {});
  }
  return rows.length;
}
