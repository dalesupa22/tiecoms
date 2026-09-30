import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Recursos de pdf.js que se piden en tiempo de ejecución (decodificadores wasm con su respaldo JS,
 * fuentes estándar y CMaps): se sirven bajo /pdfjs/ en desarrollo y se copian a dist/pdfjs/ al construir.
 */
function pdfjsAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const dirs = ['wasm', 'standard_fonts', 'cmaps'];
  return {
    name: 'chaggu-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/pdfjs\/(wasm|standard_fonts|cmaps)\/([\w.-]+)$/.exec((req.url ?? '').split('?')[0]!);
        if (!m) return next();
        try {
          const body = readFileSync(join(root, m[1]!, m[2]!));
          res.setHeader('content-type', m[2]!.endsWith('.wasm') ? 'application/wasm' : m[2]!.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
          res.end(body);
        } catch { res.statusCode = 404; res.end(); }
      });
    },
    generateBundle() {
      for (const d of dirs) {
        for (const f of readdirSync(join(root, d))) {
          if (f.startsWith('LICENSE') || f.endsWith('.js') || f.endsWith('.wasm') || f.endsWith('.bcmap') || f.endsWith('.pfb') || f.endsWith('.ttf')) {
            this.emitFile({ type: 'asset', fileName: `pdfjs/${d}/${f}`, source: readFileSync(join(root, d, f)) });
          }
        }
      }
    },
  };
}

/**
 * «Actualización disponible» (docs/ACTUALIZAR.md): cada build lleva un id propio (__BUILD_ID__) y publica
 * /version.json con el mismo id. Si una pestaña abierta ve otro id, ya hay una versión nueva desplegada.
 */
const BUILD_ID = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
function buildVersion(): Plugin {
  return { name: 'chaggu-version', generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) }); } };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets(), buildVersion()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  // app.tiecoms.com, Tauri y Capacitor sirven la app en la raíz. VITE_BASE permite montarla bajo una ruta.
  base: process.env.VITE_BASE ?? '/',
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:3020', ws: true } },
  },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 800 },
});
