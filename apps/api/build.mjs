// Empaqueta API y worker en archivos únicos (sin dependencias nativas) para la imagen de producción.
import { build } from 'esbuild';
import { cp, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: { server: 'src/server.ts', worker: 'src/worker.ts', migrate: 'src/migrate-cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false,
  // Algunos paquetes CommonJS usan require(); lo habilitamos en ESM.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  external: ['pg-native', 'bufferutil', 'utf-8-validate'],
});
await cp('migrations', 'dist/migrations', { recursive: true });
console.log('api: dist listo');
