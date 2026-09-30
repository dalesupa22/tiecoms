/**
 * Almacenamiento de archivos en S3 (bucket S3_BUCKET, llaves AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY del entorno). Todo va bajo S3_PREFIX para no mezclarse con
 * otros usos del bucket. Sin configuración, las subidas responden 503.
 */
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
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

/**
 * Enlace temporal directo a S3 (el navegador baja el archivo sin pasar por el API).
 * inline: para reproducir un video en <video> (el navegador pide rangos directo a S3).
 */
export async function presignDownload(key: string, fileName: string, contentType: string, seconds = 300, inline = false) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return getSignedUrl(client(), new GetObjectCommand({
    Bucket: bucket, Key: key, ResponseContentType: contentType,
    ResponseContentDisposition: `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  }), { expiresIn: seconds });
}

/**
 * Sube un stream sin tenerlo entero en memoria: multipart de 5 MB con 2 partes en vuelo (≈ 10 MB por subida).
 * Si el stream falla (cliente que corta, límite superado), lib-storage aborta el multipart.
 */
export async function putObjectStream(key: string, body: Readable, contentType: string) {
  const up = new Upload({
    client: client(), queueSize: 2, partSize: 5 * 1024 * 1024, leavePartsOnError: false,
    params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'private, max-age=31536000, immutable', ServerSideEncryption: 'AES256' },
  });
  await up.done();
}

/** Lectura por stream (con Range opcional) para servir videos grandes sin cargarlos en memoria. */
export async function getObjectStream(key: string, range?: string) {
  const r = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key, ...(range ? { Range: range } : {}) }));
  return {
    body: r.Body as Readable, contentLength: r.ContentLength ?? null, contentRange: r.ContentRange ?? null,
    partial: !!range && !!r.ContentRange,
  };
}

/**
 * La política del usuario de S3 niega DeleteObject (probado el 24-sep-2026): el
 * borrado en chaggu es lógico. Con S3_ALLOW_DELETE=true se borra también el objeto.
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
