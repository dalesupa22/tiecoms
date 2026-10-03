// Empaqueta API y worker en archivos únicos (sin dependencias nativas) para la imagen de producción.
import { build } from 'esbuild';
import { cp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Sin el parche de patches/ (companion_reg_refresh) el QR de WhatsApp no vincula: se exige.
const baileysSocket = createRequire(import.meta.url).resolve('baileys').replace(/index\.js$/, 'Socket/socket.js');
if (!(await readFile(baileysSocket, 'utf8')).includes('companion_reg_refresh')) {
  throw new Error('baileys sin parchear: corre npm install (postinstall aplica patches/)');
}

if (!(await readFile(baileysSocket.replace(/socket\.js$/, 'chats.js'), 'utf8')).includes('Chaggu privacy receipt')) {
  throw new Error('baileys sin recibo de privacidad: corre npm install');
}

await rm('dist', { recursive: true, force: true });
const bundled = await build({
  entryPoints: { server: 'src/server.ts', worker: 'src/worker.ts', 'wa-bridge': 'src/wa-bridge.ts', migrate: 'src/migrate-cli.ts', moderation: 'src/moderation-cli.ts', deletion: 'src/deletion-cli.ts', ops: 'src/ops-cli.ts', pdfjs: 'src/pdfjs-entry.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false,
  metafile: true,
  // Algunos paquetes CommonJS usan require(); lo habilitamos en ESM.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  // Dependencias opcionales de Baileys (miniaturas, audio, vista previa de links): no se usan.
  external: ['pg-native', 'bufferutil', 'utf-8-validate', 'sharp', 'jimp', 'link-preview-js', 'audio-decode', 'qrcode-terminal'],
});
// Baileys generates a large protobuf graph at import time. Only the dedicated
// bridge has the memory budget and responsibility to load it.
for (const entry of ['server', 'worker']) {
  const output = bundled.metafile.outputs[`dist/${entry}.js`];
  const heavy = Object.keys(output.inputs).filter((path) => /node_modules\/(?:@whiskeysockets\/)?baileys\//.test(path));
  if (heavy.length) throw new Error(`${entry} must not import Baileys: ${heavy[0]}`);
}
await cp('migrations', 'dist/migrations', { recursive: true });
console.log('api: dist listo');
