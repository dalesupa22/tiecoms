/** ¿El error pasa solo? 5xx (p. ej. 502 mientras se reemplaza el API) o red caída: se reintenta. 4xx no. */
export const isTransient = (e: any) =>
  e instanceof TypeError || (typeof e?.status === 'number' && e.status >= 500) || /^http_5\d\d$/.test(e?.code ?? '');
