/**
 * Proveedores de las notas de voz, detrás de interfaces para poder cambiarlos sin tocar las apps:
 *  - Transcriber: Inworld STT (INWORLD_API_KEY). Otro proveedor (Groq/Whisper…) implementa la misma interfaz.
 *  - Summarizer: DeepSeek (DEEPSEEK_API_KEY, API compatible con OpenAI), opcional.
 *  - ffmpeg (FFMPEG_PATH o `ffmpeg` del sistema): PCM 16 kHz mono para transcribir y AAC reproducible.
 * INWORLD_STT_URL y DEEPSEEK_URL solo cambian en pruebas (servidores falsos).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Transcriber {
  readonly name: string;
  /** Audio PCM 16 bits little-endian mono (LINEAR16). language: BCP-47 (es-CO, en-US…). */
  transcribe(pcm: Buffer, sampleRate: number, language: string): Promise<{ text: string; language: string | null; audioMs: number | null }>;
}

export interface Summarizer {
  readonly name: string;
  /** summary: una línea (solo si se pide); suggestedIssue: título corto si el texto pide una tarea concreta, si no null. */
  summarize(text: string, opts: { language: 'es' | 'en'; wantSummary: boolean }): Promise<{ summary: string | null; suggestedIssue: string | null }>;
}

// ---------- Inworld STT ----------
export class InworldTranscriber implements Transcriber {
  readonly name = 'inworld';
  constructor(private key: string, private url = process.env.INWORLD_STT_URL || 'https://api.inworld.ai/stt/v1/transcribe', private model = process.env.INWORLD_STT_MODEL || 'inworld/inworld-stt-1') {}
  async transcribe(pcm: Buffer, sampleRate: number, language: string) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Basic ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        transcribeConfig: { modelId: this.model, audioEncoding: 'LINEAR16', language, sampleRateHertz: sampleRate, numberOfChannels: 1 },
        audioData: { content: pcm.toString('base64') },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`inworld_${res.status}${j?.message ? `: ${String(j.message).slice(0, 200)}` : ''}`);
    return { text: String(j?.transcription?.transcript ?? '').trim(), language: j?.transcription?.language ?? null, audioMs: Number(j?.usage?.transcribedAudioMs ?? 0) || null };
  }
}

// ---------- DeepSeek ----------
export class DeepSeekSummarizer implements Summarizer {
  readonly name = 'deepseek';
  constructor(private key: string, private url = process.env.DEEPSEEK_URL || 'https://api.deepseek.com', private model = process.env.DEEPSEEK_MODEL || 'deepseek-chat') {}
  async summarize(text: string, opts: { language: 'es' | 'en'; wantSummary: boolean }) {
    const es = opts.language === 'es';
    const system = es
      ? 'Eres un asistente de un chat de trabajo entre empresas. Recibes la transcripción de una nota de voz. Responde SOLO un JSON {"summary": string|null, "suggestedIssue": string|null}. summary: una sola línea (≤ 140 caracteres) con lo esencial' + (opts.wantSummary ? '' : ' (devuélvelo null)') + '. suggestedIssue: si la nota pide o compromete una tarea concreta, un título breve e imperativo (≤ 80 caracteres); si no, null. En español.'
      : 'You assist a work chat between companies. You get a voice note transcript. Reply ONLY with JSON {"summary": string|null, "suggestedIssue": string|null}. summary: one line (≤ 140 chars) with the gist' + (opts.wantSummary ? '' : ' (return null)') + '. suggestedIssue: if the note asks for or commits to a concrete task, a short imperative title (≤ 80 chars); otherwise null. In English.';
    const res = await fetch(`${this.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: text.slice(0, 12_000) }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`deepseek_${res.status}`);
    let out: any = {};
    try { out = JSON.parse(j?.choices?.[0]?.message?.content ?? '{}'); } catch { out = {}; }
    const clean = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null);
    return { summary: opts.wantSummary ? clean(out.summary, 200) : null, suggestedIssue: clean(out.suggestedIssue, 120) };
  }
}

// ---------- Selección por entorno ----------
let transcriber: Transcriber | null | undefined;
let summarizer: Summarizer | null | undefined;
export function getTranscriber(): Transcriber | null {
  if (transcriber === undefined) transcriber = process.env.INWORLD_API_KEY ? new InworldTranscriber(process.env.INWORLD_API_KEY) : null;
  return transcriber;
}
export function getSummarizer(): Summarizer | null {
  if (summarizer === undefined) summarizer = process.env.DEEPSEEK_API_KEY ? new DeepSeekSummarizer(process.env.DEEPSEEK_API_KEY) : null;
  return summarizer;
}
export const transcriptionEnabled = () => !!getTranscriber();
/** Solo pruebas. */
export function setVoiceProviders(t: Transcriber | null | undefined, s: Summarizer | null | undefined) { transcriber = t; summarizer = s; }

// ---------- ffmpeg ----------
const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg';

async function ffmpeg(input: Buffer, outName: string, args: string[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'tc-voice-'));
  const inPath = join(dir, `in-${randomUUID()}`), outPath = join(dir, outName);
  try {
    await writeFile(inPath, input);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(FFMPEG(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inPath, ...args, outPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      const timer = setTimeout(() => p.kill('SIGKILL'), 120_000);
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => { clearTimeout(timer); reject(new Error(`ffmpeg_unavailable: ${e.message}`)); });
      p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg_${code}: ${err.slice(0, 300)}`)); });
    });
    return await readFile(outPath);
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

export const PCM_RATE = 16_000;
/** PCM s16le 16 kHz mono para transcribir. */
export const toPcm16 = (audio: Buffer) => ffmpeg(audio, 'out.pcm', ['-vn', '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', '-acodec', 'pcm_s16le']);
/**
 * Variante reproducible en todas partes: AAC en m4a, mono 24 kHz 32 kbps, sin metadatos y con banderas bitexact
 * (mismo archivo de entrada → mismos bytes), moov al inicio para empezar a sonar antes de terminar de bajar.
 */
export const toAac = (audio: Buffer) => ffmpeg(audio, 'out.m4a', [
  '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '24000', '-c:a', 'aac', '-b:a', '32k',
  '-fflags', '+bitexact', '-flags:a', '+bitexact', '-movflags', '+faststart', '-f', 'mp4',
]);
/** Tipos que ya se reproducen en iOS, Android y navegadores sin convertir. */
export const PLAYABLE = new Set(['audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/wav']);

/** Onda de 48 barras (0–1) a partir del PCM. */
export function waveformFromPcm(pcm: Buffer, bars = 48): number[] {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return [];
  const per = Math.max(1, Math.floor(samples / bars));
  const out: number[] = [];
  for (let b = 0; b < bars && b * per < samples; b++) {
    let sum = 0, n = 0;
    for (let i = b * per; i < Math.min(samples, (b + 1) * per); i += 4) { const v = pcm.readInt16LE(i * 2) / 32768; sum += v * v; n++; }
    out.push(Math.sqrt(sum / Math.max(1, n)));
  }
  const max = Math.max(...out, 1e-6);
  return out.map((v) => Math.round((v / max) * 100) / 100);
}

/** Trozos alineados a muestra, < 15 MB cada uno (límite de Inworld ≈ 16 MB con base64 incluido). */
export function chunkPcm(pcm: Buffer, maxBytes = Number(process.env.STT_CHUNK_BYTES ?? 11 * 1024 * 1024)): Buffer[] {
  const size = maxBytes - (maxBytes % 2);
  const out: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += size) out.push(pcm.subarray(i, Math.min(pcm.length, i + size)));
  return out;
}
