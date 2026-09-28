import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MUTE_FOREVER, activeUntil, isForever, mayAlert, shouldSound, tomorrowAt8, untilText, type SoundCheck } from '../src/silence.ts';

// Silenciar chats, «No molestar» y sonido de mensajes (docs/GRUPOS.md, 28-sep-2026).
const NOW = Date.parse('2026-09-28T15:00:00Z');
const inH = (h: number) => new Date(NOW + h * 3600_000).toISOString();
const base: SoundCheck = { fromOther: true, mutedUntil: null, mentioned: false, dndUntil: null, soundOn: true, hidden: false, current: false, farFromEnd: false };
const check = (p: Partial<SoundCheck>) => ({ ...base, ...p });

describe('silencio y «No molestar»', () => {
  it('activeUntil / isForever', () => {
    expect(activeUntil(null, NOW)).toBe(false);
    expect(activeUntil(inH(-1), NOW)).toBe(false);
    expect(activeUntil(inH(1), NOW)).toBe(true);
    expect(isForever(inH(24 * 7), NOW)).toBe(false);
    expect(isForever(MUTE_FOREVER, NOW)).toBe(true);
    expect(isForever('2099-12-31T00:00:00.000Z', NOW)).toBe(true);
  });

  it('«Hasta mañana» es mañana a las 8:00 hora local', () => {
    const d = tomorrowAt8(new Date(2026, 8, 28, 22, 30));
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 8, 29, 8, 0]);
    // A fin de mes pasa al mes siguiente.
    const e = tomorrowAt8(new Date(2026, 8, 30, 9, 0));
    expect([e.getMonth(), e.getDate(), e.getHours()]).toEqual([9, 1, 8]);
  });

  it('untilText: hora si es hoy, día y hora si no, null si es «hasta que lo reactive»', () => {
    const now = new Date(2026, 8, 28, 10, 0);
    expect(untilText(new Date(2026, 8, 28, 18, 0).toISOString(), 'es-CO', now)).toMatch(/6:00|18:00/);
    expect(untilText(new Date(2026, 8, 29, 8, 0).toISOString(), 'es-CO', now)).toMatch(/29/);
    expect(untilText(MUTE_FOREVER, 'es-CO', now)).toBeNull();
  });

  it('mayAlert: mis mensajes nunca; DND corta todo, también menciones', () => {
    expect(mayAlert(check({ fromOther: false }), NOW)).toBe(false);
    expect(mayAlert(check({}), NOW)).toBe(true);
    expect(mayAlert(check({ dndUntil: inH(1) }), NOW)).toBe(false);
    expect(mayAlert(check({ dndUntil: inH(1), mentioned: true }), NOW)).toBe(false);
    expect(mayAlert(check({ dndUntil: inH(-1) }), NOW)).toBe(true); // vencido
  });

  it('mayAlert: chat silenciado solo deja pasar menciones, salvo «hasta que lo reactive»', () => {
    expect(mayAlert(check({ mutedUntil: inH(8) }), NOW)).toBe(false);
    expect(mayAlert(check({ mutedUntil: inH(8), mentioned: true }), NOW)).toBe(true);
    expect(mayAlert(check({ mutedUntil: MUTE_FOREVER, mentioned: true }), NOW)).toBe(false);
    expect(mayAlert(check({ mutedUntil: inH(-1) }), NOW)).toBe(true);
  });

  it('shouldSound: pestaña oculta, otro chat o arriba en el chat abierto; nunca si está apagado', () => {
    expect(shouldSound(check({ current: false }), NOW)).toBe(true);
    expect(shouldSound(check({ current: true }), NOW)).toBe(false); // lo estoy viendo
    expect(shouldSound(check({ current: true, farFromEnd: true }), NOW)).toBe(true);
    expect(shouldSound(check({ current: true, hidden: true }), NOW)).toBe(true);
    expect(shouldSound(check({ soundOn: false, hidden: true }), NOW)).toBe(false);
    expect(shouldSound(check({ mutedUntil: inH(1), hidden: true }), NOW)).toBe(false);
    expect(shouldSound(check({ mutedUntil: inH(1), mentioned: true, hidden: true }), NOW)).toBe(true);
    expect(shouldSound(check({ dndUntil: MUTE_FOREVER, hidden: true, mentioned: true }), NOW)).toBe(false);
  });
});

describe('sonido (WebAudio)', () => {
  const started: number[] = [];
  let state = 'suspended';
  class FakeCtx {
    currentTime = 0; destination = {};
    get state() { return state; }
    resume() { state = 'running'; return Promise.resolve(); }
    createOscillator() { return { type: '', frequency: { setValueAtTime: (f: number) => started.push(f) }, connect: (g: any) => g, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x: any) => x }; }
  }
  const store = new Map<string, string>();
  const listeners: Record<string, (() => void)[]> = {};
  beforeEach(() => {
    vi.resetModules();
    started.length = 0; state = 'suspended'; store.clear();
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    vi.stubGlobal('window', { AudioContext: FakeCtx, addEventListener: (k: string, f: () => void) => { (listeners[k] ??= []).push(f); } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('no suena antes de la primera interacción, sin errores; después sí, con dos notas', async () => {
    const s = await import('../src/sound.ts');
    s.installSoundUnlock();
    expect(s.playPop()).toBe(false);
    expect(started).toEqual([]);
    listeners.pointerdown![0]!();
    expect(s.playPop()).toBe(true);
    expect(started).toHaveLength(2);
  });

  it('máximo uno cada 1,5 s; la mención es más aguda', async () => {
    vi.useFakeTimers({ now: NOW });
    const s = await import('../src/sound.ts');
    s.installSoundUnlock();
    listeners.keydown![0]!();
    expect(s.playPop()).toBe(true);
    expect(s.playPop()).toBe(false);
    vi.setSystemTime(NOW + 1000);
    expect(s.playPop(true)).toBe(false);
    vi.setSystemTime(NOW + 1600);
    expect(s.playPop(true)).toBe(true);
    expect(started[2]!).toBeGreaterThan(started[0]!);
  });

  it('ajuste en localStorage chaggu:sound (por defecto encendido) con vista previa al encender', async () => {
    const s = await import('../src/sound.ts');
    expect(s.soundEnabled()).toBe(true);
    s.setSoundEnabled(false);
    expect(store.get('chaggu:sound')).toBe('0');
    expect(s.soundEnabled()).toBe(false);
    expect(s.playPop()).toBe(false);
    s.setSoundEnabled(true); // la vista previa desbloquea el audio (es un clic) y suena
    expect(store.get('chaggu:sound')).toBe('1');
    expect(started).toHaveLength(2);
  });
});
