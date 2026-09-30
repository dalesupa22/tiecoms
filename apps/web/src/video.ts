/**
 * Videos (docs/VIDEO.md): funciones puras para decidir si recodificar, calcular el tamaño de salida y
 * formatear duración y tamaños. Sin DOM ni Mediabunny, así se prueban con vitest y no pesan en el bundle.
 */

/** Objetivo de compresión: MP4 H.264 + AAC, lado largo ≤ 1280, ~2 Mbps, 96 kbps de audio, ≤ 30 fps. */
export const VIDEO_TARGET = {
  maxLong: 1280, maxShort: 720, videoBps: 2_000_000, minVideoBps: 450_000, audioBps: 96_000, maxFps: 30,
  /** Si ya es compatible y pesa esto o menos, no se recodifica. */
  keepUnderBytes: 5 * 1024 * 1024,
  /** Compatible y con bitrate ya bajo (≤ 2,6 Mbps): tampoco se gana nada recodificando. */
  keepUnderBps: 2_600_000,
  /** Margen bajo el límite del servidor (150 MB) para que un video largo quepa bajando el bitrate. */
  budgetBytes: 140 * 1024 * 1024,
} as const;

export interface VideoProbe {
  /** Contenedor: 'mp4' (incluye m4v), 'mov', 'webm', 'mkv' u otro. */
  container: string;
  /** Códec de video de Mediabunny ('avc', 'hevc', 'vp9', 'av1'…) o null si no hay pista. */
  videoCodec: string | null;
  audioCodec: string | null;
  /** Tamaño en pantalla (ya con la rotación aplicada). */
  width: number;
  height: number;
  sizeBytes: number;
  durationSec: number;
  fps: number | null;
  /** moov antes de mdat (arranca a reproducir sin bajar el final del archivo). null si no aplica o no se sabe. */
  moovFirst: boolean | null;
}

/** keep: se sube tal cual · remux: se reempaqueta sin recodificar (moov al principio, MOV→MP4) · transcode: se comprime. */
export type VideoPlan = 'keep' | 'remux' | 'transcode';

export function planVideo(p: VideoProbe): VideoPlan {
  if (!p.videoCodec) return 'transcode';
  const long = Math.max(p.width, p.height), short = Math.min(p.width, p.height);
  const codecsOk = p.videoCodec === 'avc' && (p.audioCodec === null || p.audioCodec === 'aac');
  const containerOk = p.container === 'mp4' || p.container === 'mov';
  const sizeOk = long <= VIDEO_TARGET.maxLong && short <= VIDEO_TARGET.maxShort;
  const fpsOk = p.fps === null || p.fps <= VIDEO_TARGET.maxFps + 1;
  const bps = p.durationSec > 0 ? (p.sizeBytes * 8) / p.durationSec : Infinity;
  const light = p.sizeBytes <= VIDEO_TARGET.keepUnderBytes || bps <= VIDEO_TARGET.keepUnderBps;
  if (!(codecsOk && containerOk && sizeOk && fpsOk && light)) return 'transcode';
  return p.container === 'mp4' && p.moovFirst === true ? 'keep' : 'remux';
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Tamaño de salida que conserva la proporción: lado largo ≤ 1280 y corto ≤ 720, pares (H.264 los exige). */
export function targetSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height), short = Math.min(width, height);
  const k = Math.min(1, VIDEO_TARGET.maxLong / long, VIDEO_TARGET.maxShort / short);
  return { width: even(width * k), height: even(height * k) };
}

/**
 * Bitrate de video: 2 Mbps a 720p, proporcional a los píxeles si sale más pequeño, y más bajo si hace falta
 * para que un video largo quepa en el presupuesto (140 MB). Nunca por debajo de 450 kbps.
 */
export function targetVideoBps(width: number, height: number, durationSec: number): number {
  const byPixels = VIDEO_TARGET.videoBps * Math.min(1, (width * height) / (1280 * 720));
  const byBudget = durationSec > 0 ? (VIDEO_TARGET.budgetBytes * 8) / durationSec - VIDEO_TARGET.audioBps : Infinity;
  return Math.round(Math.max(VIDEO_TARGET.minVideoBps, Math.min(VIDEO_TARGET.videoBps, Math.max(byPixels, 700_000), byBudget)));
}

/** Tamaño esperado de la salida (para avisar antes de comprimir si no va a caber). */
export function estimateBytes(durationSec: number, videoBps: number) {
  return Math.round((durationSec * (videoBps + VIDEO_TARGET.audioBps)) / 8 * 1.02);
}

/** «0:42», «3:07», «1:02:03». */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** «0 B», «820 KB», «8,4 MB», «1,2 GB» (coma decimal en español; unidades de 1024). */
export function formatBytes(n: number, lang: 'es' | 'en' = 'es'): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = i === 0 || v >= 100 ? 0 : v >= 10 && i <= 1 ? 0 : 1;
  const txt = new Intl.NumberFormat(lang === 'es' ? 'es-CO' : 'en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v);
  return `${txt} ${units[i]}`;
}

/**
 * Cajas de primer nivel de un MP4/MOV: ¿moov va antes que mdat? Lee solo cabeceras de 8/16 bytes.
 * read(offset, length) devuelve esos bytes del archivo. null si no parece MP4.
 */
export async function moovBeforeMdat(read: (offset: number, length: number) => Promise<Uint8Array>, size: number): Promise<boolean | null> {
  let off = 0;
  for (let n = 0; n < 64 && off + 8 <= size; n++) {
    const h = await read(off, 16);
    if (h.length < 8) return null;
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let len = dv.getUint32(0);
    const type = String.fromCharCode(h[4]!, h[5]!, h[6]!, h[7]!);
    if (!/^[\x20-\x7e]{4}$/.test(type)) return null;
    if (type === 'moov') return true;
    if (type === 'mdat') return false;
    if (len === 1) { if (h.length < 16) return null; len = Number(dv.getBigUint64(8)); }
    else if (len === 0) return null;
    if (len < 8) return null;
    off += len;
  }
  return null;
}

/** Nombre del archivo comprimido: mismo nombre con extensión .mp4. */
export function mp4Name(name: string) {
  const base = name.replace(/\.[^./\\]{1,5}$/, '') || 'video';
  return `${base}.mp4`;
}
