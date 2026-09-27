// Compila la web para empaquetarla en la app (igual en macOS y Windows, sin sintaxis de bash).
import { execSync } from 'node:child_process';

const api = process.env.CHAGGU_API_ORIGIN ?? 'https://app.chaggu.com';
execSync('npm -w @tiecoms/web run build', { stdio: 'inherit', env: { ...process.env, VITE_API_ORIGIN: api, VITE_BASE: '/' } });
