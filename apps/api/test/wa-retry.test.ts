import { describe, it, expect } from 'vitest';
import { isTransientDbError, retryTransientDb } from '../src/modules/wa-retry.ts';

describe('wa-retry', () => {
  it('reconoce el pool lleno y errores de conexión', () => {
    expect(isTransientDbError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('x'), { code: '40P01' }))).toBe(true);
    expect(isTransientDbError(new Error('Lease de privacidad vencido'))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });

  it('reintenta lo pasajero y no lo demás', async () => {
    let n = 0;
    await expect(retryTransientDb(async () => { if (++n < 3) throw new Error('timeout exceeded when trying to connect'); return 'ok'; }, { baseMs: 1 })).resolves.toBe('ok');
    expect(n).toBe(3);
    let m = 0;
    await expect(retryTransientDb(async () => { m++; throw new Error('otro'); }, { baseMs: 1 })).rejects.toThrow('otro');
    expect(m).toBe(1);
    let k = 0;
    await expect(retryTransientDb(async () => { k++; throw new Error('timeout exceeded when trying to connect'); }, { baseMs: 1, attempts: 2 })).rejects.toThrow();
    expect(k).toBe(2);
  });
});
