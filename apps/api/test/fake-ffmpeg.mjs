#!/usr/bin/env node
// ffmpeg falso para pruebas (FFMPEG_PATH): lee -i <entrada> y escribe la salida (último argumento).
//  *.pcm → 2 s de PCM s16le 16 kHz con un tono; *.m4a → un m4a mínimo reconocible. Entrada con "romper" → falla.
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const input = readFileSync(args[args.indexOf('-i') + 1]);
const out = args[args.length - 1];
if (input.includes('romper-ffmpeg')) { process.stderr.write('Invalid data found when processing input'); process.exit(1); }
if (out.endsWith('.pcm')) {
  const n = 16000 * 2, b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 12000 * (i < n / 2 ? 1 : 0.3)), i * 2);
  writeFileSync(out, b);
} else if (out.endsWith('.m4a')) {
  writeFileSync(out, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A \0\0\0\0M4A mp42isom', 'latin1'), Buffer.from('aac-falso')]));
} else process.exit(2);
