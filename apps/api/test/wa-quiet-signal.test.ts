import { describe, it, expect, vi } from 'vitest';
import { installSignalLogGuard, isSignalSession, redactSignalArgs } from '../src/modules/wa-quiet-signal.ts';

class SessionEntry {
  registrationId = 1;
  _chains = {};
  currentRatchet = { ephemeralKeyPair: { privKey: Buffer.from('secreto') } };
  indexInfo = {};
}

describe('wa-quiet-signal', () => {
  it('reconoce sesiones de libsignal y deja pasar lo demás', () => {
    expect(isSignalSession(new SessionEntry())).toBe(true);
    expect(isSignalSession({ currentRatchet: {} })).toBe(true);
    expect(isSignalSession({ id: 'x' })).toBe(false);
    expect(isSignalSession('Closing session:')).toBe(false);
    expect(isSignalSession(null)).toBe(false);
  });

  it('oculta la sesión al imprimir por consola', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    installSignalLogGuard();
    console.info('Closing session:', new SessionEntry());
    const printed = spy.mock.calls.flat();
    spy.mockRestore();
    expect(printed).toContain('Closing session:');
    expect(JSON.stringify(printed)).not.toContain('privKey');
    expect(redactSignalArgs(['a', 1])).toEqual(['a', 1]);
  });
});
