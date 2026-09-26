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
  | { name: 'today' } | { name: 'inbox' } | { name: 'people' } | { name: 'settings' } | { name: 'spaces' } | { name: 'issues' } | { name: 'trazo' } | { name: 'agenda' } | { name: 'share' } | { name: 'whatsapp' } | { name: 'files' } | { name: 'groups' } | { name: 'dms' }
  | { name: 'oversight'; id: string } | { name: 'readonly'; id: string }
  | { name: 'conversation'; id: string } | { name: 'workspace'; id: string }
  | { name: 'login' } | { name: 'signup' } | { name: 'sso' } | { name: 'invite'; token: string };

export function parse(path: string): Route {
  const [, a, b] = path.split('/');
  if (a === 'c' && b) return { name: 'conversation', id: b };
  if (a === 'w' && b) return { name: 'workspace', id: b };
  if (a === 'invite' && b) return { name: 'invite', token: decodeURIComponent(b) };
  if (a === 'auth' && b === 'sso') return { name: 'sso' };
  if (a === 'login') return { name: 'login' };
  if (a === 'signup') return { name: 'signup' };
  if (a === 'conversaciones') return { name: 'inbox' };
  if (a === 'grupos') return { name: 'groups' };
  if (a === 'dms') return { name: 'dms' };
  if (a === 'supervision' && b) return { name: 'oversight', id: b };
  if (a === 'ver' && b) return { name: 'readonly', id: b };
  if (a === 'espacios') return { name: 'spaces' };
  if (a === 'participantes') return { name: 'people' };
  if (a === 'ajustes') return { name: 'settings' };
  if (a === 'asuntos') return { name: 'issues' };
  if (a === 'trazo') return { name: 'trazo' };
  if (a === 'agenda') return { name: 'agenda' };
  if (a === 'share') return { name: 'share' };
  if (a === 'whatsapp') return { name: 'whatsapp' };
  if (a === 'archivos') return { name: 'files' };
  return { name: 'today' };
}

/** Parámetro de búsqueda actual (p. ej. ?m=12 para saltar a un mensaje). */
export function queryParam(name: string) {
  return new URLSearchParams(location.search).get(name);
}
