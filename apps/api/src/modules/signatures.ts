/**
 * Firmar PDFs desde el chat.
 *
 * Firmas guardadas: PNG transparentes (dibujadas, escritas o de una foto: el cliente las deja listas)
 * que solo ve su dueño. Van bajo drive/me/<usuario>/ para que el borrado de cuenta pueda eliminarlas.
 *
 * Firmar: el cliente manda dónde va cada marca (proporciones de la página tal como se ve) y el servidor
 * estampa con pdf-lib, sube el resultado como adjunto nuevo de la misma conversación y responde en el
 * hilo del original. pdf_signings guarda la constancia (huellas SHA-256, quién, cuándo, IP, dispositivo).
 * Es firma electrónica (Ley 527 de 1999 / Decreto 2364 de 2012), no firma digital con certificado.
 */
import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import {
  MAX_ATTACHMENT_BYTES, MAX_SAVED_SIGNATURES, MAX_SIGNATURE_BYTES,
  type AttachmentDTO, type AttachmentSigningDTO, type MessageDTO, type SignatureDTO, type SignPdfResult, type SignPlacementInput,
} from '@tiecoms/contracts';
import { conversationAccess } from '../access.ts';
import { pool } from '../db.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { getObject, objectKey, putObject } from '../storage.ts';
import { cleanName, imageSize, readable, sniffImage, toDTO } from './attachments.ts';
import { sendMessage, toMessageDTO } from './messages.ts';

const MAX_SIGNATURE_SIDE = 2400;
const DEFAULT_TZ = 'America/Bogota';

// ---------- Firmas guardadas ----------
const toSignatureDTO = (r: any): SignatureDTO => ({
  id: r.id, kind: r.kind, source: r.source, width: r.width, height: r.height,
  url: `/api/v1/me/signatures/${r.id}/image`, createdAt: new Date(r.created_at).toISOString(),
});

export async function listSignatures(userId: string) {
  const { rows } = await pool.query('SELECT * FROM user_signatures WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC', [userId]);
  return rows.map(toSignatureDTO);
}

