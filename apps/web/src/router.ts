import { useSyncExternalStore } from 'react';

/** Prefijo de rutas: '' en app.tiecoms.com y en las apps nativas; configurable con VITE_BASE. */
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
export const asset = (p: string) => `${BASE}${p}`;

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', notify);

export function navigate(path: string, replace = false) {
  const to = BASE + path;
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', to); else history.pushState(null, '', to);
  notify();
}

export function usePath() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => location.pathname.slice(BASE.length) || '/');
}

export type Route =
  | { name: 'today' } | { name: 'inbox' } | { name: 'people' } | { name: 'settings' } | { name: 'spaces' }
  | { name: 'conversation'; id: string } | { name: 'workspace'; id: string }
  | { name: 'login' } | { name: 'signup' } | { name: 'invite'; token: string };

export function parse(path: string): Route {
  const [, a, b] = path.split('/');
  if (a === 'c' && b) return { name: 'conversation', id: b };
  if (a === 'w' && b) return { name: 'workspace', id: b };
  if (a === 'invite' && b) return { name: 'invite', token: decodeURIComponent(b) };
  if (a === 'login') return { name: 'login' };
  if (a === 'signup') return { name: 'signup' };
  if (a === 'conversaciones') return { name: 'inbox' };
  if (a === 'espacios') return { name: 'spaces' };
  if (a === 'participantes') return { name: 'people' };
  if (a === 'ajustes') return { name: 'settings' };
  return { name: 'today' };
}
