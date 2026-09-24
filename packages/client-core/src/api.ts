import type { ApiErrorBody } from '@tiecoms/contracts';

export class ApiRequestError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
  /** Errores que no se arreglan reintentando (permiso, validación, conflicto). */
  get permanent() { return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429 && this.status !== 401; }
}

export async function parseError(res: Response): Promise<ApiRequestError> {
  let body: ApiErrorBody | undefined;
  try { body = await res.json(); } catch {}
  return new ApiRequestError(res.status, body?.error?.code ?? 'http_' + res.status, body?.error?.message ?? res.statusText, body?.error?.details);
}
