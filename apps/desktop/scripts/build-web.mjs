// Compila la web para empaquetarla en la app (igual en macOS y Windows, sin sintaxis de bash).
// Sin mapas de depuración (.map): en la web sirven para los errores; dentro de la app solo pesan (~13 MB).
import { execSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const api = process.env.CHAGGU_API_ORIGIN ?? 'https://app.chaggu.com';
execSync('npm -w @tiecoms/web run build', { stdio: 'inherit', env: { ...process.env, VITE_API_ORIGIN: api, VITE_BASE: '/' } });

// fileURLToPath y no .pathname: en Windows .pathname da «/D:/…», que no es una ruta.
const dist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
for (const f of walk(dist)) if (f.endsWith('.map') || basename(f) === 'sw.js') rmSync(f);