export async function createSignature(userId: string, body: Buffer, kind: string, source: string) {
  if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Falta la imagen de la firma');
  if (body.length > MAX_SIGNATURE_BYTES) throw new ApiError(413, 'too_large', 'La firma pesa más de 512 KB');
  if (sniffImage(body) !== 'image/png') throw badRequest('La firma debe ser un PNG');
  const size = imageSize(body);
  if (!size || size.width < 8 || size.height < 8 || size.width > MAX_SIGNATURE_SIDE || size.height > MAX_SIGNATURE_SIDE) throw badRequest('Tamaño de firma inválido');
  const k = kind === 'initials' ? 'initials' : 'signature';
  const src = ['drawn', 'typed', 'uploaded'].includes(source) ? source : 'drawn';
  const { rows: [count] } = await pool.query('SELECT count(*)::int AS n FROM user_signatures WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
  if (count.n >= MAX_SAVED_SIGNATURES) throw new ApiError(409, 'too_many_signatures', `Puedes guardar hasta ${MAX_SAVED_SIGNATURES} firmas; borra alguna primero`);
  // pdf-lib valida el PNG mejor que la cabecera: si no lo puede incrustar, no sirve para firmar.
  try { await (await PDFDocument.create()).embedPng(body); } catch { throw badRequest('No pude leer ese PNG'); }
  const id = randomUUID();
  const key = objectKey(`drive/me/${userId}/signatures/${id}.png`);
  await putObject(key, body, 'image/png');
  const { rows } = await pool.query(
    'INSERT INTO user_signatures (id, user_id, kind, source, s3_key, width, height) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [id, userId, k, src, key, size.width, size.height],
  );
  return toSignatureDTO(rows[0]);
}

export async function signatureImage(userId: string, id: string) {
  const { rows } = await pool.query('SELECT s3_key FROM user_signatures WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [id, userId]);
  if (!rows[0]) throw notFound('Firma');
  return (await getObject(rows[0].s3_key)).body;
}

/** Retira la firma y borra el PNG (con reintentos en el worker). Lo ya firmado no cambia. */
export async function deleteSignature(userId: string, id: string) {
  const { rows } = await pool.query(
    'UPDATE user_signatures SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING s3_key', [id, userId],
  );
  if (!rows[0]) throw notFound('Firma');
  await pool.query(
    `INSERT INTO jobs (kind, payload, dedupe_key) VALUES ('signature.delete', $1, $2) ON CONFLICT (dedupe_key) DO NOTHING`,
    [JSON.stringify({ key: rows[0].s3_key }), `delete-signature:${id}`],
  );
  return { ok: true };
}

// ---------- Lectura del PDF sin cargarlo entero ----------
const isPdf = (b: Buffer) => b.subarray(0, 1024).includes('%PDF-');
/** Ya firmado digitalmente (PAdES/CMS): reescribirlo invalida esa firma. */
export const hasDigitalSignature = (b: Buffer) => b.includes('/ByteRange') && /\/(Type\s*\/Sig|SubFilter)\b/.test(b.toString('latin1'));
export const isEncrypted = (b: Buffer) => /\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt\s*<</.test(b.toString('latin1'));
const hex = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

async function loadPdfAttachment(userId: string, attachmentId: string) {
  const a = await readable(userId, attachmentId);
  if (a.kind === 'voice') throw badRequest('Solo se pueden firmar PDFs');
  const body = (await getObject(a.s3_key)).body;
  if (!isPdf(body)) throw new ApiError(422, 'not_pdf', 'Este archivo no es un PDF');
  return { a, body };
}

/** Lo que el visor necesita saber antes de firmar. */
export async function signInfo(userId: string, attachmentId: string) {
  const { a, body } = await loadPdfAttachment(userId, attachmentId);
  const { rows } = await pool.query(
    `SELECT s.*, u.name AS signer_name FROM pdf_signings s JOIN users u ON u.id = s.user_id
      WHERE s.source_attachment_id = $1 OR s.result_attachment_id = $1 ORDER BY s.created_at`, [attachmentId],
  );
  return {
    attachmentId, name: a.name as string, sizeBytes: body.length,
    hasDigitalSignature: hasDigitalSignature(body), encrypted: isEncrypted(body),
    signing: a.signing ?? null,
    history: rows.map(signingDTO),
  };
}

const signingDTO = (r: any): AttachmentSigningDTO => ({
  id: r.id, signerId: r.user_id, signerName: r.signer_name, signedAt: new Date(r.created_at).toISOString(),
  originalSha256: Buffer.from(r.original_sha256).toString('hex'), signedSha256: Buffer.from(r.signed_sha256).toString('hex'),
});

// ---------- Geometría ----------
export interface CropBox { x: number; y: number; width: number; height: number }
/** Tamaño de la página tal como se ve (con /Rotate aplicado). */
export const displaySize = (box: CropBox, rotation: number) => (rotation % 180 === 0 ? { w: box.width, h: box.height } : { w: box.height, h: box.width });
export const normRotation = (angle: number) => (((Math.round(angle / 90) * 90) % 360) + 360) % 360;

/**
 * Punto de la página vista (origen arriba a la izquierda, en puntos) → espacio del PDF
 * (origen abajo a la izquierda, sin girar). /Rotate gira la página en sentido horario al mostrarla.
 */
export function displayToPdf(box: CropBox, rotation: number, dx: number, dy: number) {
  const { x, y, width: W, height: H } = box;
  switch (rotation) {
    case 90: return { x: x + dy, y: y + dx };
    case 180: return { x: x + W - dx, y: y + dy };
    case 270: return { x: x + W - dy, y: y + H - dx };
    default: return { x: x + dx, y: y + H - dy };
  }
}

// ---------- Texto (fuentes estándar: WinAnsi) ----------
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
/** Letras que NFD no descompone. */
const LOOKALIKE: Record<string, string> = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', ı: 'i', Ħ: 'H', ħ: 'h', '‐': '-', '‑': '-', '−': '-' };
/** Deja solo caracteres que Helvetica estándar sabe escribir (quita tildes raras, cambia el resto por «?»). */
export function winAnsi(text: string) {
  let out = '';
  for (const ch of text.normalize('NFC').replace(/[\r\n\t]+/g, ' ')) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(ch)) { out += ch; continue; }
    const base = LOOKALIKE[ch] ?? ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const b = base.codePointAt(0) ?? 0;
    out += base.length === 1 && ((b >= 0x20 && b <= 0x7e) || (b >= 0xa0 && b <= 0xff)) ? base : '?';
  }
  return out;
}

