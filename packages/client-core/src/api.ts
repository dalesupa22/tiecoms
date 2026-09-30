import type { ApiErrorBody } from '@tiecoms/contracts';

export class ApiRequestError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
  /** Errores que no se arreglan reintentando (permiso, validación, conflicto). */
  get permanent() { return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429 && this.status !== 401; }
}

export async function parseError(res: Response): Promise<ApiRequestError> {
  let body: ApiErrorBody | undefined;
  try { body = await res.json(); } catch {}
  // Sin cuerpo JSON (429 de nginx, 502/524 de Cloudflare) y con HTTP/2 statusText viene vacío: se traduce por estado.
  const fallback = res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'internal' : 'http_' + res.status;
  return new ApiRequestError(res.status, body?.error?.code ?? fallback, body?.error?.message ?? res.statusText, body?.error?.details);
}
