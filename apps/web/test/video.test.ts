import { describe, expect, it } from 'vitest';
import { estimateBytes, formatBytes, formatDuration, moovBeforeMdat, mp4Name, planVideo, targetSize, targetVideoBps, type VideoProbe } from '../src/video.ts';

const MB = 1024 * 1024;
const base: VideoProbe = { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1280, height: 720, sizeBytes: 3 * MB, durationSec: 20, fps: 30, moovFirst: true };

describe('decidir si recodificar', () => {
  it('un MP4 H.264 ≤ 720p y liviano se sube tal cual', () => {
    expect(planVideo(base)).toBe('keep');
    expect(planVideo({ ...base, width: 720, height: 1280 })).toBe('keep'); // vertical
    expect(planVideo({ ...base, audioCodec: null })).toBe('keep');
  });
  it('compatible pero con moov al final o en MOV: se reempaqueta sin recodificar', () => {
    expect(planVideo({ ...base, moovFirst: false })).toBe('remux');
    expect(planVideo({ ...base, moovFirst: null })).toBe('remux');
    expect(planVideo({ ...base, container: 'mov' })).toBe('remux');
  });
  it('más grande que 720p, HEVC, VP9, 60 fps, audio no AAC o pesado: se comprime', () => {
    expect(planVideo({ ...base, width: 1920, height: 1080 })).toBe('transcode');
    expect(planVideo({ ...base, videoCodec: 'hevc' })).toBe('transcode');
    expect(planVideo({ ...base, container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' })).toBe('transcode');
    expect(planVideo({ ...base, fps: 60 })).toBe('transcode');
    expect(planVideo({ ...base, audioCodec: 'opus' })).toBe('transcode');
    // 720p compatible pero 40 MB en 20 s (16 Mbps): pesa de más.
    expect(planVideo({ ...base, sizeBytes: 40 * MB })).toBe('transcode');
    expect(planVideo({ ...base, videoCodec: null })).toBe('transcode');
  });
  it('compatible, más de 5 MB pero ya con bitrate bajo (≤ 2,6 Mbps): no se gana nada recodificando', () => {
    // 30 MB en 120 s = 2,1 Mbps.
    expect(planVideo({ ...base, sizeBytes: 30 * MB, durationSec: 120 })).toBe('keep');
  });
});

describe('tamaño y bitrate de salida', () => {
  it('lado largo ≤ 1280 y corto ≤ 720, conserva la proporción y usa pares', () => {
    expect(targetSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(targetSize(1080, 1920)).toEqual({ width: 720, height: 1280 });
    expect(targetSize(3840, 2160)).toEqual({ width: 1280, height: 720 });
    expect(targetSize(1440, 1080)).toEqual({ width: 960, height: 720 }); // 4:3
    expect(targetSize(640, 360)).toEqual({ width: 640, height: 360 }); // no agranda
    expect(targetSize(853, 481)).toEqual({ width: 854, height: 482 });
  });
  it('2 Mbps a 720p, menos en resoluciones chicas y en videos largos para caber en 150 MB', () => {
    expect(targetVideoBps(1280, 720, 60)).toBe(2_000_000);
    expect(targetVideoBps(640, 360, 60)).toBe(700_000);
    const long = targetVideoBps(1280, 720, 20 * 60); // 20 min
    expect(long).toBeLessThan(2_000_000);
    expect(estimateBytes(20 * 60, long)).toBeLessThanOrEqual(150 * MB);
    expect(targetVideoBps(1280, 720, 5 * 3600)).toBe(450_000); // piso
  });
});

describe('formatos', () => {
  it('duración', () => {
    expect(formatDuration(42_000)).toBe('0:42');
    expect(formatDuration(187_400)).toBe('3:07');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(-1)).toBe('');
  });
  it('tamaños con coma decimal en español', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(820 * 1024)).toBe('820 KB');
    expect(formatBytes(8.4 * MB)).toBe('8,4 MB');
    expect(formatBytes(800 * MB)).toBe('800 MB');
    expect(formatBytes(1.2 * 1024 * MB)).toBe('1,2 GB');
    expect(formatBytes(1.2 * 1024 * MB, 'en')).toBe('1.2 GB');
  });
  it('nombre del archivo comprimido', () => {
    expect(mp4Name('IMG_0042.MOV')).toBe('IMG_0042.mp4');
    expect(mp4Name('paseo.webm')).toBe('paseo.mp4');
    expect(mp4Name('sin extension')).toBe('sin extension.mp4');
  });
});

describe('moov antes de mdat', () => {
  const box = (type: string, len: number) => { const b = new Uint8Array(len); new DataView(b.buffer).setUint32(0, len); b.set([...type].map((c) => c.charCodeAt(0)), 4); return b; };
  const file = (...boxes: Uint8Array[]) => { const out = new Uint8Array(boxes.reduce((n, b) => n + b.length, 0)); let o = 0; for (const b of boxes) { out.set(b, o); o += b.length; } return out; };
  const reader = (f: Uint8Array) => async (o: number, l: number) => f.subarray(o, o + l);
  it('detecta fastStart y el caso contrario', async () => {
    const fast = file(box('ftyp', 24), box('moov', 100), box('mdat', 300));
    const slow = file(box('ftyp', 24), box('free', 8), box('mdat', 300), box('moov', 100));
    expect(await moovBeforeMdat(reader(fast), fast.length)).toBe(true);
    expect(await moovBeforeMdat(reader(slow), slow.length)).toBe(false);
    expect(await moovBeforeMdat(reader(new Uint8Array(4)), 4)).toBeNull();
  });
});