function validTimeZone(tz: string | undefined) {
  if (!tz) return DEFAULT_TZ;
  try { new Intl.DateTimeFormat('es-CO', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
}
export function formatWhen(d: Date, tz: string, lang: 'es' | 'en') {
  const f = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'es-CO', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  return f.format(d).replace(/ /g, ' ');
}

// ---------- Estampar ----------
export interface StampOptions {
  signerName: string; signerEmail: string | null; signedAt: Date; timeZone: string; lang: 'es' | 'en';
  stamp: boolean; certificate: boolean; signingId: string; documentName: string; originalSha256: string; ip: string | null;
}

/** Estampa las marcas y (si se pide) agrega la hoja de constancia. Devuelve los bytes y el total de páginas del original. */
export async function stampPdf(pdf: Buffer, placements: SignPlacementInput[], images: Map<string, Buffer>, o: StampOptions) {
  let doc: PDFDocument, pages: PDFPage[];
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false });
    pages = doc.getPages();
    if (!pages.length) throw new Error('sin páginas');
  } catch (e: any) {
    if (/encrypt/i.test(String(e?.message ?? e))) throw new ApiError(422, 'encrypted_pdf', 'Este PDF tiene contraseña o está protegido: no se puede firmar');
    throw new ApiError(422, 'invalid_pdf', 'No pude leer este PDF');
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const embedded = new Map<string, PDFImage>();
  for (const [id, png] of images) embedded.set(id, await doc.embedPng(png));
  const when = formatWhen(o.signedAt, o.timeZone, o.lang);
  const caption = winAnsi(`${o.lang === 'en' ? 'Electronically signed by' : 'Firmado electrónicamente por'} ${o.signerName} · ${when}`);

  for (const p of placements) {
    const page = pages[p.page - 1];
    if (!page) throw badRequest(`El PDF no tiene página ${p.page}`);
    const rotation = normRotation(page.getRotation().angle);
    const box = page.getCropBox();
    const { w: DW, h: DH } = displaySize(box, rotation);
    const bx = p.x * DW, by = p.y * DH, bw = p.w * DW, bh = p.h * DH;
    if (p.type === 'signature') {
      const img = embedded.get(p.signatureId);
      if (!img) throw badRequest('Firma no encontrada');
      const at = displayToPdf(box, rotation, bx, by + bh);
      page.drawImage(img, { x: at.x, y: at.y, width: bw, height: bh, rotate: degrees(rotation) });
      if (o.stamp) drawCaption(page, font, caption, box, rotation, DW, DH, bx, by, bw, bh);
    } else {
      const text = winAnsi(p.text);
      const size = Math.max(4, Math.min(bh * 0.78, bw / Math.max(1e-6, font.widthOfTextAtSize(text, 1))));
      // Línea base centrada en la caja: la altura visible de Helvetica ≈ 0,72 del tamaño.
      const baseline = by + bh / 2 + size * 0.36;
      const at = displayToPdf(box, rotation, bx, baseline);
      page.drawText(text, { x: at.x, y: at.y, size, font, color: rgb(0.06, 0.07, 0.12), rotate: degrees(rotation) });
    }
  }
  if (o.certificate) addCertificate(doc, font, bold, o, when, pages.length, placements.length);
  const out = Buffer.from(await doc.save());
  return { bytes: out, pages: pages.length };
}

/** Sello gris y pequeño justo debajo de la firma (o encima si no cabe), sin salirse de la página. */
function drawCaption(page: PDFPage, font: PDFFont, text: string, box: CropBox, rotation: number, DW: number, DH: number, bx: number, by: number, bw: number, bh: number) {
  let size = Math.max(4, Math.min(6.5, bh * 0.14));
  const room = Math.max(bw, Math.min(DW - 8, 180));
  size = Math.max(3.5, Math.min(size, room / font.widthOfTextAtSize(text, 1)));
  const width = font.widthOfTextAtSize(text, size);
  const left = Math.max(4, Math.min(bx, DW - 4 - width));
  let baseline = by + bh + size * 1.05;
  if (baseline > DH - 2) baseline = Math.max(size + 2, by - size * 0.4);
  const at = displayToPdf(box, rotation, left, baseline);
  page.drawText(text, { x: at.x, y: at.y, size, font, color: rgb(0.38, 0.4, 0.46), rotate: degrees(rotation) });
}

