/** HTTP + persisted-state regressions; requires a dedicated local review API/database, without workers. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationCreateIssueInput, IntegrationUpdateIssueInput, WebhookTaskInput } from '@tiecoms/contracts';
import { pool, tx } from '../src/db.ts';
import { appendMessage } from '../src/modules/messages.ts';

const API = process.env.API_URL ?? '';
const dbTarget = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (!['localhost', '127.0.0.1'].includes(dbTarget.hostname) || !dbTarget.pathname.includes('review') || !/^http:\/\/(?:127\.0\.0\.1|localhost):/.test(API)) {
  throw new Error('Dedicated local review API/database required');
}
const run = randomUUID();
let auth = '', actor = '', token = '', group = '', otherGroup = '', integration = '', topic = '', alternateTopic = '', foreignTopic = '', archivedTopic = '';

async function request(path: string, bearer: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', key?: string) {
  const response = await fetch(`${API}${path}`, {
    method, headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, json: await response.json() as any };
}
const create = (body: Record<string, unknown>) => request('/api/integration/v1/issues', token, { title: `Incident ${run}`, externalId: randomUUID(), ...body });
const update = (id: string, body: Record<string, unknown>) => request(`/api/integration/v1/issues/${id}`, token, body, 'PATCH');
async function snapshot() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM issues WHERE integration_id=$1) AS issues,
    (SELECT count(*)::int FROM issue_events e JOIN issues i ON i.id=e.issue_id WHERE i.integration_id=$1) AS events,
    (SELECT count(*)::int FROM messages WHERE conversation_id=$2) AS messages,
    (SELECT count(*)::int FROM integration_requests WHERE integration_id=$1) AS receipts,
    (SELECT count(*)::int FROM outbox WHERE payload->>'conversationId'=$2::text OR payload->'event'->>'conversationId'=$2::text) AS outbox,
    last_message_seq, last_event_seq FROM conversations WHERE id=$2`, [integration, group])).rows[0];
}
async function systemMessages(issueId: string) {
  const rows = (await pool.query("SELECT body, topic_id FROM messages WHERE conversation_id=$1 AND kind='system' ORDER BY seq", [group])).rows;
  return rows.flatMap((m) => {
    try {
      const payload = JSON.parse(m.body);
      return payload?.issueId === issueId && ['issue.created', 'issue.done', 'issue.closed', 'issue.reopened'].includes(payload?.k)
        ? [{ event: payload.k, topic_id: m.topic_id }] : [];
    } catch { return []; }
  });
}

beforeAll(async () => {
  const signed = await request('/api/v1/auth/signup', '', {
    name: 'Topics review', orgName: `Topics review ${run}`, email: `${run}@example.com`, password: 'local-topic-review-2026',
    device: { deviceId: randomUUID(), name: 'local topics review', platform: 'web' },
  });
  expect(signed.status).toBe(200); auth = signed.json.accessToken; actor = signed.json.user.id;
  const groupResult = await request('/api/v1/groups', auth, { name: 'Xertiflow topics review', target: { kind: 'org' }, memberIds: [] });
  expect(groupResult.status).toBe(200); group = groupResult.json.conversationId;
  const other = await request('/api/v1/groups', auth, { name: 'Other topics review', target: { kind: 'org' }, memberIds: [] });
  expect(other.status).toBe(200); otherGroup = other.json.conversationId;
  const addTopic = async (conversationId: string, name: string) => {
    const result = await request(`/api/v1/conversations/${conversationId}/topics`, auth, { name });
    expect(result.status).toBe(200); return result.json.topic.id as string;
  };
  topic = await addTopic(group, 'Issues'); alternateTopic = await addTopic(group, 'Other');
  archivedTopic = await addTopic(group, 'Archived'); foreignTopic = await addTopic(otherGroup, 'Issues');
  expect((await request(`/api/v1/topics/${archivedTopic}`, auth, { archived: true }, 'PATCH')).status).toBe(200);
  const configured = await request(`/api/v1/conversations/${group}/integrations`, auth, { name: 'Xertiflow review bot' });
  expect(configured.status).toBe(200); token = configured.json.token; integration = configured.json.integration.id;
});
afterAll(async () => { await pool.end(); });

describe('integration topics', () => {
  it('advertises topic support for callers that must never publish to General', async () => {
    const me = await request('/api/integration/v1/me', token);
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ id: integration, conversationId: group, capabilities: { issueTopics: true } });
  });
  it('accepts optional topic routing in both entry contracts and explicit clearing on update', () => {
    const input = { title: 'Incident', externalId: run, topicId: topic, fields: { Tipo: 'Bug' } };
    expect(IntegrationCreateIssueInput.parse(input)).toMatchObject(input);
    expect(WebhookTaskInput.parse(input)).toMatchObject(input);
    expect(IntegrationUpdateIssueInput.parse({ topicId: null })).toEqual({ topicId: null });
    expect(IntegrationCreateIssueInput.safeParse({ ...input, topicId: 'invalid' }).success).toBe(false);
  });

  it('routes the task, creation card, completion and announcement; retries keep one task and preserve fields', async () => {
    const input = {
      externalId: randomUUID(), title: `Routed ${run}`, topicId: topic, announce: true, status: 'done',
      description: 'Mount failed', fields: { Tipo: 'Bug', Ambiente: 'testing', Servicio: 'Montaje' }, externalMeta: { source: 'Xertiflow' },
    };
    const replies = await Promise.all(Array.from({ length: 4 }, () => create(input)));
    expect(replies.every((r) => r.status === 200)).toBe(true);
    expect(replies.filter((r) => r.json.created)).toHaveLength(1);
    expect(new Set(replies.map((r) => r.json.issue.id)).size).toBe(1);
    const issue = replies[0]!.json.issue;
    expect(issue).toMatchObject({ topicId: topic, status: 'done', fields: input.fields, externalMeta: input.externalMeta });
    expect(await systemMessages(issue.id)).toEqual([{ event: 'issue.created', topic_id: topic }, { event: 'issue.done', topic_id: topic }]);
    const announcements = (await pool.query("SELECT topic_id FROM messages WHERE conversation_id=$1 AND kind='text' AND body LIKE $2", [group, `${input.title}%`])).rows;
    expect(announcements).toEqual([{ topic_id: topic }]);
    const before = await snapshot();
    const replay = await create({ ...input, topicId: alternateTopic, fields: { Tipo: 'Changed' } });
    expect(replay.json.created).toBe(false);
    expect(replay.json.issue).toMatchObject({ id: issue.id, topicId: topic, fields: input.fields });
    expect(await snapshot()).toEqual(before);
  });

  it('uses the current topic for lifecycle messages and supports omit, change and explicit clearing', async () => {
    const created = await create({ topicId: topic, fields: { Tipo: 'Bug', Ambiente: 'testing' }, announce: false });
    expect(created.status).toBe(200); const id = created.json.issue.id;
    const changed = await update(id, { status: 'done', topicId: alternateTopic, fields: { Prioridad: 'Alta' } });
    expect(changed.status).toBe(200);
    expect(changed.json.issue).toMatchObject({ topicId: alternateTopic, fields: { Tipo: 'Bug', Ambiente: 'testing', Prioridad: 'Alta' } });
    expect(await systemMessages(id)).toEqual([{ event: 'issue.created', topic_id: alternateTopic }, { event: 'issue.done', topic_id: alternateTopic }]);
    expect((await update(id, { status: 'open' })).json.issue.topicId).toBe(alternateTopic);
    expect((await update(id, { status: 'cancelled' })).json.issue.topicId).toBe(alternateTopic);
    expect((await update(id, { status: 'open', topicId: null })).json.issue.topicId).toBeNull();
    expect((await update(id, { status: 'done' })).json.issue.topicId).toBeNull();
    expect(await systemMessages(id)).toEqual([
      { event: 'issue.created', topic_id: null }, { event: 'issue.done', topic_id: null },
      { event: 'issue.reopened', topic_id: null }, { event: 'issue.closed', topic_id: null },
      { event: 'issue.reopened', topic_id: null }, { event: 'issue.done', topic_id: null },
    ]);
  });

  it('moves only exact task lifecycle messages and emits updates, tolerating unrelated or malformed bodies', async () => {
    const target = await create({ topicId: topic, status: 'done', announce: false }); expect(target.status).toBe(200);
    const id = target.json.issue.id;
    const other = await create({ topicId: topic, status: 'done', announce: false }); expect(other.status).toBe(200);
    const untouchedBodies = [
      `legacy system body ${id}`,
      JSON.stringify({ k: 'issue.created', issueId: `prefix-${id}` }),
      JSON.stringify({ k: 'unrelated.event', issueId: id }),
    ];
    const untouchedIds = await tx(async (c) => {
      const ids: string[] = [];
      for (const body of untouchedBodies) ids.push((await appendMessage(c, { conversationId: group, authorId: actor, kind: 'system', topicId: topic, body })).id);
      return ids;
    });
    const before = await snapshot();
    expect((await update(id, { topicId: alternateTopic })).status).toBe(200);
    expect(await systemMessages(id)).toEqual([{ event: 'issue.created', topic_id: alternateTopic }, { event: 'issue.done', topic_id: alternateTopic }]);
    expect(await systemMessages(other.json.issue.id)).toEqual([{ event: 'issue.created', topic_id: topic }, { event: 'issue.done', topic_id: topic }]);
    expect((await pool.query('SELECT topic_id FROM messages WHERE id=ANY($1::uuid[])', [untouchedIds])).rows.map((m) => m.topic_id)).toEqual([topic, topic, topic]);
    const updates = (await pool.query("SELECT payload FROM conversation_events WHERE conversation_id=$1 AND event_seq>$2 AND type='message.updated'", [group, before.last_event_seq])).rows;
    expect(updates).toHaveLength(2);
    expect(updates.every((r) => r.payload.message.topicId === alternateTopic && JSON.parse(r.payload.message.body).issueId === id)).toBe(true);
  });

  it('rejects foreign, archived and nonexistent topics atomically on creation and update', async () => {
    const existing = await create({ topicId: topic, fields: { Tipo: 'Bug' }, externalMeta: { source: 'preserve' }, announce: false });
    expect(existing.status).toBe(200); const issue = existing.json.issue;
    for (const topicId of [foreignTopic, archivedTopic, randomUUID()]) {
      const before = await snapshot();
      const rejectedCreate = await create({ topicId, description: 'Must not persist', announce: true, fields: { Tipo: 'Bug' } });
      expect(rejectedCreate.status).toBe(400);
      const rejectedUpdate = await update(issue.id, { topicId, status: 'done', title: 'Must not change', fields: { Tipo: 'Changed' }, externalMeta: { source: 'changed' } });
      expect(rejectedUpdate.status).toBe(400);
      const replay = await create({ topicId, externalId: issue.externalId });
      expect(replay.status).toBe(400);
      expect(await snapshot()).toEqual(before);
      expect((await request(`/api/integration/v1/issues/${issue.id}`, token)).json.issue).toEqual(issue);
    }
  });

  it('also rejects an explicitly supplied topic archived after the task was created', async () => {
    const temporary = await request(`/api/v1/conversations/${group}/topics`, auth, { name: 'Will archive' });
    expect(temporary.status).toBe(200); const topicId = temporary.json.topic.id;
    const created = await create({ topicId, announce: false }); expect(created.status).toBe(200);
    expect((await request(`/api/v1/topics/${topicId}`, auth, { archived: true }, 'PATCH')).status).toBe(200);
    const before = await snapshot();
    expect((await update(created.json.issue.id, { topicId, status: 'done' })).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it('routes task webhooks with idempotency receipts and rolls back invalid webhook attempts', async () => {
    const key = randomUUID();
    const path = `/api/hooks/${integration}/tasks`;
    const body = { title: `Webhook ${run}`, topicId: topic, body: 'Webhook mount feedback', fields: { Tipo: 'Bug' }, announce: true };
    const replies = await Promise.all(Array.from({ length: 3 }, () => request(path, token, body, 'POST', key)));
    expect(replies.every((r) => r.status === 200)).toBe(true);
    expect(new Set(replies.map((r) => r.json.issue.id)).size).toBe(1);
    expect(replies[0]!.json.issue).toMatchObject({ topicId: topic, fields: body.fields });
    expect((await pool.query('SELECT count(*)::int AS n FROM integration_requests WHERE integration_id=$1 AND idempotency_key=$2', [integration, key])).rows[0].n).toBe(1);
    const before = await snapshot();
    expect((await request(path, token, { ...body, topicId: foreignTopic }, 'POST', randomUUID())).status).toBe(400);
    expect(await snapshot()).toEqual(before);
    expect((await request(path, token, { ...body, topicId: alternateTopic }, 'POST', key)).status).toBe(409);
  });

  it('preserves legacy requests without a topic', async () => {
    const created = await create({ announce: true }); expect(created.status).toBe(200);
    expect(created.json.issue.topicId).toBeNull();
    const done = await update(created.json.issue.id, { status: 'done' }); expect(done.status).toBe(200);
    expect(await systemMessages(created.json.issue.id)).toEqual([{ event: 'issue.created', topic_id: null }, { event: 'issue.done', topic_id: null }]);
  });

  it('preserves domain moves with an explicit destination topic or no destination topic', async () => {
    for (const setTopic of [true, false]) {
      const created = await request(`/api/v1/conversations/${group}/issues`, auth, { title: `Move review ${run}`, topicId: topic });
      expect(created.status).toBe(200);
      const id = created.json.id;
      const moved = await request(`/api/v1/issues/${id}`, auth, { conversationId: otherGroup, status: 'done', ...(setTopic ? { topicId: foreignTopic } : {}) }, 'PATCH');
      expect(moved.status).toBe(200);
      expect(moved.json).toMatchObject({ conversationId: otherGroup, topicId: setTopic ? foreignTopic : null, status: 'done' });
      const notices = (await pool.query("SELECT body, topic_id FROM messages WHERE conversation_id=$1 AND kind='system' ORDER BY seq", [otherGroup])).rows
        .filter((m) => { try { return JSON.parse(m.body)?.issueId === id; } catch { return false; } });
      expect(notices).toHaveLength(1);
      expect(notices[0].topic_id).toBe(setTopic ? foreignTopic : null);
    }
  });
});
