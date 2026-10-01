import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

// Esta suite escribe fixtures exclusivamente en el API local aislado.
const API = process.env.API_URL ?? 'http://localhost:3094';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API)) throw new Error('Lorena task regression requires a local isolated API');
const run = randomUUID().slice(0, 8);
type Actor = { id: string; token: string; orgId: string };
async function call(path: string, actor?: Actor, body?: unknown, method?: string) {
  const res = await fetch(`${API}/api/v1${path}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'x-tiecoms-contract': '2026-09-30', ...(path === '/auth/signup' ? { 'x-forwarded-for': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } : {}), ...(actor ? { authorization: `Bearer ${actor.token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
}
async function signup(name: string, invite?: string): Promise<Actor> {
  const r = await call('/auth/signup', undefined, { name, email: `${name.toLowerCase()}.lorena.${run}@example.com`, password: 'local-test-password-2026', ...(invite ? { orgInviteToken: invite } : { orgName: `${name} ${run}` }), device: { deviceId: randomUUID(), name: 'local test', platform: 'web' } });
  expect(r.status).toBe(200);
  return { token: r.json.accessToken, id: r.json.user.id, orgId: r.json.user.primaryOrgId };
}
async function colleague(actor: Actor, name: string) {
  const inv = await call(`/organizations/${actor.orgId}/invitations`, actor, { email: `${name.toLowerCase()}.lorena.${run}@example.com`, role: 'member' });
  expect(inv.status).toBe(200); return signup(name, inv.json.token);
}
async function upload(actor: Actor, issueId: string) {
  const res = await fetch(`${API}/api/v1/issues/${issueId}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/octet-stream', 'x-file-name': 'informe.pdf', 'x-file-type': 'application/pdf' }, body: new TextEncoder().encode('%PDF-1.7\nlocal task attachment\n%%EOF') });
  return { status: res.status, json: await res.json() as any };
}
let creator: Actor, lorena: Actor, reader: Actor, outsider: Actor, chat: string, destination: string, task: string;
beforeAll(async () => {
  creator = await signup('Creator'); lorena = await colleague(creator, 'Lorena'); reader = await colleague(creator, 'Reader'); outsider = await signup('Outsider');
  const group = await call('/groups', creator, { name: `Task scope ${run}`, target: { kind: 'company', companyName: 'Team' }, memberIds: [lorena.id, reader.id] });
  expect(group.status).toBe(200); chat = group.json.conversationId;
  const group2 = await call('/groups', creator, { name: `Destination ${run}`, target: { kind: 'company', companyName: 'Team 2' }, memberIds: [lorena.id] });
  expect(group2.status).toBe(200); destination = group2.json.conversationId;
});
describe('Lorena task persistence and privacy', () => {
  it('persists multiple responsible users and includes secondary assignee in mine/report', async () => {
    const r = await call(`/conversations/${chat}/issues`, creator, { title: 'Shared assigned task', assigneeIds: [creator.id, lorena.id, creator.id], dueDate: '2026-10-15' });
    expect(r.status).toBe(200); task = r.json.id;
    expect(r.json.ownerId).toBe(creator.id); expect(r.json.assigneeIds).toEqual([creator.id, lorena.id]);
    const mine = await call('/issues?mine=1', lorena); expect(mine.json.issues.some((i: any) => i.id === task)).toBe(true);
    const report = await call('/issues/report', lorena); expect(report.status).toBe(200); expect(report.json.issues.find((i: any) => i.id === task).assigneeIds).toEqual([creator.id, lorena.id]);
    const bad = await call(`/issues/${task}`, creator, { assigneeIds: [outsider.id] }, 'PATCH'); expect(bad.status).toBe(400);
  });
  it('retains old ownerId write compatibility and supports typed/calendar date edits', async () => {
    const r = await call(`/issues/${task}`, creator, { ownerId: lorena.id, dueDate: '2026-10-20' }, 'PATCH');
    expect(r.status).toBe(200); expect(r.json.assigneeIds).toEqual([lorena.id]); expect(r.json.dueDate).toBe('2026-10-20');
    const date = await call(`/issues/${task}`, creator, { dueDate: null }, 'PATCH'); expect(date.json.dueDate).toBeNull();
  });
  it('links files to restricted tasks and denies another chat participant bytes/metadata', async () => {
    expect((await call(`/issues/${task}`, creator, { visibility: 'private' }, 'PATCH')).status).toBe(200);
    const file = await upload(creator, task); expect(file.status).toBe(200);
    const before = await fetch(`${API}${file.json.url}`, { headers: { authorization: `Bearer ${lorena.token}` } }); expect(before.status).toBe(404);
    const r = await call(`/issues/${task}`, creator, { attachmentIds: [file.json.id] }, 'PATCH'); expect(r.status).toBe(200); expect(r.json.attachments[0].name).toBe('informe.pdf');
    const allowed = await fetch(`${API}${file.json.url}`, { headers: { authorization: `Bearer ${lorena.token}` } }); expect(allowed.status).toBe(200);
    const forbidden = await fetch(`${API}${file.json.url}`, { headers: { authorization: `Bearer ${reader.token}` } }); expect(forbidden.status).toBe(404);
    expect((await call(`/issues/${task}`, reader)).status).toBe(404);
    const other = await call(`/conversations/${chat}/issues`, creator, { title: 'Another task' });
    expect((await call(`/issues/${other.json.id}`, creator, { attachmentIds: [file.json.id] }, 'PATCH')).status).toBe(400);
    const deleted = await call(`/issues/${task}`, creator, { attachmentIds: [] }, 'PATCH'); expect(deleted.json.attachments).toEqual([]);
    expect((await fetch(`${API}${file.json.url}`, { headers: { authorization: `Bearer ${creator.token}` } })).status).toBe(404);
  });
  it('moves a task persistently and keeps private visibility, while non-creators cannot move it', async () => {
    expect((await call(`/issues/${task}`, lorena, { conversationId: destination }, 'PATCH')).status).toBe(403);
    const r = await call(`/issues/${task}`, creator, { conversationId: destination, status: 'in_progress' }, 'PATCH');
    expect(r.status).toBe(200); expect(r.json.conversationId).toBe(destination); expect(r.json.status).toBe('in_progress'); expect(r.json.visibility).toBe('private');
    const detail = await call(`/issues/${task}`, lorena); expect(detail.json.issue.conversationId).toBe(destination);
  });
  it('supports private personal task documents without sharing the task', async () => {
    const personal = await call('/issues', creator, { title: 'Personal report' }); expect(personal.status).toBe(200);
    const file = await upload(creator, personal.json.id); expect(file.status).toBe(200);
    const linked = await call(`/issues/${personal.json.id}`, creator, { attachmentIds: [file.json.id] }, 'PATCH'); expect(linked.status).toBe(200); expect(linked.json.attachments).toHaveLength(1);
    expect((await fetch(`${API}${file.json.url}`, { headers: { authorization: `Bearer ${lorena.token}` } })).status).toBe(404);
    expect((await call(`/issues/${personal.json.id}`, creator, { assigneeIds: [lorena.id] }, 'PATCH')).status).toBe(400);
  });
  it('exports all assigned tasks even when there are more than the 500-item page cap', async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Bulk report fixture requires isolated local DB');
    const db = new pg.Client({ connectionString: url }); await db.connect();
    try {
      expect((await db.query('SELECT current_database() AS name')).rows[0].name).toBe('chaggu_lorena_test');
      await db.query(`INSERT INTO issues (title, owner_id, created_by, assignee_ids, visibility)
        SELECT 'Report fixture ' || n, $1::uuid, $1::uuid, ARRAY[$1::uuid], 'private' FROM generate_series(1,501) n`, [creator.id]);
      const report = await call('/issues/report', creator); expect(report.status).toBe(200);
      expect(report.json.issues.filter((i: any) => i.title.startsWith('Report fixture '))).toHaveLength(501);
      const page = await call('/issues?mine=1', creator); expect(page.json.issues).toHaveLength(500);
    } finally { await db.query("DELETE FROM issues WHERE created_by = $1 AND title LIKE 'Report fixture %'", [creator.id]); await db.end(); }
  });

  it('queues one overdue notification for each responsible person without duplicate reminders', async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Overdue regression requires isolated local DB');
    const db = new pg.Client({ connectionString: url }); await db.connect();
    try {
      expect((await db.query('SELECT current_database() AS name')).rows[0].name).toBe('chaggu_lorena_test');
      const created = await call(`/conversations/${chat}/issues`, creator, { title: 'Both responsible overdue', assigneeIds: [creator.id, lorena.id], visibility: 'private', dueDate: '2026-09-29' }); expect(created.status).toBe(200);
      const { fireOverdueIssues } = await import('../src/modules/chat-notices.ts');
      await fireOverdueIssues(new Date('2026-10-01T20:00:00Z'));
      const jobs = await db.query("SELECT payload->>'ownerId' AS id FROM jobs WHERE kind = 'push.issue_overdue' AND payload->>'issueId' = $1", [created.json.id]);
      expect(jobs.rows.map((r) => r.id).sort()).toEqual([creator.id, lorena.id].sort());
      await fireOverdueIssues(new Date('2026-10-01T20:01:00Z'));
      expect((await db.query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'push.issue_overdue' AND payload->>'issueId' = $1", [created.json.id])).rows[0].n).toBe(2);
    } finally { await db.end(); }
  });

});
