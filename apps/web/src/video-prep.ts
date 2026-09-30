/**
 * Preparar un video antes de subirlo (docs/VIDEO.md): lo comprime en un Worker con Mediabunny y, si el navegador
 * no puede (sin WebCodecs, códec no soportado, error), sube el original si cabe en 150 MB. El póster y la
 * duración salen del worker o, en el respaldo, de un <video> local.
 */
import { MAX_VIDEO_BYTES } from '@tiecoms/contracts';
import type { PrepareResult } from './video-worker.ts';
import { mp4Name } from './video.ts';

export interface PreparedVideo extends Omit<PrepareResult, 'plan'> { name: string; plan: PrepareResult['plan'] | 'original' }

export class VideoPrepError extends Error {
  constructor(public code: 'too_big' | 'canceled' | 'unreadable', message: string) { super(message); }
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<string, { resolve: (r: PrepareResult) => void; reject: (e: any) => void; onProgress: (p: number) => void; onPoster?: (b: Blob) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./video-worker.ts', import.meta.url), { type: 'module', name: 'chaggu-video' });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: string; id: string; p?: number; result?: PrepareResult; code?: string; message?: string; poster?: Blob };
    const job = pending.get(m.id);
    if (!job) return;
    if (m.type === 'progress') job.onProgress(m.p ?? 0);
    else if (m.type === 'poster' && m.poster) job.onPoster?.(m.poster);
    else if (m.type === 'done') { pending.delete(m.id); job.resolve(m.result!); }
    else if (m.type === 'error') { pending.delete(m.id); job.reject(Object.assign(new Error(m.message), { code: m.code })); }
  };
  worker.onerror = () => {
    for (const [, job] of pending) job.reject(Object.assign(new Error('worker'), { code: 'worker' }));
    pending.clear();
    worker?.terminate(); worker = null;
  };
  return worker;
}

/** Comprime (o no) y devuelve lo que se sube. onProgress: 0–1 de la compresión; onPoster: el póster en cuanto existe. */
export async function prepareVideo(file: File, onProgress: (p: number) => void, signal: AbortSignal, onPoster?: (b: Blob) => void): Promise<PreparedVideo> {
  if (signal.aborted) throw new VideoPrepError('canceled', 'Cancelado');
  let result: PrepareResult | null = null;
  try {
    if (typeof Worker !== 'undefined' && typeof VideoEncoder !== 'undefined') {
      const id = `v${++seq}`;
      const w = getWorker();
      result = await new Promise<PrepareResult>((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress, onPoster });
        signal.addEventListener('abort', () => { w.postMessage({ type: 'cancel', id }); }, { once: true });
        w.postMessage({ type: 'prepare', id, file });
      });
    }
  } catch (e: any) {
    if (signal.aborted || e?.code === 'canceled') throw new VideoPrepError('canceled', 'Cancelado');
    console.warn('[video] sin compresión, se sube el original:', e?.code ?? e);
  }
  if (signal.aborted) throw new VideoPrepError('canceled', 'Cancelado');
  if (result) {
    const name = result.compressed ? mp4Name(file.name || 'video.mp4') : file.name || 'video.mp4';
    if (result.blob.size > MAX_VIDEO_BYTES) throw new VideoPrepError('too_big', 'too_big');
    return { ...result, name };
  }
  // Respaldo: el original, si cabe.
  if (file.size > MAX_VIDEO_BYTES) throw new VideoPrepError('too_big', 'too_big');
  const meta = await readWithElement(file).catch(() => null);
  return {
    blob: file, name: file.name || 'video.mp4', plan: 'original', compressed: false,
    poster: meta?.poster ?? null, durationMs: meta?.durationMs ?? 0, width: meta?.width ?? 0, height: meta?.height ?? 0,
  };
}

/** Duración, tamaño y póster con un <video> local (sin WebCodecs). Solo si el navegador puede reproducirlo. */
function readWithElement(file: File): Promise<{ durationMs: number; width: number; height: number; poster: Blob | null }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'metadata'; v.playsInline = true;
    const done = (r: Awaited<ReturnType<typeof readWithElement>> | null, err?: unknown) => {
      URL.revokeObjectURL(url); v.removeAttribute('src'); v.load();
      if (r) resolve(r); else reject(err);
    };
    const timer = setTimeout(() => done(null, new Error('timeout')), 15_000);
    v.onerror = () => { clearTimeout(timer); done(null, new Error('unreadable')); };
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 0) / 2); };
    v.onseeked = async () => {
      clearTimeout(timer);
      const meta = { durationMs: Math.round((v.duration || 0) * 1000), width: v.videoWidth, height: v.videoHeight };
      let poster: Blob | null = null;
      try {
        const k = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(2, Math.round(v.videoWidth * k)); c.height = Math.max(2, Math.round(v.videoHeight * k));
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        poster = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.75));
        if (poster && poster.size > 512 * 1024) poster = null;
      } catch { poster = null; }
      done({ ...meta, poster });
    };
    v.src = url;
  });
}
