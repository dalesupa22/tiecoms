/**
 * CH029: la llamada entrante va por PushKit (VoIP) al iPhone que registró ese token, sin el aviso normal en esa sesión;
 * Android y los iPhone sin VoIP reciben el aviso de siempre. Base de datos y transporte simulados.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), apns: vi.fn(), fcm: vi.fn() }));
vi.mock('../src/db.ts', () => ({ pool: { query: mocks.query }, tx: vi.fn() }));
vi.mock('../src/push-transport.ts', () => ({ sendApns: mocks.apns, sendFcm: mocks.fcm }));
vi.mock('../src/modules/attachments.ts', () => ({ summarize: () => null, summaryText: () => '' }));
import { pushCall, pushMessage } from '../src/modules/push.ts';

let targetsSql = '';
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.apns.mockResolvedValue({ ok: true }); mocks.fcm.mockResolvedValue({ ok: true });
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT id, conversation_id, kind, ended_at FROM calls')) return { rows: [{ id: 'call', conversation_id: 'chat', kind: 'audio', ended_at: null }] };
    if (sql.includes('FROM users u JOIN sessions s')) {
      targetsSql = sql;
      return { rows: [
        { user_id: 'b', sub_id: 'v', provider: 'apns_voip', token: 'VOIP', environment: 'production', lang: 'es' },
        { user_id: 'c', sub_id: 'f', provider: 'fcm', token: 'FCM', environment: 'production', lang: 'en' },
      ] };
    }
    if (sql.includes('COALESCE(sum(')) return { rows: [] };
    if (sql.startsWith('UPDATE push_subscriptions')) return { rows: [], rowCount: 1 };
    throw new Error(`consulta inesperada: ${sql.slice(0, 60)}`);
  });
});

describe('push de llamada entrante', () => {
  it('VoIP al iPhone con PushKit (sin aps) y aviso de datos a Android', async () => {
    expect(await pushCall({ callId: 'call', userIds: ['b', 'c'], callerName: 'Danny', title: null })).toBe(2);
    expect(mocks.apns).toHaveBeenCalledTimes(1);
    const [token, env, payload, opts] = mocks.apns.mock.calls[0]!;
    expect([token, env]).toEqual(['VOIP', 'production']);
    expect(opts).toMatchObject({ voip: true, collapseId: 'call-call' });
    expect(payload).toEqual({ type: 'call', callId: 'call', conversationId: 'chat', kind: 'audio', callerName: 'Danny', subtitle: null });
    expect(mocks.fcm).toHaveBeenCalledWith('FCM', expect.objectContaining({ type: 'call', callId: 'call', category: 'TC_CALL' }), expect.anything());
    // La sesión con VoIP no recibe además el aviso normal; DND y modo sueño se respetan igual.
    expect(targetsSql).toMatch(/'apns_voip'/);
    expect(targetsSql).toMatch(/NOT \(ps\.provider = 'apns' AND EXISTS/);
    expect(targetsSql).toMatch(/dnd_until/);
    expect(targetsSql).toMatch(/tiecoms_sleeping/);
  });

  it('los avisos de mensajes nunca usan el token VoIP', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM messages m JOIN conversations')) return { rows: [] };
      return { rows: [] };
    });
    await pushMessage('m');
    const sqls = mocks.query.mock.calls.map((c) => String(c[0]));
    for (const s of sqls) if (s.includes('push_subscriptions ps')) expect(s).not.toMatch(/apns_voip/);
  });
});
