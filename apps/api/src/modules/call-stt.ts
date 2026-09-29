/**
 * Transcripción de llamadas con Groq Whisper (docs/LLAMADAS.md › Transcripción). Pedido de Danny (29-sep-2026):
 * la opción más barata (≈ US$0.04 por hora de audio con whisper-large-v3-turbo; mínimo 10 s por petición).
 * Cada dispositivo manda su propio micrófono en pedazos de 12–20 s con voz; aquí se transcriben y se filtran
 * las alucinaciones típicas de Whisper en silencio. GROQ_STT_URL solo cambia en pruebas; CALLS_STT_PROVIDER=fake
 * devuelve un texto fijo sin red.
 */

export interface SttSegment { start: number; end: number; text: string }
export interface SttResult { language: string | null; segments: SttSegment[] }

const HALLUCINATIONS = [
  /^gracias( por ver)?( el video)?[.!]*$/i, /^subt[ií]tulos (realizados )?por/i, /^suscr[ií]bete/i, /^amara\.org/i,
  /^thanks? for watching[.!]*$/i, /^thank you[.!]*$/i, /^\.+$/, /^¡?música!?$/i, /^\[.*\]$/, /^\(.*\)$/,
];

/** Frases que Whisper inventa sobre silencio o ruido, o con poca confianza. */
export function keepSegment(s: { text: string; no_speech_prob?: number; avg_logprob?: number }) {
  const t = s.text.trim();
  if (!t) return false;
  if ((s.no_speech_prob ?? 0) > 0.6) return false;
  if ((s.avg_logprob ?? 0) < -1.2) return false;
  return !HALLUCINATIONS.some((r) => r.test(t));
}

export const sttConfigured = () => process.env.CALLS_STT_PROVIDER === 'fake' || !!process.env.GROQ_API_KEY;

export async function transcribeChunk(audio: Buffer, contentType: string, prompt: string): Promise<SttResult> {
  if (process.env.CALLS_STT_PROVIDER === 'fake') {
    // Para pruebas: el audio falso trae el texto en claro («texto:...»).
    const txt = audio.toString('utf8');
    const m = /^texto:(.*)$/s.exec(txt);
    return { language: 'es', segments: m ? [{ start: 0, end: 2, text: m[1]!.trim() }] : [] };
  }
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('groq_not_configured');
  const base = (process.env.GROQ_STT_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const ext = contentType.includes('mp4') || contentType.includes('m4a') || contentType.includes('aac') ? 'm4a'
    : contentType.includes('ogg') ? 'ogg' : contentType.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.set('file', new Blob([audio], { type: contentType }), `chunk.${ext}`);
  form.set('model', process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo');
  form.set('response_format', 'verbose_json');
  form.set('temperature', '0');
  // Nombres propios (empresas, personas del chat) mejoran la ortografía: «Xertify», «chaggu».
  if (prompt) form.set('prompt', prompt.slice(0, 800));
  const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(30_000) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`groq_${res.status}:${String(j?.error?.message ?? '').slice(0, 200)}`);
  const segs: any[] = Array.isArray(j.segments) ? j.segments : [{ start: 0, end: j.duration ?? 0, text: j.text ?? '' }];
  return {
    language: j.language ?? null,
    segments: segs.filter(keepSegment).map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text).trim() })),
  };
}
