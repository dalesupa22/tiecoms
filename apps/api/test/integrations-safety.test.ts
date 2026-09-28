/** Local-only concurrency/failure regressions. Never target production or dispatch external jobs. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { safeRequestPath } from '../src/log-safety.ts';
import { deliverIntegrationEvent, validateOutgoingUrl } from '../src/modules/integration-events.ts';

const API = process.env.API_URL ?? '';
const run = randomUUID().replaceAll('-', '');
const suffix = run.slice(0, 12);
const dbTarget = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (!['localhost', '127.0.0.1'].includes(dbTarget.hostname) || !dbTarget.pathname.includes('review') || !/^http:\/\/(?:127\.0\.0\.1|localhost):/.test(API)) throw new Error('Dedicated local review API/database required');
const raw = async (path: string, token?: string, body?: unknown, key?: string, method?: string) => {
  const response = await fetch(`${API}${path}`, { method: method ?? (body ? 'POST' : 'GET'), headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() as any };
};
let auth = '', token = '', group = '', integration = '', issueId = '';
const requestTrigger = `qa_receipt_${suffix}`;
const eventTrigger = `qa_event_${suffix}`;
beforeAll(async () => {
  const signup = await raw('/api/v1/auth/signup', undefined, { name: `QA ${suffix}`, orgName: `QA Org ${suffix}`, email: `${run}@example.com`, password: 'local-test-password-2026', device: { deviceId: randomUUID(), name: 'local review', platform: 'web' } });
  expect(signup.status).toBe(200); auth = signup.json.accessToken;
  const created = await raw('/api/v1/groups', auth, { name: `QA integrations ${suffix}`, target: { kind: 'org' }, memberIds: [] });
  expect(created.status).toBe(200); group = created.json.conversationId;
  const configured = await raw(`/api/v1/conversations/${group}/integrations`, auth, { name: 'Review bot' });
  expect(configured.status).toBe(200); token = configured.json.token; integration = configured.json.integration.id;
  const issue = await raw('/api/integration/v1/issues', token, { title: 'Concurrent comments', externalId: run });
  expect(issue.status).toBe(200); issueId = issue.json.issue.id;
});
afterAll(async () => {
  for (const [name, table] of [[requestTrigger, 'integration_requests'], [eventTrigger, 'issue_events']]) {
    await pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
  }
  await pool.end();
});

describe('integration request safety', () => {
  it('serializes concurrent same-key messages and rejects changed content', async () => {
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, () => raw(`/api/hooks/${integration}`, token, { text: `once ${run}` }, key)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(responses.map((r) => r.json.messageId)).size).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND body=$2', [group, `once ${run}`])).rows[0].n).toBe(1);
    const mismatch = await raw(`/api/hooks/${integration}`, token, { text: 'changed' }, key);
    expect(mismatch.status).toBe(409); expect(mismatch.json.error.code).toBe('idempotency_mismatch');
    const wrongOperation = await raw(`/api/integration/v1/issues/${issueId}/comments`, token, { body: 'different resource' }, key);
    expect(wrongOperation.status).toBe(409);
  });
  it('serializes concurrent same-key comments and binds their issue and canonical payload', async () => {
    const key = randomUUID(); const body = `comment ${run}`;
    const responses = await Promise.all(Array.from({ length: 8 }, (_, n) => raw(`/api/integration/v1/issues/${issueId}/comments`, token, n % 2 ? { body, author: 'QA' } : { author: 'QA', body }, key)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const events = await raw(`/api/integration/v1/issues/${issueId}`, token);
    expect(events.json.events.filter((e: any) => e.kind === 'comment' && e.payload.body.includes(body))).toHaveLength(1);
    expect((await raw(`/api/integration/v1/issues/${issueId}/comments`, token, { body: body + ' changed', author: 'QA' }, key)).status).toBe(409);
    const other = await raw('/api/integration/v1/issues', token, { title: 'Other issue', externalId: run + '-other' });
    expect((await raw(`/api/integration/v1/issues/${other.json.issue.id}/comments`, token, { body, author: 'QA' }, key)).status).toBe(409);
  });
  it('rolls back side effects if replay-receipt storage fails, then retries once', async () => {
    const key = randomUUID(); const body = `receipt failure ${run}`;
    await pool.query(`CREATE FUNCTION ${requestTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.idempotency_key = '${key}' THEN RAISE EXCEPTION 'Synthetic receipt failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${requestTrigger} BEFORE INSERT ON integration_requests FOR EACH ROW EXECUTE FUNCTION ${requestTrigger}()`);
    const before = (await pool.query('SELECT count(*)::int AS n FROM issue_events WHERE issue_id=$1', [issueId])).rows[0].n;
    try {
      expect((await raw(`/api/integration/v1/issues/${issueId}/comments`, token, { body }, key)).status).toBe(500);
      expect((await pool.query('SELECT count(*)::int AS n FROM issue_events WHERE issue_id=$1', [issueId])).rows[0].n).toBe(before);
      expect((await pool.query('SELECT count(*)::int AS n FROM integration_requests WHERE integration_id=$1 AND idempotency_key=$2', [integration, key])).rows[0].n).toBe(0);
    } finally { await pool.query(`DROP TRIGGER ${requestTrigger} ON integration_requests`); }
    expect((await raw(`/api/integration/v1/issues/${issueId}/comments`, token, { body }, key)).status).toBe(200);
    expect((await raw(`/api/integration/v1/issues/${issueId}/comments`, token, { body }, key)).status).toBe(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM issue_events WHERE issue_id=$1', [issueId])).rows[0].n).toBe(before + 1);
  });
  it('rolls back an entire ticket import when a later history event fails', async () => {
    const failure = `FAIL_${run}`; const externalId = run + '-atomic'; const title = `Atomic ${run}`;
    await pool.query(`CREATE FUNCTION ${eventTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'body' LIKE '%${failure}%' THEN RAISE EXCEPTION 'Synthetic history failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${eventTrigger} BEFORE INSERT ON issue_events FOR EACH ROW EXECUTE FUNCTION ${eventTrigger}()`);
    const input = { title, externalId, description: 'Initial history', history: [{ author: 'QA', body: failure }], announce: true, status: 'done' };
    try {
      expect((await raw('/api/integration/v1/issues', token, input)).status).toBe(500);
      expect((await pool.query('SELECT count(*)::int AS n FROM issues WHERE title=$1 OR (integration_id=$2 AND external_id=$3)', [title, integration, externalId])).rows[0].n).toBe(0);
      expect((await pool.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND body LIKE $2', [group, `%${title}%`])).rows[0].n).toBe(0);
    } finally { await pool.query(`DROP TRIGGER ${eventTrigger} ON issue_events`); }
    const responses = await Promise.all(Array.from({ length: 4 }, () => raw('/api/integration/v1/issues', token, input)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.json.created)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.json.issue.id)).size).toBe(1);
    const result = await raw(`/api/integration/v1/issues/${responses[0]!.json.issue.id}`, token);
    expect(result.json.issue.status).toBe('done');
    expect(result.json.events.filter((e: any) => e.kind === 'comment')).toHaveLength(2);
  });
  it('preserves old receipts without re-executing their side effect', async () => {
    const key = randomUUID(); const response = { ok: true, messageId: randomUUID() };
    await pool.query('INSERT INTO integration_requests(integration_id,idempotency_key,response) VALUES($1,$2,$3)', [integration, key, JSON.stringify(response)]);
    expect((await raw(`/api/hooks/${integration}`, token, { text: `legacy ${run}` }, key)).json).toEqual(response);
    expect((await pool.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND body=$2', [group, `legacy ${run}`])).rows[0].n).toBe(0);
  });
  it('rejects private literal outgoing URLs before saving an integration', async () => {
    for (const outgoingUrl of ['https://127.0.0.1/a', 'https://2130706433/a', 'https://169.254.169.254/latest', 'https://[0:0:0:0:0:0:0:1]/a', 'https://[::ffff:127.0.0.1]/a', 'https://10.0.0.1/', 'https://user:pass@example.com/']) {
      expect(() => validateOutgoingUrl(outgoingUrl, false)).toThrow();
      expect((await raw(`/api/v1/conversations/${group}/integrations`, auth, { name: 'Forbidden', outgoingUrl })).status).toBe(400);
    }
    expect(validateOutgoingUrl('https://hooks.example.com/callback', false).protocol).toBe('https:');
  });
  it('does not replay a receipt after the bot loses group access', async () => {
    const configured = await raw(`/api/v1/conversations/${group}/integrations`, auth, { name: 'Revoked membership bot' });
    const id = configured.json.integration.id; const bot = configured.json.integration.botUserId;
    const botToken = configured.json.token; const key = randomUUID();
    expect((await raw(`/api/hooks/${id}`, botToken, { text: 'saved before removal' }, key)).status).toBe(200);
    expect((await raw(`/api/v1/conversations/${group}/members/${bot}`, auth, undefined, undefined, 'DELETE')).status).toBe(200);
    expect((await raw(`/api/hooks/${id}`, botToken, { text: 'saved before removal' }, key)).status).toBe(404);
  });
  it('never queues or delivers group content after removing the bot', async () => {
    let requests = 0;
    const receiver = http.createServer((_req, res) => { requests++; res.end('ok'); });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    try {
      const port = (receiver.address() as AddressInfo).port;
      // localhost is excluded from the dedicated review runner; deliver below explicitly.
      const configured = await raw(`/api/v1/conversations/${group}/integrations`, auth, { name: 'Outgoing access QA', outgoingUrl: `http://localhost:${port}/only-local` });
      expect(configured.status).toBe(200);
      const id = configured.json.integration.id; const bot = configured.json.integration.botUserId;
      const created = await raw('/api/integration/v1/issues', configured.json.token, { title: 'Access scoped', externalId: run + '-outgoing' });
      expect(created.status).toBe(200); const issue = created.json.issue.id;
      expect((await raw(`/api/v1/issues/${issue}/comments`, auth, { body: 'Queued while bot could read' })).status).toBe(200);
      const queued = (await pool.query('SELECT id FROM integration_deliveries WHERE integration_id=$1', [id])).rows;
      expect(queued).toHaveLength(1);
      expect((await raw(`/api/v1/conversations/${group}/members/${bot}`, auth, undefined, undefined, 'DELETE')).status).toBe(200);
      expect((await raw(`/api/v1/issues/${issue}/comments`, auth, { body: 'Must never leave this group' })).status).toBe(200);
      expect((await pool.query('SELECT count(*)::int AS n FROM integration_deliveries WHERE integration_id=$1', [id])).rows[0].n).toBe(1);
      await deliverIntegrationEvent(queued[0].id);
      expect(requests).toBe(0);
      expect((await pool.query('SELECT delivered_at,attempts FROM integration_deliveries WHERE id=$1', [queued[0].id])).rows[0]).toMatchObject({ delivered_at: null, attempts: 0 });
    } finally { await new Promise<void>((resolve) => receiver.close(() => resolve())); }
  });
  it('redacts path tokens and OAuth queries, including malformed/nonexistent routes', async () => {
    expect(safeRequestPath('/api/hooks/id/FAKE_PATH_SECRET?x=1')).toBe('/api/hooks/[redacted]');
    expect(safeRequestPath('/api/%68ooks/id/FAKE_PATH_SECRET')).toBe('/api/hooks/[redacted]');
    expect(safeRequestPath('/api/hooks/id/FAKE_PATH_SECRET/extra')).toBe('/api/hooks/[redacted]');
    expect(safeRequestPath('/api/v1/auth/google/callback?code=FAKE_CODE')).toBe('/api/v1/auth/google/callback');
    const response = await raw('/api/hooks/id/FAKE_PATH_SECRET/extra', undefined, { text: 'test' });
    expect(response.status).toBe(404); expect(JSON.stringify(response.json)).not.toContain('FAKE_PATH_SECRET');
  });
});