function addCertificate(doc: PDFDocument, font: PDFFont, bold: PDFFont, o: StampOptions, when: string, pages: number, marks: number) {
  const en = o.lang === 'en';
  const page = doc.addPage([612, 792]);
  const ink = rgb(0.06, 0.07, 0.12), muted = rgb(0.38, 0.4, 0.46);
  let y = 720;
  const line = (label: string, value: string, mono = false) => {
    page.drawText(winAnsi(label), { x: 64, y, size: 9, font: bold, color: muted });
    y -= 15;
    for (const chunk of wrap(winAnsi(value), mono ? 64 : 80)) { page.drawText(chunk, { x: 64, y, size: mono ? 9.5 : 11, font, color: ink }); y -= 15; }
    y -= 10;
  };
  page.drawText(en ? 'Electronic signature record' : 'Constancia de firma electrónica', { x: 64, y: 752, size: 18, font: bold, color: ink });
  page.drawLine({ start: { x: 64, y: 740 }, end: { x: 548, y: 740 }, thickness: 0.8, color: rgb(0.85, 0.86, 0.9) });
  line(en ? 'DOCUMENT' : 'DOCUMENTO', `${o.documentName} (${pages} ${en ? (pages === 1 ? 'page' : 'pages') : (pages === 1 ? 'página' : 'páginas')})`);
  line(en ? 'SIGNED BY' : 'FIRMADO POR', o.signerEmail ? `${o.signerName} <${o.signerEmail}>` : o.signerName);
  line(en ? 'DATE' : 'FECHA', when);
  line(en ? 'MARKS PLACED' : 'MARCAS ESTAMPADAS', String(marks));
  line(en ? 'ORIGINAL DOCUMENT FINGERPRINT (SHA-256)' : 'HUELLA DEL DOCUMENTO ORIGINAL (SHA-256)', o.originalSha256, true);
  if (o.ip) line(en ? 'IP ADDRESS' : 'DIRECCIÓN IP', o.ip);
  line(en ? 'RECORD ID' : 'ID DE CONSTANCIA', o.signingId, true);
  y -= 6;
  const note = en
    ? 'Electronic signature placed with Chaggu. The signer was authenticated with their Chaggu account. The fingerprint of the signed file is kept in the Chaggu record together with this data.'
    : 'Firma electrónica realizada con Chaggu (Ley 527 de 1999 y Decreto 2364 de 2012). Quien firma se autenticó con su cuenta de Chaggu. La huella del archivo firmado queda registrada en Chaggu junto con estos datos.';
  for (const chunk of wrap(winAnsi(note), 95)) { page.drawText(chunk, { x: 64, y, size: 8.5, font, color: muted }); y -= 12; }
}

