/**
 * Sonido de mensajes nuevos (solo web): un «pop» corto de dos notas hecho con WebAudio
 * (OscillatorNode + GainNode con envolvente), sin archivos. Una mención suena un poco más aguda.
 *
 * El navegador exige una interacción antes de reproducir audio: el AudioContext se crea o se
 * reanuda en el primer clic o tecla; antes de eso no suena nada y no se muestran errores.
 * Máximo un sonido cada 1,5 s. Ajuste en localStorage['chaggu:sound'] ('0' = apagado; por defecto encendido).
 */
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

