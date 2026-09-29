export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what = 'Recurso') => new ApiError(404, 'not_found', `${what} no encontrado`);
/** Las tareas (antes «asuntos») son femeninas: «Tarea no encontrada». */
export const taskNotFound = () => new ApiError(404, 'not_found', 'Tarea no encontrada');
export const forbidden = (msg = 'No tienes acceso a este recurso') => new ApiError(403, 'forbidden', msg);
export const badRequest = (msg: string, details?: unknown) => new ApiError(400, 'bad_request', msg, details);
export const conflict = (msg: string) => new ApiError(409, 'conflict', msg);
export const unauthorized = (msg = 'Sesión inválida o vencida') => new ApiError(401, 'unauthorized', msg);
/** Mensaje de una sola vista: no se edita, reenvía, fija ni convierte en tarea (docs/TANDA-1.7.md §7). */
export const viewOnceConflict = () => new ApiError(409, 'view_once', 'Los mensajes de una sola vista no se pueden editar, reenviar, fijar ni convertir en tarea');
