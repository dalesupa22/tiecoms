export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what = 'Recurso') => new ApiError(404, 'not_found', `${what} no encontrado`);
export const forbidden = (msg = 'No tienes acceso a este recurso') => new ApiError(403, 'forbidden', msg);
export const badRequest = (msg: string, details?: unknown) => new ApiError(400, 'bad_request', msg, details);
export const conflict = (msg: string) => new ApiError(409, 'conflict', msg);
export const unauthorized = (msg = 'Sesión inválida o vencida') => new ApiError(401, 'unauthorized', msg);
