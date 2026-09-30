import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@tiecoms/client-core';
import { isTransient } from '../src/transient.ts';

describe('reintentar al abrir un chat', () => {
  it('502/503/504 sin JSON (API reiniciándose) y red caída: se reintenta', () => {
    expect(isTransient(new ApiRequestError(502, 'http_502', 'Bad Gateway'))).toBe(true);
    expect(isTransient(new ApiRequestError(503, 'http_503', 'Service Unavailable'))).toBe(true);
    expect(isTransient(new TypeError('Failed to fetch'))).toBe(true);
  });
  it('permisos, no encontrado o datos inválidos: no se reintenta', () => {
    expect(isTransient(new ApiRequestError(403, 'forbidden', 'No tienes acceso'))).toBe(false);
    expect(isTransient(new ApiRequestError(404, 'not_found', 'Conversación no encontrado'))).toBe(false);
    expect(isTransient(new ApiRequestError(400, 'bad_request', 'Datos inválidos'))).toBe(false);
  });
});
