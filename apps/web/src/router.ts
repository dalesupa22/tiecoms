import { useSyncExternalStore } from 'react';

/** Prefijo de rutas: '' en app.chaggu.com y en las apps nativas; configurable con VITE_BASE. */
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
export const asset = (p: string) => `${BASE}${p}`;

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', notify);

export function navigate(path: string, replace = false) {
  const to = BASE + path;
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', to); else history.pushState(null, '', to);
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  window.dispatchEvent(new Event('chaggu:navigate'));
  notify();
}

export function usePath() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => location.pathname.slice(BASE.length) || '/');
}

export type Route =
  | { name: 'today' } | { name: 'inbox' } | { name: 'people' } | { name: 'settings' } | { name: 'spaces' } | { name: 'issues' } | { name: 'trazo' } | { name: 'agenda' } | { name: 'share' } | { name: 'whatsapp' } | { name: 'files' } | { name: 'groups' } | { name: 'dms' } | { name: 'saved' } | { name: 'scheduled' } | { name: 'signed' } | { name: 'calls' } | { name: 'mail' } | { name: 'grid' } | { name: 'notes' } | { name: 'alerts' } | { name: 'community' } | { name: 'organize' }
  | { name: 'oversight'; id: string } | { name: 'readonly'; id: string }
  | { name: 'conversation'; id: string } | { name: 'workspace'; id: string } | { name: 'waChat'; accountId: string; jid: string }
  | { name: 'login' } | { name: 'signup' } | { name: 'sso' } | { name: 'invite'; token: string } | { name: 'guestCall'; token: string } | { name: 'fileLink'; token: string } | { name: 'room'; code: string } | { name: 'booking'; slug: string } | { name: 'bookingManage'; token: string } | { name: 'bookingHome' } | { name: 'confirmSignup'; token: string };

/** cita.chaggu.com (o book.): la ruta es directa, /<nombre> abre la página de citas y /r/<clave> administra una cita. */
const vanityHost = typeof location !== 'undefined' && /^(calendar|cita|book)\./.test(location.hostname);

export function parse(path: string): Route {
  const [, a, b, c] = path.split('/');
  if (vanityHost) {
    if (a === 'r' && b) return { name: 'bookingManage', token: decodeURIComponent(b) };
    if (a && a !== 'r') return { name: 'booking', slug: decodeURIComponent(a) };
    return { name: 'bookingHome' };
  }
  if (a === 'cita' && b === 'r' && c) return { name: 'bookingManage', token: decodeURIComponent(c) };
  if (a === 'cita' && b) return { name: 'booking', slug: decodeURIComponent(b) };
  if (a === 'sala' && b) return { name: 'room', code: decodeURIComponent(b) };
  if (a === 'c' && b) return { name: 'conversation', id: b };
  if (a === 'w' && b) return { name: 'workspace', id: b };
  if (a === 'invite' && b) return { name: 'invite', token: decodeURIComponent(b) };
  if (a === 'llamada' && b) return { name: 'guestCall', token: decodeURIComponent(b) };
  if (a === 'archivo' && b) return { name: 'fileLink', token: decodeURIComponent(b) };
  if (a === 'confirmar' && b) return { name: 'confirmSignup', token: decodeURIComponent(b) };
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
  // Un chat de WhatsApp a pantalla completa (desde la bandeja): /whatsapp/:accountId/:jid.
  if (a === 'whatsapp' && b && c) return { name: 'waChat', accountId: b, jid: decodeURIComponent(c) };
  if (a === 'whatsapp') return { name: 'whatsapp' };
  if (a === 'archivos') return { name: 'files' };
  if (a === 'ver-despues') return { name: 'saved' };
  if (a === 'programados') return { name: 'scheduled' };
  if (a === 'firmas') return { name: 'signed' };
  if (a === 'llamadas') return { name: 'calls' };
  if (a === 'correo') return { name: 'mail' };
  if (a === 'notas') return { name: 'notes' };
  if (a === 'alertas') return { name: 'alerts' };
  if (a === 'comunidad') return { name: 'community' };
  if (a === 'organizar') return { name: 'organize' };
  if (a === 'directorio') return { name: 'people' };
  if (a === 'cuadricula') return { name: 'grid' };
  return { name: 'today' };
}

/** Parámetro de búsqueda actual (p. ej. ?m=12 para saltar a un mensaje). */
export function queryParam(name: string) {
  return new URLSearchParams(location.search).get(name);
}
