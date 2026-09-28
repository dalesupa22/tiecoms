import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareMeetingProof, takeMeetingProof, clearForeignMeetingProof } from '../src/meeting-oauth.ts';
const storage = () => { const values = new Map<string, string>(); return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } }; };
afterEach(() => vi.useRealTimers());
describe('meeting OAuth browser proof', () => {
  it('binds the challenge to a one-use verifier without storing the receipt', async () => {
    const s = storage();
    const challenge = await prepareMeetingProof(s, 'alice', 'google');
    const verifier = takeMeetingProof(s, 'alice', 'google');
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    expect(challenge).toBe(digest);
    expect(() => takeMeetingProof(s, 'alice', 'google')).toThrow();
  });
  it('rejects another user, provider, expiration and logout', async () => {
    const s = storage();
    await prepareMeetingProof(s, 'alice', 'google');
    expect(() => takeMeetingProof(s, 'bob', 'google')).toThrow();
    await prepareMeetingProof(s, 'alice', 'google');
    expect(() => takeMeetingProof(s, 'alice', 'zoom')).toThrow();
    await prepareMeetingProof(s, 'alice', 'google');
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 600_001);
    expect(() => takeMeetingProof(s, 'alice', 'google')).toThrow();
    vi.useRealTimers();
    await prepareMeetingProof(s, 'alice', 'google');
    clearForeignMeetingProof(s, null);
    expect(() => takeMeetingProof(s, 'alice', 'google')).toThrow();
  });
});

import { findMeetingAttempt, saveMeetingAttempt, clearForeignMeetingAttempts } from '../src/meeting-attempt.ts';
it('keeps the exact operation through dialog close/reload but never offers it to another account', () => {
  const s = storage();
  const attempt = { provider: 'google' as const, conversationId: 'chat', idempotencyKey: 'stable-key', title: 'Private meeting', durationMin: 30, timezone: 'UTC', share: true };
  saveMeetingAttempt(s, 'alice', 'chat', attempt);
  expect(findMeetingAttempt(s, 'alice', 'chat')).toEqual(attempt);
  expect(findMeetingAttempt(s, 'bob', 'chat')).toBeNull();
  clearForeignMeetingAttempts(s, null);
  expect(findMeetingAttempt(s, 'alice', 'chat')).toBeNull();
});

it('fails closed on corrupt or unavailable pending-meeting storage', () => {
  const s = storage();
  s.setItem('chaggu:meeting-attempts', '{broken');
  clearForeignMeetingAttempts(s, 'alice');
  expect(() => findMeetingAttempt(s, 'alice', 'chat')).toThrow();
  const unavailable = { ...s, getItem: () => { throw new Error('storage unavailable'); } };
  expect(() => findMeetingAttempt(unavailable, 'alice', 'chat')).toThrow();
});
