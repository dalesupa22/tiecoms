/**
 * Sonido de mensajes nuevos (solo web): un «pop» corto de dos notas hecho con WebAudio
 * (OscillatorNode + GainNode con envolvente), sin archivos. Una mención suena un poco más aguda.
 *
 * El navegador exige una interacción antes de reproducir audio: el AudioContext se crea o se
 * reanuda en el primer clic o tecla; antes de eso no suena nada y no se muestran errores.
 * Máximo un sonido cada 1,5 s. Ajuste en localStorage['chaggu:sound'] ('0' = apagado; por defecto encendido).
 */
import type { MessageSound, Ringtone, SoundChoice } from '@tiecoms/contracts';

const KEY = 'chaggu:sound';
export const SOUND_GAP_MS = 1500;

let ctx: AudioContext | null = null;
let lastAt = -Infinity;
const listeners = new Set<() => void>();

export function soundEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
}
export function setSoundEnabled(on: boolean) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
  listeners.forEach((l) => l());
  if (on) playPop(false, true);
}
export const subscribeSound = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Crea o reanuda el AudioContext; solo funciona dentro de un gesto de la persona. */
function unlock() {
  try {
    const AC: typeof AudioContext | undefined = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  } catch { ctx = null; }
}

/** Escucha el primer clic o tecla (y los siguientes, por si el navegador vuelve a suspender el audio). */
export function installSoundUnlock() {
  if (typeof window === 'undefined') return;
  const opts = { capture: true, passive: true } as const;
  window.addEventListener('pointerdown', unlock, opts);
  window.addEventListener('keydown', unlock, opts);
}

/** Dos notas cortas (≈ 200 ms en total) con ataque rápido y caída exponencial. */
function tone(ac: AudioContext, freq: number, start: number, dur: number, peak: number) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/**
 * Reproduce el pop si el sonido está activado y el audio ya se desbloqueó. `force` (vista previa)
 * ignora el ajuste y el límite de 1,5 s. Devuelve true si sonó.
 */
export function playPop(mention = false, force = false): boolean {
  if (!force && !soundEnabled()) return false;
  const now = Date.now();
  if (!force && now - lastAt < SOUND_GAP_MS) return false;
  if (force) unlock();
  if (!ctx) return false;
  if (ctx.state !== 'running') {
    // Vista previa (dentro de un clic): el contexto recién reanudado suena en cuanto arranca.
    if (force) void ctx.resume().then(() => { if (ctx) pop(ctx, mention); }).catch(() => {});
    return false;
  }
  lastAt = now;
  return pop(ctx, mention);
}

function pop(ac: AudioContext, mention: boolean): boolean {
  try {
    const t0 = ac.currentTime + 0.005;
    const [a, b] = mention ? [880, 1318.5] : [659.3, 987.8]; // La5→Mi6 (mención) · Mi5→Si5
    tone(ac, a, t0, 0.09, 0.16);
    tone(ac, b, t0 + 0.085, 0.13, 0.13);
    return true;
  } catch { return false; }
}


// ---------- Sonidos por chat y tono de llamada (docs/SONIDOS.md) ----------

