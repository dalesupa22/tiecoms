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
  /** Formatos que acepta tal cual (el archivo completo). */
  readonly accepts: ReadonlySet<string>;
  /** Tamaño máximo por llamada (bytes del archivo, antes de base64). */
  readonly maxBytes: number;
  /** audio: archivo completo en un formato de `accepts` (o WAV). language: BCP-47 (es-CO, en-US…). */
  transcribe(audio: Buffer, language: string): Promise<{ text: string; language: string | null; audioMs: number | null }>;
}

export interface VoiceContext {
  language: 'es' | 'en';
  wantSummary: boolean;
  /** Quién grabó la nota, con quién habla y dónde: así el resumen no confunde al autor con el destinatario. */
  authorName: string;
  participants: string[];
  conversationName: string | null;
}

export interface Summarizer {
  readonly name: string;
  /** summary: una línea (solo si se pide); suggestedIssue: título corto si el texto pide una tarea concreta, si no null. */
  summarize(text: string, ctx: VoiceContext): Promise<{ summary: string | null; suggestedIssue: string | null }>;
  /** Resumen para «Llevar al hilo» un sidechat: lo que se publicará en la conversación de origen. */
  suggestSideReturn?(input: SideReturnInput): Promise<string | null>;
  /** Llamada genérica en modo JSON (resumen de enlaces): devuelve el contenido tal cual. */
  complete?(system: string, user: string): Promise<string>;
}

export interface SideReturnInput {
  language: 'es' | 'en';
  /** Quien lo publica en el hilo (y en cuyo nombre se escribe). */
  publisherName: string;
  anchor: { authorName: string; text: string };
  originName: string | null;
  messages: { authorName: string; text: string }[];
}

// ---------- Inworld STT ----------
/**
 * Inworld STT síncrono: acepta WAV, MP3, OGG, FLAC, M4A y WebM completos con audioEncoding AUTO_DETECT
 * (probado el 25-sep-2026: m4a AAC mono 32 kbps de 6 s → 0,6 s, es-CO correcto). PCM crudo sin cabecera no lo acepta.
 * Límite ≈ 16 MB por petición con base64: se mandan archivos de hasta 11 MB.
 */
