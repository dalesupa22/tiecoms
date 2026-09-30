/**
 * Worker de video (docs/VIDEO.md): lee el archivo con Mediabunny (WebCodecs), decide si recodificar, comprime a
 * MP4 H.264 + AAC con moov al principio y saca el póster (JPEG del primer segundo). Corre fuera del hilo de la
 * interfaz; Mediabunny solo se descarga cuando alguien adjunta un video (este worker es su propio chunk).
 *
 * Mensajes de entrada: { type: 'prepare', id, file } y { type: 'cancel', id }.
 * Salida: { type: 'poster', id, poster } · { type: 'progress', id, phase: 'compress', p } · { type: 'done', id, result } · { type: 'error', id, code, message }.
 */
import {
  ALL_FORMATS, BlobSource, BufferTarget, CanvasSink, Conversion, Input, MATROSKA, MP4, Mp4OutputFormat, Output, QTFF, Quality, WEBM,
  canEncodeAudio, canEncodeVideo,
} from 'mediabunny';
import { VIDEO_TARGET, moovBeforeMdat, planVideo, targetSize, targetVideoBps, type VideoPlan, type VideoProbe } from './video.ts';

export interface PrepareResult {
  blob: Blob;
  plan: VideoPlan;
  /** false si se sube el original (ya era liviano o recodificar no ahorraba). */
  compressed: boolean;
  poster: Blob | null;
  durationMs: number;
  width: number;
  height: number;
}

interface Scope { postMessage(msg: unknown): void; onmessage: ((e: MessageEvent) => void) | null }
const scope = self as unknown as Scope;
const running = new Map<string, Conversion>();
const canceled = new Set<string>();

scope.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: string; id: string; file?: File };
  if (m.type === 'cancel') {
    canceled.add(m.id);
    void running.get(m.id)?.cancel();
    return;
  }
  if (m.type === 'prepare' && m.file) {
    prepare(m.id, m.file).then(
      (result) => scope.postMessage({ type: 'done', id: m.id, result }),
      (err: any) => scope.postMessage({ type: 'error', id: m.id, code: canceled.has(m.id) ? 'canceled' : err?.code ?? 'failed', message: String(err?.message ?? err) }),
    ).finally(() => { running.delete(m.id); canceled.delete(m.id); });
  }
};

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