/** Una nota: frecuencia (Hz), inicio y duración (s), forma de onda y volumen pico. */
type Note = [freq: number, at: number, dur: number, wave: OscillatorType, peak: number];
/** Recetas de los 10 sonidos de mensaje (≤ 0,6 s cada uno). La mención suena una quinta más aguda. */
export const MESSAGE_RECIPES: Record<MessageSound, Note[]> = {
  pop: [[659.3, 0, 0.09, 'sine', 0.16], [987.8, 0.085, 0.13, 'sine', 0.13]],
  gota: [[1400, 0, 0.06, 'sine', 0.14], [700, 0.05, 0.16, 'sine', 0.12]],
  campana: [[1046.5, 0, 0.5, 'sine', 0.13], [2093, 0, 0.3, 'sine', 0.04], [1568, 0.01, 0.35, 'sine', 0.03]],
  marimba: [[523.3, 0, 0.12, 'triangle', 0.18], [659.3, 0.1, 0.12, 'triangle', 0.16], [784, 0.2, 0.18, 'triangle', 0.15]],
  burbuja: [[400, 0, 0.05, 'sine', 0.12], [600, 0.04, 0.05, 'sine', 0.12], [900, 0.08, 0.08, 'sine', 0.12]],
  cristal: [[1760, 0, 0.18, 'sine', 0.09], [2637, 0.07, 0.25, 'sine', 0.07]],
  acorde: [[523.3, 0, 0.35, 'triangle', 0.08], [659.3, 0, 0.35, 'triangle', 0.07], [784, 0, 0.35, 'triangle', 0.07]],
  silbido: [[880, 0, 0.12, 'sine', 0.1], [1318.5, 0.12, 0.2, 'sine', 0.1]],
  tambor: [[180, 0, 0.12, 'sine', 0.3], [120, 0.1, 0.14, 'sine', 0.26]],
  brisa: [[587.3, 0, 0.3, 'sine', 0.07], [880, 0.12, 0.35, 'sine', 0.06], [1174.7, 0.24, 0.35, 'sine', 0.05]],
};
/** Un ciclo de cada tono de llamada (se repite cada RING_EVERY_MS mientras suena). */
export const RINGTONE_RECIPES: Record<Ringtone, Note[]> = {
  clasico: [[440, 0, 0.35, 'sine', 0.14], [480, 0, 0.35, 'sine', 0.12], [440, 0.45, 0.35, 'sine', 0.14], [480, 0.45, 0.35, 'sine', 0.12]],
  suave: [[659.3, 0, 0.3, 'triangle', 0.12], [784, 0.25, 0.3, 'triangle', 0.12], [987.8, 0.5, 0.45, 'triangle', 0.12]],
  marimba: [[784, 0, 0.12, 'triangle', 0.18], [659.3, 0.14, 0.12, 'triangle', 0.18], [784, 0.28, 0.12, 'triangle', 0.18], [1046.5, 0.42, 0.25, 'triangle', 0.18]],
};
export const RING_EVERY_MS = 2200;
export const DEFAULT_SOUND: MessageSound = 'pop';
export const DEFAULT_RINGTONE: Ringtone = 'clasico';

function playNotes(ac: AudioContext, notes: Note[], transpose = 1): boolean {
  try {
    const t0 = ac.currentTime + 0.005;
    for (const [f, at, dur, wave, peak] of notes) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = wave;
      osc.frequency.setValueAtTime(f * transpose, t0 + at);
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      osc.connect(gain).connect(ac.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.03);
    }
    return true;
  } catch { return false; }
}

function withContext(force: boolean, run: (ac: AudioContext) => boolean): boolean {
  if (force) unlock();
  if (!ctx) return false;
  if (ctx.state !== 'running') {
    if (force) void ctx.resume().then(() => { if (ctx) run(ctx); }).catch(() => {});
    return false;
  }
  return run(ctx);
}

/**
 * Sonido de un mensaje con la elección del chat (o la predeterminada). 'none' no suena. Respeta el ajuste
 * general y el límite de 1,5 s salvo `force` (vista previa).
 */
export function playMessageSound(choice: SoundChoice | null | undefined, mention = false, force = false): boolean {
  const name = choice ?? DEFAULT_SOUND;
  if (name === 'none') return false;
  if (!force && !soundEnabled()) return false;
  const now = Date.now();
  if (!force && now - lastAt < SOUND_GAP_MS) return false;
  const ok = withContext(force, (ac) => playNotes(ac, MESSAGE_RECIPES[name as MessageSound] ?? MESSAGE_RECIPES.pop, mention ? 1.5 : 1));
  if (ok) lastAt = now;
  return ok;
}

let ringTimer: ReturnType<typeof setInterval> | null = null;
/** Tono de llamada entrante: se repite hasta stopRingtone(). No depende del ajuste de sonido de mensajes. */
export function startRingtone(name: Ringtone | null | undefined) {
  stopRingtone();
  const notes = RINGTONE_RECIPES[name ?? DEFAULT_RINGTONE] ?? RINGTONE_RECIPES.clasico;
  const ring = () => withContext(false, (ac) => playNotes(ac, notes));
  ring();
  ringTimer = setInterval(ring, RING_EVERY_MS);
}
export function stopRingtone() { if (ringTimer) clearInterval(ringTimer); ringTimer = null; }
/** Vista previa de un tono (un ciclo). */
export function previewRingtone(name: Ringtone) { withContext(true, (ac) => playNotes(ac, RINGTONE_RECIPES[name])); }
