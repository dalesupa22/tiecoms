import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage, TieComsClient, type ClientNotice } from '@tiecoms/client-core';
import { callUserId, type CallDTO } from '@tiecoms/contracts';

// Llamadas en varios dispositivos (1.7.1): myDevices se conserva entre eventos y el aviso se cierra en los demás.
const call = (extra: Partial<CallDTO> = {}): CallDTO => ({ id: 'k1', conversationId: 'chat', kind: 'audio', startedBy: 'ana', startedAt: '2026-09-29T10:00:00Z', endedAt: null, activeUserIds: ['ana'], transcribing: false, hasTranscript: false, ...extra });
function fixture() {
  const notices: ClientNotice[] = [];
  const client = new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'test', storage: new MemoryStorage(), onNotice: (n) => notices.push(n) });
  (client as any).state = { ...client.getState(), status: 'ready', data: { me: { id: 'ana' }, conversations: [{ id: 'chat', lastEventSeq: 0 }] } };
  (client as any).deviceId = 'webA1111-xyz';
  return { client, notices };
}

describe('llamadas en varios dispositivos', () => {
  it('callUserId saca la persona del ExternalUserId (con y sin #)', () => {
    expect(callUserId('u-1#webA1111')).toBe('u-1');
    expect(callUserId('u-1')).toBe('u-1');
  });
  it('el call.updated de la conversación no borra mis dispositivos; el de mi cuenta los reemplaza', () => {
    const { client } = fixture();
    (client as any).onAccountEvent({ type: 'call.updated', call: call({ myDevices: [{ deviceKey: 'iosB2222', platform: 'ios', label: 'iPhone' }] }) });
    (client as any).onConversationEvent({ type: 'call.updated', conversationId: 'chat', eventSeq: 1, call: call({ activeUserIds: ['ana', 'beto'] }) });
    expect(client.getState().calls.chat).toMatchObject({ activeUserIds: ['ana', 'beto'], myDevices: [{ deviceKey: 'iosB2222' }] });
    (client as any).onAccountEvent({ type: 'call.updated', call: call({ myDevices: [] }) });
    expect(client.getState().calls.chat?.myDevices).toEqual([]);
  });
  it('contestar en otro dispositivo cierra el aviso aquí; en este mismo no', () => {
    const { client, notices } = fixture();
    expect(client.deviceKey).toBe('webA1111');
    (client as any).onAccountEvent({ type: 'call.answered', callId: 'k1', conversationId: 'chat', deviceKey: 'webA1111', platform: 'web', label: 'Navegador' });
    expect(notices).toEqual([]);
    (client as any).onAccountEvent({ type: 'call.answered', callId: 'k1', conversationId: 'chat', deviceKey: 'iosB2222', platform: 'ios', label: 'iPhone' });
    (client as any).onAccountEvent({ type: 'call.declined', callId: 'k1', conversationId: 'chat' });
    expect(notices).toEqual([{ kind: 'callHandled', callId: 'k1', how: 'answered', label: 'iPhone' }, { kind: 'callHandled', callId: 'k1', how: 'declined' }]);
  });
  it('entrar, latir y salir mandan la llave de este dispositivo; «Pasar aquí» saca al otro', async () => {
    const { client } = fixture();
    const bodies: [string, any][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      bodies.push([new URL(url, 'http://x').pathname, JSON.parse(String(init.body ?? '{}'))]);
      return new Response(JSON.stringify(url.includes('heartbeat') ? { ok: true } : { call: call(), meeting: {}, attendee: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await client.joinCall('k1');
    await client.callHeartbeat('k1');
    await client.leaveCall('k1', false, 'iosB2222');
    await client.leaveCall('k1');
    expect(bodies).toEqual([
      ['/api/v1/calls/k1/join', { deviceKey: 'webA1111' }],
      ['/api/v1/calls/k1/heartbeat', { deviceKey: 'webA1111' }],
      ['/api/v1/calls/k1/leave', { deviceKey: 'iosB2222' }],
      ['/api/v1/calls/k1/leave', { deviceKey: 'webA1111' }],
    ]);
    vi.unstubAllGlobals();
  });
});
