import { describe, expect, it } from 'vitest';
import type { CallDTO } from '@tiecoms/contracts';
import type { CallView } from './call.ts';
import { RINGBACK_MAX_MS, shouldRingback } from './ringback-rules.ts';

const t0 = Date.parse('2026-11-19T15:00:00Z');
const call = (p: Partial<CallDTO> = {}): CallDTO => ({ id: 'k', conversationId: 'c', kind: 'audio', startedBy: 'me', startedAt: new Date(t0).toISOString(), activeUserIds: ['me'], guests: [], ...p } as CallDTO);
const view = (c: CallDTO, p: Partial<CallView> = {}): CallView => ({ call: c, phase: 'connecting', muted: false, camera: false, tiles: [], captions: [], speaking: [], mutedUsers: [], audioOutput: '', audioInput: '', error: null, sharing: false, screens: [], guest: false, ...p });

describe('tono de llamando (CH038)', () => {
  it('suena mientras quien llamó está sola', () => {
    expect(shouldRingback(view(call()), 'me', t0 + 1000)).toBe(true);
    expect(shouldRingback(view(call(), { phase: 'live' }), 'me', t0 + 1000)).toBe(true);
    expect(shouldRingback(view(call({ ringingUserIds: ['ana'] } as any)), 'me', t0 + 1000)).toBe(true);
  });
  it('se calla cuando alguien entra, al colgar o a los 45 s', () => {
    expect(shouldRingback(view(call({ activeUserIds: ['me', 'ana'] })), 'me', t0 + 1000)).toBe(false);
    expect(shouldRingback(view(call({ guests: [{ id: 'g1', name: 'Invitado' }] } as any)), 'me', t0 + 1000)).toBe(false);
    expect(shouldRingback(view(call(), { phase: 'ended' }), 'me', t0 + 1000)).toBe(false);
    expect(shouldRingback(view(call(), { error: 'mic' }), 'me', t0 + 1000)).toBe(false);
    expect(shouldRingback(view(call()), 'me', t0 + RINGBACK_MAX_MS + 1)).toBe(false);
    expect(shouldRingback(null, 'me', t0)).toBe(false);
  });
  it('no suena para quien contesta, en salas ni para invitados', () => {
    expect(shouldRingback(view(call({ startedBy: 'ana', activeUserIds: ['me'] })), 'me', t0 + 1000)).toBe(false);
    expect(shouldRingback(view(call({ roomId: 'r1' } as any)), 'me', t0 + 1000)).toBe(false);
    expect(shouldRingback(view(call(), { guest: true }), 'me', t0 + 1000)).toBe(false);
  });
});