async function prepare(id: string, file: File): Promise<PrepareResult> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') throw fail('no_webcodecs', 'Este navegador no tiene WebCodecs');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const format = await input.getFormat();
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw fail('no_video', 'El archivo no tiene pista de video');
    const audio = await input.getPrimaryAudioTrack();
    const durationSec = await input.computeDuration();
    const stats = await video.computePacketStats(120).catch(() => null);
    const container = format === MP4 ? 'mp4' : format === QTFF ? 'mov' : format === WEBM ? 'webm' : format === MATROSKA ? 'mkv' : format.name;
    const moovFirst = container === 'mp4' || container === 'mov'
      ? await moovBeforeMdat(async (o, l) => new Uint8Array(await file.slice(o, o + l).arrayBuffer()), file.size).catch(() => null)
      : null;
    const probe: VideoProbe = {
      container, videoCodec: video.codec, audioCodec: audio?.codec ?? null,
      width: video.displayWidth, height: video.displayHeight, sizeBytes: file.size, durationSec,
      fps: stats?.averagePacketRate ?? null, moovFirst,
    };
    const plan = planVideo(probe);
    const poster = await makePoster(video, durationSec).catch(() => null);
    // El póster sale antes de comprimir: la tarjeta pendiente ya lo muestra mientras avanza el progreso.
    if (poster) scope.postMessage({ type: 'poster', id, poster });
    const meta = { durationMs: Math.round(durationSec * 1000), width: probe.width, height: probe.height };
    if (plan === 'keep') return { blob: file, plan, compressed: false, poster, ...meta };

    const size = targetSize(probe.width, probe.height);
    const videoBps = targetVideoBps(size.width, size.height, durationSec);
    const transcode = plan === 'transcode';
    if (transcode && !(await canEncodeVideo('avc', { width: size.width, height: size.height, bitrate: videoBps }))) {
      throw fail('no_encoder', 'Este navegador no puede codificar H.264');
    }
    // Audio: se copia si ya es AAC liviano; si no, AAC a 96 kbps (u Opus si el navegador no codifica AAC).
    let audioOpts: Record<string, unknown> | undefined;
    if (audio && transcode) {
      const aStats = audio.codec === 'aac' ? await audio.computePacketStats(200).catch(() => null) : null;
      if (audio.codec === 'aac' && aStats && aStats.averageBitrate <= 160_000) audioOpts = { codec: 'aac' };
      else if (await canEncodeAudio('aac', { bitrate: VIDEO_TARGET.audioBps })) audioOpts = { codec: 'aac', quality: new Quality({ bitrate: VIDEO_TARGET.audioBps }) };
      else if (await canEncodeAudio('opus', { bitrate: VIDEO_TARGET.audioBps })) audioOpts = { codec: 'opus', quality: new Quality({ bitrate: VIDEO_TARGET.audioBps }) };
      else throw fail('no_encoder', 'Este navegador no puede codificar el audio');
    }
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conversion = await Conversion.init({
      input, output, tracks: 'primary',
      video: transcode ? {
        codec: 'avc', width: size.width, height: size.height, fit: 'contain', quality: new Quality({ bitrate: videoBps, bitrateMode: 'variable' }),
        // La rotación queda en los píxeles: el tamaño pedido es el de pantalla y se ve igual en todos lados.
        allowTransformationMetadata: false,
        ...(probe.fps && probe.fps > VIDEO_TARGET.maxFps + 1 ? { frameRate: VIDEO_TARGET.maxFps } : {}),
      } : {},
      audio: audioOpts ?? {},
      showWarnings: false,
    });
    if (!conversion.isValid) throw fail('invalid', 'No se puede convertir este video');
    running.set(id, conversion);
    if (canceled.has(id)) throw fail('canceled', 'Cancelado');
    conversion.onProgress = (p) => scope.postMessage({ type: 'progress', id, phase: 'compress', p });
    await conversion.execute();
    const buf = target.buffer;
    if (!buf) throw fail('failed', 'La compresión no produjo archivo');
    const out = new Blob([buf], { type: 'video/mp4' });
    // Si recodificar no ahorró y el original ya se reproduce en todos lados, se sube el original.
    const originalPlays = probe.videoCodec === 'avc' && (probe.audioCodec === null || probe.audioCodec === 'aac') && (container === 'mp4' || container === 'mov');
    if (out.size >= file.size && originalPlays) return { blob: file, plan: 'keep', compressed: false, poster, ...meta };
    return { blob: out, plan, compressed: true, poster, ...meta, ...(transcode ? size : {}) };
  } finally {
    input.dispose?.();
  }
}

/** Póster JPEG (≤ 512 KB, lado largo 480) del cuadro en el segundo 1 (o la mitad si dura menos). */
async function makePoster(video: Awaited<ReturnType<Input['getPrimaryVideoTrack']>> & object, durationSec: number): Promise<Blob | null> {
  const k = Math.min(1, 480 / Math.max(video.displayWidth, video.displayHeight));
  const sink = new CanvasSink(video, { width: Math.max(2, Math.round(video.displayWidth * k)), height: Math.max(2, Math.round(video.displayHeight * k)), fit: 'contain' });
  const first = await video.getFirstTimestamp().catch(() => 0);
  const at = first + Math.min(1, Math.max(0, durationSec / 2));
  const frame = (await sink.getCanvas(at)) ?? (await sink.getCanvas(first));
  if (!frame) return null;
  const canvas = frame.canvas as OffscreenCanvas;
  for (const q of [0.8, 0.6, 0.4]) {
    const b = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
    if (b.size <= 512 * 1024) return b;
  }
  return null;
}