export class InworldTranscriber implements Transcriber {
  readonly name = 'inworld';
  readonly accepts = new Set(['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/webm']);
  readonly maxBytes = 11 * 1024 * 1024;
  constructor(private key: string, private url = process.env.INWORLD_STT_URL || 'https://api.inworld.ai/stt/v1/transcribe', private model = process.env.INWORLD_STT_MODEL || 'inworld/inworld-stt-1') {}
  async transcribe(audio: Buffer, language: string) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Basic ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        transcribeConfig: { modelId: this.model, audioEncoding: 'AUTO_DETECT', language },
        audioData: { content: audio.toString('base64') },
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
  async summarize(text: string, opts: VoiceContext) {
    const system = voicePrompt(opts);
    const user = `${opts.language === 'es' ? 'Transcripción' : 'Transcript'}:\n${text.slice(0, 12_000)}`;
    const res = await fetch(`${this.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`deepseek_${res.status}`);
    let out: any = {};
    try { out = JSON.parse(j?.choices?.[0]?.message?.content ?? '{}'); } catch { out = {}; }
    const clean = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null);
    return { summary: opts.wantSummary ? clean(out.summary, 200) : null, suggestedIssue: clean(out.suggestedIssue, 120) };
  }
  async complete(system: string, user: string) {
    const res = await fetch(`${this.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(45_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`deepseek_${res.status}`);
    return String(j?.choices?.[0]?.message?.content ?? '');
  }
  async suggestSideReturn(input: SideReturnInput) {
    const res = await fetch(`${this.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model, temperature: 0.3, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sideReturnPrompt(input) }, { role: 'user', content: `Sidechat:\n${input.messages.map((m) => `${m.authorName}: ${m.text}`).join('\n').slice(-12_000)}` }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`deepseek_${res.status}`);
    try { const out = JSON.parse(j?.choices?.[0]?.message?.content ?? '{}'); return typeof out.summary === 'string' && out.summary.trim() ? out.summary.trim().slice(0, 4000) : null; } catch { return null; }
  }
}

/**
 * Instrucciones del resumen. El autor es quien HABLA: aunque la nota empiece con «Hola Laura», el sujeto es el autor
 * y Laura es a quien le habla. suggestedIssue detecta pedidos y también compromisos («el jueves te mando el contrato»).
 */
export function voicePrompt(c: VoiceContext) {
  const who = `Autor (quien habla): ${c.authorName}. Participantes de la conversación: ${c.participants.join(', ') || '—'}. Conversación: ${c.conversationName ?? 'chat directo'}.`;
  if (c.language === 'es') {
    return [
      'Eres el asistente de un chat de trabajo entre empresas. Recibes la transcripción de una nota de voz.',
      who,
      'Quien habla es SIEMPRE el autor. Si la nota nombra a alguien al inicio («Hola Laura…»), esa persona es a quien le habla, no quien habla.',
      'Responde SOLO un JSON {"summary": string|null, "suggestedIssue": string|null}.',
      c.wantSummary
        ? `summary: una sola línea (≤ 140 caracteres) en tercera persona con el autor como sujeto, p. ej. «${c.authorName} confirma a Laura que…».`
        : 'summary: null.',
      'suggestedIssue: si la nota pide una tarea concreta o el autor se compromete a hacer algo (p. ej. «el jueves te mando el contrato» → «Enviar el contrato el jueves»), un título breve en infinitivo (≤ 80 caracteres); si no hay tarea, null.',
      'Escribe en español.',
    ].join('\n');
  }
  return [
    'You assist a work chat between companies. You get a voice note transcript.',
    `Author (the speaker): ${c.authorName}. Conversation participants: ${c.participants.join(', ') || '—'}. Conversation: ${c.conversationName ?? 'direct chat'}.`,
    'The speaker is ALWAYS the author. If the note names someone at the start ("Hi Laura…"), that is who they are talking to, not the speaker.',
    'Reply ONLY with JSON {"summary": string|null, "suggestedIssue": string|null}.',
    c.wantSummary ? `summary: one line (≤ 140 chars) in third person with the author as subject, e.g. "${c.authorName} confirms to Laura that…".` : 'summary: null.',
    'suggestedIssue: if the note asks for a concrete task or the author commits to doing something (e.g. "I\'ll send you the contract on Thursday" → "Send the contract on Thursday"), a short imperative title (≤ 80 chars); otherwise null.',
    'Write in English.',
  ].join('\n');
}

/** WAV PCM 16 bits mono a partir de PCM crudo (Inworld no acepta PCM sin cabecera). */
export function wavFromPcm(pcm: Buffer, sampleRate = PCM_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Instrucciones para resumir un sidechat antes de llevarlo al hilo del grupo. */
export function sideReturnPrompt(i: SideReturnInput) {
  if (i.language === 'es') {
    return [
      'Eres el asistente de un chat de trabajo entre empresas. Un «sidechat» es una conversación privada que salió de un mensaje del grupo.',
      `Quien publicará el resumen en el grupo: ${i.publisherName}. Mensaje del grupo que originó el sidechat (de ${i.anchor.authorName}): «${i.anchor.text.slice(0, 500)}». Grupo: ${i.originName ?? 'chat'}.`,
      'Escribe el mensaje que se publicará en el grupo como respuesta a ese mensaje: 1 a 3 frases, en primera persona de quien publica, con la conclusión o respuesta concreta.',
      'No reveles detalles privados innecesarios ni cites textualmente la conversación privada. No inventes nada que no esté en el sidechat.',
      'Responde SOLO un JSON {"summary": string}. En español.',
    ].join('\n');
  }
  return [
    'You assist a work chat between companies. A "sidechat" is a private conversation that started from a group message.',
    `Who will post the summary in the group: ${i.publisherName}. Group message that started the sidechat (by ${i.anchor.authorName}): "${i.anchor.text.slice(0, 500)}". Group: ${i.originName ?? 'chat'}.`,
    'Write the message to post in the group as the answer to that message: 1 to 3 sentences, first person of the publisher, with the concrete conclusion or answer.',
    'Do not reveal unnecessary private details or quote the private conversation verbatim. Do not invent anything not in the sidechat.',
    'Reply ONLY with JSON {"summary": string}. In English.',
  ].join('\n');
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
