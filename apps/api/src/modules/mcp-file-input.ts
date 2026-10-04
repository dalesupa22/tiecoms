import { MAX_ATTACHMENT_BYTES } from '@tiecoms/contracts';
import { ApiError, badRequest } from '../errors.ts';

export const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);
export const MCP_BODY_LIMIT = 36 * 1024 * 1024;

/** Strict canonical RFC 4648 base64; reject oversize input before allocating decoded bytes. */
export function decodeFile(data: string): Buffer {
  if (data.length > MAX_BASE64_LENGTH) throw new ApiError(413, 'too_large', 'El archivo pesa más de 25 MB');
  if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw badRequest('data_base64 debe ser base64 estándar, sin espacios ni prefijo data:');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = alphabet.indexOf(data[data.length - padding - 1]!);
  if ((padding === 2 && (last & 15)) || (padding === 1 && (last & 3))) throw badRequest('data_base64 no es canónico');
  if ((data.length / 4) * 3 - padding > MAX_ATTACHMENT_BYTES) throw new ApiError(413, 'too_large', 'El archivo pesa más de 25 MB');
  return Buffer.from(data, 'base64');
}

/** MIME syntax is bounded here; the product image sniffer validates actual image bytes separately. */
export function validateFileType(body: Buffer, declared: string, sniffedImage: string | null, imageDimensions: { width: number; height: number } | null): string {
  const type = declared.toLowerCase().trim();
  if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(type)) throw badRequest('content_type debe ser un tipo MIME sin parámetros');
  const unsupported = () => new ApiError(415, 'unsupported_type', 'El contenido no coincide con el tipo admitido; usa una imagen válida, PDF, texto UTF-8, JSON, ZIP o application/octet-stream para otros archivos');
  if (sniffedImage) {
    if (type !== sniffedImage && type !== 'application/octet-stream' && !(type === 'image/heif' && sniffedImage === 'image/heic')) throw unsupported();
    if (!imageDimensions || imageDimensions.width < 1 || imageDimensions.height < 1) throw unsupported();
    return sniffedImage;
  }
  if (type.startsWith('image/')) throw unsupported();
  const pdf = /^%PDF-\d\.\d/.test(body.toString('ascii', 0, 8));
  if (type === 'application/pdf' || pdf) {
    if (!pdf || (type !== 'application/pdf' && type !== 'application/octet-stream') || !body.subarray(-1024).includes(Buffer.from('%%EOF'))) throw unsupported();
    return 'application/pdf';
  }
  if (['text/plain', 'text/csv', 'text/markdown', 'application/json'].includes(type)) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      if (text.includes('\0')) throw new Error('binary');
      if (type === 'application/json') JSON.parse(text);
    } catch { throw unsupported(); }
    return type;
  }
  if (type === 'application/zip') {
    if (body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b || ![0x0403, 0x0605, 0x0807].includes(body.readUInt16LE(2))) throw unsupported();
    return type;
  }
  if (type !== 'application/octet-stream') throw unsupported();
  return type;
}
