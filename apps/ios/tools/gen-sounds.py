#!/usr/bin/env python3
"""
Genera los sonidos de mensaje y los tonos de llamada de la app iOS (docs/SONIDOS.md) como .caf, con las MISMAS notas
que la web (apps/web/src/sound.ts, MESSAGE_RECIPES y RINGTONE_RECIPES): oscilador seno o triángulo con ataque de 12 ms
y caída exponencial. Una mención es el mismo sonido una quinta más aguda (×1,5).

    python3 apps/ios/tools/gen-sounds.py      # escribe TieComs/Resources/Sounds/snd_*.caf y ring_*.caf (usa afconvert de macOS)
"""
import math, os, struct, subprocess, tempfile, wave

RATE = 44100
# Volumen: la web suena por WebAudio a su nivel; en el teléfono se sube un poco (sin pasar de 0,95).
GAIN = 2.2

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
RING = {
    'clasico': [(440, 0, 0.35, 'sine', 0.14), (480, 0, 0.35, 'sine', 0.12), (440, 0.45, 0.35, 'sine', 0.14), (480, 0.45, 0.35, 'sine', 0.12)],
    'suave': [(659.3, 0, 0.3, 'triangle', 0.12), (784, 0.25, 0.3, 'triangle', 0.12), (987.8, 0.5, 0.45, 'triangle', 0.12)],
    'marimba': [(784, 0, 0.12, 'triangle', 0.18), (659.3, 0.14, 0.12, 'triangle', 0.18), (784, 0.28, 0.12, 'triangle', 0.18), (1046.5, 0.42, 0.25, 'triangle', 0.18)],
}


def osc(wave_kind, phase):
    if wave_kind == 'triangle':
        x = (phase / (2 * math.pi)) % 1.0
        return 4 * x - 1 if x < 0.5 else 3 - 4 * x
    return math.sin(phase)


def envelope(t, dur, peak):
    """exponentialRamp 0.0001 → peak en 12 ms, luego → 0.0001 al final de la nota (como la web)."""
    lo, att = 0.0001, 0.012
    if t < 0 or t > dur + 0.03:
        return 0.0
    if t < att:
        return lo * (peak / lo) ** (t / att)
    if t <= dur:
        return peak * (lo / peak) ** ((t - att) / max(1e-6, dur - att))
    return 0.0


def render(notes, transpose=1.0):
    length = max(at + dur for _, at, dur, _, _ in notes) + 0.05
    n = int(length * RATE)
    out = [0.0] * n
    for f, at, dur, kind, peak in notes:
        start = int(at * RATE)
        for i in range(int((dur + 0.03) * RATE)):
            j = start + i
            if j >= n:
                break
            t = i / RATE
            out[j] += envelope(t, dur, peak) * osc(kind, 2 * math.pi * f * transpose * t)
    return [max(-0.95, min(0.95, s * GAIN)) for s in out]


def write_caf(samples, path):
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        wav = tmp.name
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', int(s * 32767)) for s in samples))
    subprocess.run(['afconvert', '-f', 'caff', '-d', 'LEI16@44100', wav, path], check=True)
    os.unlink(wav)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, '..', 'TieComs', 'Resources', 'Sounds')
    for name, notes in MESSAGE.items():
        write_caf(render(notes), os.path.join(out, f'snd_{name}.caf'))
        write_caf(render(notes, 1.5), os.path.join(out, f'snd_{name}_m.caf'))
    for name, notes in RING.items():
        write_caf(render(notes), os.path.join(out, f'ring_{name}.caf'))
    print('listo:', len(MESSAGE) * 2, 'sonidos y', len(RING), 'tonos en', os.path.normpath(out))


if __name__ == '__main__':
    main()
