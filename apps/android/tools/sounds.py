#!/usr/bin/env python3
"""
Genera los sonidos de chaggu para Android (docs/SONIDOS.md) desde las MISMAS recetas de notas que la web
(apps/web/src/sound.ts: MESSAGE_RECIPES y RINGTONE_RECIPES): osciladores sine/triangle con ataque de 12 ms
y caída exponencial, como el GainNode de WebAudio.

Salida en app/src/main/res/raw (Ogg Opus, 48 kHz mono):
  <sonido>.ogg y <sonido>_mention.ogg (la mención, una quinta más aguda ×1,5) para los 10 sonidos de mensaje;
  ring_<tono>.ogg: un ciclo del tono de llamada rellenado hasta 2,2 s (se reproduce en bucle).

Uso: python3 tools/sounds.py   (necesita ffmpeg con libopus)
"""
import math, os, struct, subprocess, tempfile, wave

RATE = 48000
MESSAGE = {
    'pop': [(659.3, 0, 0.09, 'sine', 0.16), (987.8, 0.085, 0.13, 'sine', 0.13)],
    'gota': [(1400, 0, 0.06, 'sine', 0.14), (700, 0.05, 0.16, 'sine', 0.12)],
    'campana': [(1046.5, 0, 0.5, 'sine', 0.13), (2093, 0, 0.3, 'sine', 0.04), (1568, 0.01, 0.35, 'sine', 0.03)],
    'marimba': [(523.3, 0, 0.12, 'triangle', 0.18), (659.3, 0.1, 0.12, 'triangle', 0.16), (784, 0.2, 0.18, 'triangle', 0.15)],
    'burbuja': [(400, 0, 0.05, 'sine', 0.12), (600, 0.04, 0.05, 'sine', 0.12), (900, 0.08, 0.08, 'sine', 0.12)],
    'cristal': [(1760, 0, 0.18, 'sine', 0.09), (2637, 0.07, 0.25, 'sine', 0.07)],
    'acorde': [(523.3, 0, 0.35, 'triangle', 0.08), (659.3, 0, 0.35, 'triangle', 0.07), (784, 0, 0.35, 'triangle', 0.07)],
    'silbido': [(880, 0, 0.12, 'sine', 0.1), (1318.5, 0.12, 0.2, 'sine', 0.1)],
    'tambor': [(180, 0, 0.12, 'sine', 0.3), (120, 0.1, 0.14, 'sine', 0.26)],
    'brisa': [(587.3, 0, 0.3, 'sine', 0.07), (880, 0.12, 0.35, 'sine', 0.06), (1174.7, 0.24, 0.35, 'sine', 0.05)],
}
RINGTONE = {
    'clasico': [(440, 0, 0.35, 'sine', 0.14), (480, 0, 0.35, 'sine', 0.12), (440, 0.45, 0.35, 'sine', 0.14), (480, 0.45, 0.35, 'sine', 0.12)],
    'suave': [(659.3, 0, 0.3, 'triangle', 0.12), (784, 0.25, 0.3, 'triangle', 0.12), (987.8, 0.5, 0.45, 'triangle', 0.12)],
    'marimba': [(784, 0, 0.12, 'triangle', 0.18), (659.3, 0.14, 0.12, 'triangle', 0.18), (784, 0.28, 0.12, 'triangle', 0.18), (1046.5, 0.42, 0.25, 'triangle', 0.18)],
}
RING_EVERY = 2.2
GAIN = 2.2  # WebAudio suma sin límite; aquí se sube un poco el nivel (los picos de la receta son bajos) sin saturar.


def render(notes, transpose=1.0, length=None):
    end = max(at + dur + 0.03 for _, at, dur, _, _ in notes) + 0.02
    n = int(RATE * (length or end))
    buf = [0.0] * n
    for f, at, dur, wave_, peak in notes:
        f *= transpose
        s0, s1 = int(at * RATE), min(n, int((at + dur + 0.03) * RATE))
        for i in range(s0, s1):
            t = (i - s0) / RATE
            if t < 0.012:  # exponentialRamp 0.0001 → peak en 12 ms
                g = 0.0001 * (peak / 0.0001) ** (t / 0.012)
            elif t < dur:  # exponentialRamp peak → 0.0001 hasta dur
                g = peak * (0.0001 / peak) ** ((t - 0.012) / (dur - 0.012))
            else:
                g = 0.0
            ph = (f * t) % 1.0
            v = math.sin(2 * math.pi * ph) if wave_ == 'sine' else (4 * ph - 1 if ph < 0.5 else 3 - 4 * ph)
            buf[i] += v * g
    return [max(-1.0, min(1.0, x * GAIN)) for x in buf]


def write(name, samples, out):
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        with wave.open(tmp.name, 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
            w.writeframes(b''.join(struct.pack('<h', int(x * 32767)) for x in samples))
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', tmp.name, '-c:a', 'libopus', '-b:a', '64k', os.path.join(out, name + '.ogg')], check=True)
        os.unlink(tmp.name)


def main():
    out = os.path.join(os.path.dirname(__file__), '..', 'app', 'src', 'main', 'res', 'raw')
    os.makedirs(out, exist_ok=True)
    for name, notes in MESSAGE.items():
        write(name, render(notes), out)
        write(name + '_mention', render(notes, 1.5), out)
    for name, notes in RINGTONE.items():
        write('ring_' + name, render(notes, length=RING_EVERY), out)
    print('ok', len(MESSAGE) * 2 + len(RINGTONE), 'archivos en', os.path.normpath(out))


if __name__ == '__main__':
    main()
