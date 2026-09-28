import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), apns: vi.fn(), fcm: vi.fn() }));
vi.mock('../src/db.ts', () => ({ pool: { query: mocks.query }, tx: vi.fn() }));
vi.mock('../src/push-transport.ts', () => ({ sendApns: mocks.apns, sendFcm: mocks.fcm }));
vi.mock('../src/modules/attachments.ts', () => ({ summarize: () => null, summaryText: () => '' }));
import { pushMessage, pushStats } from '../src/modules/push.ts';
import { safePushReason } from '../src/push-reason.ts';

const secret = 'SYNTHETIC_PRIVATE_DEVICE_TOKEN';
const target = { user_id: 'recipient', sub_id: 'subscription', provider: 'apns', token: secret, environment: 'production', lang: 'es', mentioned: false };
let targets: typeof target[];
let deletion: () => Promise<{ rows: never[]; rowCount: number }>;
let log: ReturnType<typeof vi.spyOn>, errorLog: ReturnType<typeof vi.spyOn>;
const events = (): Record<string, unknown>[] => log.mock.calls.map((args: unknown[]) => JSON.parse(String(args[0])) as Record<string, unknown>)
  .filter((event: Record<string, unknown>) => event.evt === 'push.delivery');
beforeEach(() => {
  vi.resetAllMocks(); targets = [{ ...target }]; deletion = async () => ({ rows: [], rowCount: 1 });
  Object.assign(pushStats, { sent: 0, failed: 0, removed: 0 });
  log = vi.spyOn(console, 'log').mockImplementation(() => {}); errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.apns.mockResolvedValue({ ok: true }); mocks.fcm.mockResolvedValue({ ok: true });
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM messages m JOIN conversations')) return { rows: [{ id: 'message', conversation_id: 'chat', author_id: 'author', seq: 4, body: 'PRIVATE_BODY', kind: 'text', conv_kind: 'direct', author_name: 'PRIVATE_TITLE' }] };
    if (sql.includes('FROM conversation_memberships cm')) return { rows: targets };
    if (sql.includes('FROM conversations c JOIN workspaces')) return { rows: [] };
    if (sql.includes('COALESCE(sum(')) return { rows: [{ user_id: 'recipient', n: 2 }] };
    if (sql.startsWith('DELETE')) return deletion();
    if (sql.startsWith('UPDATE push_subscriptions')) return { rows: [], rowCount: 1 };
    throw new Error('Unexpected mock query');
  });
});
afterEach(() => vi.restoreAllMocks());

describe('push outcome evidence with mocked DB and transport', () => {
  it.each(['apns', 'fcm'])('records %s acceptance without token or content and without claiming display', async (provider) => {
    targets[0]!.provider = provider;
    await pushMessage('message');
    expect(events()).toEqual([{ evt: 'push.delivery', result: 'accepted', type: 'message', messageId: 'message', conversationId: 'chat', user: 'recipient', sub: 'subscription', provider, env: 'production' }]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SYNTHETIC_PRIVATE|PRIVATE_BODY|PRIVATE_TITLE|displayed/);
    expect(pushStats.sent).toBe(1);
  });
  it('records no eligible recipients without invoking either provider', async () => {
    targets = []; await pushMessage('message');
    expect(events()).toEqual([{ evt: 'push.delivery', result: 'no_eligible_targets', type: 'message', messageId: 'message', conversationId: 'chat' }]);
    expect(mocks.apns).not.toHaveBeenCalled(); expect(mocks.fcm).not.toHaveBeenCalled();
  });
  it.each(['apns', 'fcm'])('keeps %s not configured separate from failed and accepted', async (provider) => {
    targets[0]!.provider = provider;
    mocks[provider as 'apns' | 'fcm'].mockResolvedValue({ ok: false, invalidToken: false, error: `${provider}_not_configured` });
    await pushMessage('message');
    expect(events()[0]).toMatchObject({ result: 'not_configured', reason: `${provider}_not_configured` });
    expect(pushStats).toEqual({ sent: 0, removed: 0, failed: 0 });
  });
  it('records a safe provider failure and persists only its allowed code', async () => {
    mocks.apns.mockResolvedValue({ ok: false, invalidToken: false, error: 'apns_403_ExpiredProviderToken' });
    await pushMessage('message');
    expect(events()[0]).toMatchObject({ result: 'failed', reason: 'apns_403_ExpiredProviderToken' });
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual(['subscription', 'apns_403_ExpiredProviderToken']);
  });
  it('does not call a token removed until DB confirmation and counts the confirmed removal', async () => {
    let resolve!: (value: { rows: never[]; rowCount: number }) => void;
    deletion = () => new Promise((r) => { resolve = r; });
    mocks.apns.mockResolvedValue({ ok: false, invalidToken: true, error: 'apns_410_Unregistered' });
    const run = pushMessage('message');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    expect(events()).toEqual([]);
    resolve({ rows: [], rowCount: 1 }); await run;
    expect(events()[0]).toMatchObject({ result: 'invalid_token_removed', cleanup: 'removed' }); expect(pushStats.removed).toBe(1);
  });
  it('does not claim deletion if cleanup fails; the job can still fail', async () => {
    deletion = async () => { throw new Error('DB unavailable'); };
    mocks.apns.mockResolvedValue({ ok: false, invalidToken: true, error: 'apns_410_Unregistered' });
    await expect(pushMessage('message')).rejects.toThrow('DB unavailable');
    expect(events()[0]).toMatchObject({ result: 'invalid_token', cleanup: 'failed' }); expect(pushStats.removed).toBe(0);
  });
  it('does not claim removal when another job has already removed the subscription', async () => {
    deletion = async () => ({ rows: [], rowCount: 0 });
    mocks.apns.mockResolvedValue({ ok: false, invalidToken: true, error: 'apns_410_Unregistered' });
    await pushMessage('message');
    expect(events()[0]).toMatchObject({ result: 'invalid_token', cleanup: 'not_present' }); expect(pushStats.removed).toBe(0);
  });
  it('does not write arbitrary thrown error secrets or injected newlines to any log or DB field', async () => {
    mocks.apns.mockRejectedValue(new Error(`${secret}\n{"evt":"fake"} PRIVATE_BODY`));
    await pushMessage('message');
    expect(events()).toHaveLength(1); expect(events()[0]).toMatchObject({ result: 'failed', reason: 'transport_error' });
    expect(JSON.stringify([log.mock.calls, errorLog.mock.calls, mocks.query.mock.calls])).not.toContain(secret);
  });
  it.each([
    ['apns_network: secret?token=PRIVATE', 'apns_network'],
    ['fcm_network: Authorization: PRIVATE', 'fcm_network'],
    ['apns_400_PRIVATE_TOKEN', 'apns_400'],
    ['fcm_403_PRIVATE_TOKEN', 'fcm_403'],
    ['fcm_503_UNAVAILABLE', 'fcm_503_UNAVAILABLE'],
    ['fcm_oauth_401', 'fcm_oauth_401'],
    ['PRIVATE_not_configured', 'transport_error'],
    ['apns_400_BadDeviceToken\nPRIVATE', 'transport_error'],
  ])('normalizes reason %s without retaining arbitrary suffixes', (raw, expected) => {
    expect(safePushReason(raw)).toBe(expected);
  });
});
