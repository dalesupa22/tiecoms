/**
 * Almacenamiento de archivos en S3 (bucket S3_BUCKET, llaves AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY del entorno). Todo va bajo S3_PREFIX para no mezclarse con
 * otros usos del bucket. Sin configuración, las subidas responden 503.
 */
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ApiError } from './errors.ts';

const bucket = process.env.S3_BUCKET ?? '';
const prefix = (process.env.S3_PREFIX ?? 'tiecoms/').replace(/^\/+/, '');
let s3: S3Client | null = null;

export const storageEnabled = () => !!bucket && !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;

function client() {
  if (!storageEnabled()) throw new ApiError(503, 'storage_unavailable', 'El almacenamiento de archivos aún no está configurado');
  // Las credenciales las toma el SDK del entorno.
  // S3_ENDPOINT solo para pruebas locales (MinIO).
  s3 ??= new S3Client({ region: process.env.S3_REGION ?? 'us-east-1', ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}) });
  return s3;
}

export const objectKey = (path: string) => `${prefix}${path}`;

export async function putObject(key: string, body: Buffer, contentType: string) {
  await client().send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType,
    CacheControl: 'private, max-age=31536000, immutable', ServerSideEncryption: 'AES256',
  }));
}

export async function getObject(key: string) {
  const r = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return { body: Buffer.from(await r.Body!.transformToByteArray()), contentType: r.ContentType ?? 'application/octet-stream' };
}

/** Enlace temporal de descarga directo a S3 (el navegador baja el archivo sin pasar por el API). */
export async function presignDownload(key: string, fileName: string, contentType: string, seconds = 300) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return getSignedUrl(client(), new GetObjectCommand({
    Bucket: bucket, Key: key, ResponseContentType: contentType,
    ResponseContentDisposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  }), { expiresIn: seconds });
}

/**
 * La política del usuario de S3 niega DeleteObject (probado el 24-sep-2026): el
 * borrado en TieComs es lógico. Con S3_ALLOW_DELETE=true se borra también el objeto.
 */
export async function deleteObject(key: string) {
  if (process.env.S3_ALLOW_DELETE !== 'true') return;
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Borrado obligatorio por eliminación de cuenta: nunca convierte un permiso denegado en éxito. */
export async function deletePersonalObject(key: string) {
  if (!key.startsWith(objectKey('avatars/')) && !key.startsWith(objectKey('drive/me/'))) {
    throw new Error('El borrado de cuenta solo admite fotos y archivos personales');
  }
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
