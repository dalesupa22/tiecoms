/**
 * Reintentos para fallas pasajeras de la base dentro del puente de WhatsApp.
 * Sin esto, un pool lleno mientras baja el historial de un WhatsApp grande hacía fallar el guardado
 * de un chat oculto y la cuenta entera quedaba en cuarentena (invisible en chaggu). 18-nov-2026.
 */
const TRANSIENT_CODES = new Set(['53300', '40001', '40P01', '57P01', '08006', '08003', 'ECONNRESET', 'ETIMEDOUT']);

export function isTransientDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { message?: unknown; code?: unknown };
  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /timeout exceeded when trying to connect|Connection terminated|Client has encountered a connection error/i.test(message);
}

export async function retryTransientDb<T>(work: () => Promise<T>, opts: { attempts?: number; baseMs?: number; shouldStop?: () => boolean } = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 1_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || !isTransientDbError(error) || opts.shouldStop?.()) throw error;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** (attempt - 1)));
    }
  }
}
