import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // app.tiecoms.com, Tauri y Capacitor sirven la app en la raíz. VITE_BASE permite montarla bajo una ruta.
  base: process.env.VITE_BASE ?? '/',
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3020', ws: true } },
  },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 800 },
});
