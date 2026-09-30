/** Local-only guard regression: enabling test providers never removes the production default-off gate. */
import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { confirmConnect, createMeeting, finishConnect, listConnections, startConnect } from '../src/modules/meetings.ts';

afterAll(() => pool.end());
it('defaults off and rejects connect, confirmation and creation before any provider request', async () => {
  const db = new URL(process.env.DATABASE_URL!);
  if (!['localhost', '127.0.0.1'].includes(db.hostname) || !db.pathname.startsWith('/chaggu_meetings_review_')) throw new Error('Dedicated local meetings review database required');
  const previous = process.env.MEETINGS_ENABLED;
  delete process.env.MEETINGS_ENABLED;
  try {
    const userId = randomUUID();
    expect((await listConnections(userId)).every((c) => !c.available && c.status === 'none')).toBe(true);
    await expect(startConnect(userId, 'google', { platform: 'web', proofChallenge: 'a'.repeat(43) })).rejects.toMatchObject({ status: 503, code: 'provider_unavailable' });
    expect(await finishConnect({ state: 'mtg_unused' }, 'google')).toContain('error=disabled');
    await expect(confirmConnect(userId, { receipt: 'a'.repeat(43), proofVerifier: 'b'.repeat(43) })).rejects.toMatchObject({ status: 503, code: 'provider_unavailable' });
    await expect(createMeeting(userId, { provider: 'google', idempotencyKey: randomUUID(), title: 'Disabled', durationMin: 30, timezone: 'America/Bogota', share: false })).rejects.toMatchObject({ status: 503, code: 'provider_unavailable' });
  } finally { if (previous === undefined) delete process.env.MEETINGS_ENABLED; else process.env.MEETINGS_ENABLED = previous; }
});