function wrap(text: string, max: number) {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    if (word.length > max) { if (cur) out.push(cur); for (let i = 0; i < word.length; i += max) out.push(word.slice(i, i + max)); cur = ''; continue; }
    if ((cur ? cur.length + 1 : 0) + word.length > max) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- Firmar ----------
/** Máximo 2 PDFs estampándose a la vez por proceso (pdf-lib carga el archivo entero en memoria). */
let running = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

function signedName(name: string) {
  const base = name.replace(/\.pdf$/i, '');
  return cleanName(`${base} (firmado).pdf`);
}

export async function signPdf(userId: string, attachmentId: string, input: {
  clientMessageId: string; body: string; placements: SignPlacementInput[]; stamp: boolean; certificate: boolean; acceptBreakingSignatures: boolean; timeZone?: string;
}, meta: { ip: string | null; userAgent: string | null; lang: 'es' | 'en' }): Promise<SignPdfResult> {
  const a = await readable(userId, attachmentId);
  const conversationId: string = a.conversation_id;
  await conversationAccess(pool, userId, conversationId, 'post');

  // Reintento del mismo envío: devuelve lo que ya quedó.
  const prev = await pool.query('SELECT * FROM messages WHERE conversation_id = $1 AND author_id = $2 AND client_message_id = $3', [conversationId, userId, input.clientMessageId]);
  if (prev.rows[0]) return duplicateResult(toMessageDTO(prev.rows[0]));

  const sigIds = [...new Set(input.placements.flatMap((p) => (p.type === 'signature' ? [p.signatureId] : [])))];
  if (!sigIds.length) throw badRequest('Agrega al menos una firma');
  const { rows: sigs } = await pool.query('SELECT id, s3_key FROM user_signatures WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NULL', [sigIds, userId]);
  if (sigs.length !== sigIds.length) throw badRequest('Alguna firma no existe o no es tuya');

  const { body: original } = await loadPdfAttachment(userId, attachmentId);
  if (isEncrypted(original)) throw new ApiError(422, 'encrypted_pdf', 'Este PDF tiene contraseña o está protegido: no se puede firmar');
  if (hasDigitalSignature(original) && !input.acceptBreakingSignatures) {
    throw new ApiError(409, 'has_digital_signature', 'Este PDF ya tiene una firma digital; al firmarlo aquí esa firma deja de ser válida');
  }
  const images = new Map<string, Buffer>();
  for (const s of sigs) images.set(s.id, (await getObject(s.s3_key)).body);

  const { rows: [user] } = await pool.query('SELECT name, email FROM users WHERE id = $1', [userId]);
  const signingId = randomUUID();
  const signedAt = new Date();
  const originalSha256 = hex(original);
  const { bytes, pages } = await withSlot(() => stampPdf(original, input.placements, images, {
    signerName: user.name, signerEmail: user.email ?? null, signedAt, timeZone: validTimeZone(input.timeZone), lang: meta.lang,
    stamp: input.stamp, certificate: input.certificate, signingId, documentName: a.name, originalSha256, ip: meta.ip,
  }));
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new ApiError(413, 'too_large', 'El PDF firmado pesa más de 25 MB');

  const signing: AttachmentSigningDTO = {
    id: signingId, signerId: userId, signerName: user.name, signedAt: signedAt.toISOString(), originalSha256, signedSha256: hex(bytes),
  };
  const newId = randomUUID();
  const key = objectKey(`attachments/${conversationId}/${newId}`);
  await putObject(key, bytes, 'application/pdf');
  await pool.query(
    `INSERT INTO attachments (id, conversation_id, owner_id, name, content_type, size_bytes, s3_key, signing)
     VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,$7)`,
    [newId, conversationId, userId, signedName(a.name), bytes.length, key, JSON.stringify(signing)],
  );
  const body = input.body || (meta.lang === 'en' ? '✍️ Signed document' : '✍️ Documento firmado');
  const sent = await sendMessage(userId, conversationId, {
    clientMessageId: input.clientMessageId, body, attachmentIds: [newId],
    ...(a.message_id ? { replyTo: a.message_id } : {}),
  });
  if (sent.duplicate) return duplicateResult(sent.message);
  await pool.query(
    `INSERT INTO pdf_signings (id, user_id, conversation_id, source_attachment_id, result_attachment_id, message_id, original_sha256, signed_sha256, placements, pages, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [signingId, userId, conversationId, attachmentId, newId, sent.message.id, Buffer.from(originalSha256, 'hex'), Buffer.from(signing.signedSha256, 'hex'),
      JSON.stringify(input.placements), pages, meta.ip, meta.userAgent?.slice(0, 300) ?? null],
  );
  const attachment = sent.message.attachments?.find((x) => x.id === newId) ?? toDTO((await pool.query('SELECT * FROM attachments WHERE id = $1', [newId])).rows[0]);
  return { message: sent.message, attachment, signing, duplicate: false };
}

function duplicateResult(message: MessageDTO): SignPdfResult {
  const attachment: AttachmentDTO | undefined = message.attachments?.find((x) => x.signing);
  if (!attachment?.signing) throw new ApiError(409, 'conflict', 'clientMessageId reutilizado con otro contenido');
  return { message, attachment, signing: attachment.signing, duplicate: true };
}
