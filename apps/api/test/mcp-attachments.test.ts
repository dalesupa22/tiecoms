/** Real HTTP + isolated PostgreSQL + fake S3. Never point this suite at production. */
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';

const API = process.env.API_URL ?? 'http://127.0.0.1:30504';
const target = new URL(API);
const database = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['127.0.0.1', 'localhost'].includes(target.hostname)
  || !['127.0.0.1', 'localhost'].includes(database.hostname) || database.pathname !== '/mcp_attachments_test') {
  throw new Error('MCP attachment suite requires the isolated local mcp_attachments_test database');
}
const run = randomUUID().slice(0, 8);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let PDF: Buffer;
let rpcId = 0;
type Actor = { session: string; mcp: string; id: string; org: string };

async function request(path: string, token?: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const r = await fetch(`${API}${path}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
    'x-forwarded-for': `10.104.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
}
async function rpc(token: string, method: string, params: unknown) {
  const r = await request('/api/mcp', token, { jsonrpc: '2.0', id: ++rpcId, method, params });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.result;
}
const tool = (token: string, name: string, args: unknown) => rpc(token, 'tools/call', { name, arguments: args });
const good = (r: any) => { expect(r.isError, JSON.stringify(r)).not.toBe(true); return r.structuredContent; };
const bad = (r: any, code?: string) => { expect(r.isError, JSON.stringify(r)).toBe(true); if (code) expect(r.structuredContent.error.code).toBe(code); };
const file = (name: string, body: Buffer, type: string, key = randomUUID()) => ({ name, content_type: type, data_base64: body.toString('base64'), idempotency_key: key });

async function signup(name: string, invite?: string): Promise<Actor> {
  const r = await request('/api/v1/auth/signup', undefined, {
    name, email: `${name}.${run}@example.com`, password: 'isolated-fixture-password-123',
    ...(invite ? { orgInviteToken: invite } : { orgName: `MCP fixture ${name} ${run}` }),
    device: { deviceId: randomUUID(), name: 'isolated MCP fixture', platform: 'web' },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const session = r.json.accessToken;
  const m = await request('/api/v1/me/mcp-tokens', session, { name: `MCP attachments ${run}` });
  expect(m.status).toBe(200);
  return { session, mcp: m.json.token, id: r.json.user.id, org: r.json.user.primaryOrgId };
}

describe('MCP attachments over HTTP in an authorized fixture DM', () => {
  let ana: Actor, beto: Actor, outsider: Actor, chat: string, task: string, pngId: string, pdfId: string, messageId: string, pendingId: string;
  beforeAll(async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]).drawText('MCP attachment fixture');
    // Valid PDF larger than both former JSON body limits (64 KiB / nginx128KiB).
    pdf.setSubject('isolated-attachment-fixture '.repeat(8000));
    PDF = Buffer.from(await pdf.save({ useObjectStreams: false }));
    expect(PDF.length).toBeGreaterThan(128 * 1024);
    ana = await signup('McpAna');
    const inv = await request(`/api/v1/organizations/${ana.org}/invitations`, ana.session, {});
    beto = await signup('McpBeto', inv.json.token);
    outsider = await signup('McpOutsider');
    const dm = await request('/api/v1/directs', ana.session, { userId: beto.id });
    expect(dm.status).toBe(200); chat = dm.json.id;
    expect(chat).toBeTruthy();
    task = good(await tool(ana.mcp, 'create_task', { chat, title: `Attachment fixture ${run}` })).task.id;
  });
  afterAll(async () => { await pool.end(); });

  it('uploads PNG and a real PDF, preserving existing scopes and bounded transport', async () => {
    const listed = await rpc(ana.mcp, 'tools/list', {});
    expect(listed.tools.map((x: any) => x.name)).toEqual(expect.arrayContaining(['upload_chat_attachment', 'upload_task_attachment', 'comment_task', 'update_task']));
    const png = good(await tool(ana.mcp, 'upload_chat_attachment', { chat, ...file('fixture.png', PNG, 'image/png') }));
    const pdf = good(await tool(ana.mcp, 'upload_chat_attachment', { chat, ...file('fixture.pdf', PDF, 'application/pdf') }));
    expect(png.attachment).toMatchObject({ name: 'fixture.png', contentType: 'image/png', sizeBytes: PNG.length, width: 1, height: 1 });
    expect(pdf.attachment).toMatchObject({ name: 'fixture.pdf', contentType: 'application/pdf', sizeBytes: PDF.length });
    pngId = png.attachment.id; pdfId = pdf.attachment.id;
    const hidden = await fetch(`${API}${png.attachment.url}`, { headers: { authorization: `Bearer ${beto.session}` } });
    expect(hidden.status).toBe(404);
  });

  it('sends both files once across concurrent retries and read_messages proves their association', async () => {
    const args = { chat, attachment_ids: [pngId, pdfId], idempotency_key: randomUUID() };
    const sent = await Promise.all(Array.from({ length: 4 }, () => tool(ana.mcp, 'send_message', args).then(good)));
    expect(new Set(sent.map(x => x.messageId)).size).toBe(1);
    messageId = sent[0].messageId;
    expect(messageId).toBeTruthy();
    expect(sent[0].attachments.map((x: any) => x.id)).toEqual([pngId, pdfId]);
    const read = good(await tool(beto.mcp, 'read_messages', { chat }));
    const m = read.messages.find((x: any) => x.id === messageId);
    expect(m.attachments).toEqual(['fixture.png', 'fixture.pdf']);
    expect(m.attachment_details.map((x: any) => x.id)).toEqual([pngId, pdfId]);
    for (const a of m.attachment_details) {
      const r = await fetch(`${API}${a.url}`, { headers: { authorization: `Bearer ${beto.session}` } });
      expect(r.status).toBe(200);
      expect(Buffer.from(await r.arrayBuffer())).toEqual(a.id === pngId ? PNG : PDF);
      expect((await fetch(`${API}${a.url}`, { headers: { authorization: `Bearer ${outsider.session}` } })).status).toBe(404);
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND author_id=$2 AND attachments @> $3::jsonb", [chat, ana.id, JSON.stringify([{ name: 'fixture.png' }])])).rows[0].n).toBe(1);
    bad(await tool(ana.mcp, 'send_message', { ...args, text: 'changed' }), 'idempotency_mismatch');
    bad(await tool(ana.mcp, 'send_message', { ...args, reply_to: messageId }), 'idempotency_mismatch');
  });

  it('deduplicates uploads concurrently and rejects reuse for different content or destination', async () => {
    const args = { chat, ...file('retry.png', PNG, 'image/png') };
    const got = await Promise.all(Array.from({ length: 4 }, () => tool(ana.mcp, 'upload_chat_attachment', args).then(good)));
    expect(new Set(got.map(x => x.attachment.id)).size).toBe(1);
    pendingId = got[0].attachment.id;
    expect((await pool.query('SELECT count(*)::int AS n FROM attachments WHERE conversation_id=$1 AND owner_id=$2 AND name=$3', [chat, ana.id, 'retry.png'])).rows[0].n).toBe(1);
    bad(await tool(ana.mcp, 'upload_chat_attachment', { ...args, name: 'changed.png' }), 'idempotency_mismatch');
    const self = await request('/api/v1/directs', ana.session, { userId: ana.id });
    bad(await tool(ana.mcp, 'upload_chat_attachment', { ...args, chat: self.json.id }), 'idempotency_mismatch');
    const log = await fetch(`${process.env.S3_ENDPOINT}/__log`).then(r => r.json()) as any[];
    expect(log.filter(x => x.method === 'PUT' && x.key.includes(got[0].attachment.id))).toHaveLength(1);
  });

  it('adds PNG and PDF to tasks without replacing concurrent attachments, then comments and changes status once', async () => {
    const args = { id: task, ...file('task.png', PNG, 'image/png') };
    const first = good(await tool(ana.mcp, 'upload_task_attachment', args));
    expect(first.taskId).toBe(task);
    expect(first.attachments.map((x: any) => x.id)).toContain(first.attachment.id);
    const [replay, pdf] = await Promise.all([
      tool(ana.mcp, 'upload_task_attachment', args).then(good),
      tool(ana.mcp, 'upload_task_attachment', { id: task, ...file('task.pdf', PDF, 'application/pdf') }).then(good),
    ]);
    expect(replay.attachment.id).toBe(first.attachment.id);
    const more = await Promise.all(['extra-a.png', 'extra-b.png'].map(name => tool(ana.mcp, 'upload_task_attachment', { id: task, ...file(name, PNG, 'image/png') }).then(good)));
    const comment = { id: task, text: `Comment with attachments ${run}`, idempotency_key: randomUUID() };
    const status = { id: task, status: 'in_progress', idempotency_key: randomUUID() };
    await Promise.all(Array.from({ length: 3 }, () => tool(ana.mcp, 'comment_task', comment).then(good)));
    await Promise.all(Array.from({ length: 3 }, () => tool(ana.mcp, 'update_task', status).then(good)));
    const read = good(await tool(beto.mcp, 'get_task', { id: task }));
    expect(read.task.status).toBe('in_progress');
    expect(read.task.attachments.map((x: any) => x.id).sort()).toEqual([first.attachment.id, pdf.attachment.id, ...more.map(x => x.attachment.id)].sort());
    expect(read.activity.filter((x: any) => x.text === comment.text)).toHaveLength(1);
    bad(await tool(ana.mcp, 'comment_task', { ...comment, text: 'different' }), 'idempotency_mismatch');
    bad(await tool(ana.mcp, 'update_task', { ...status, status: 'done' }), 'idempotency_mismatch');
    bad(await tool(outsider.mcp, 'get_task', { id: task }));
    bad(await tool(outsider.mcp, 'upload_task_attachment', { id: task, ...file('unauthorized.png', PNG, 'image/png') }));
    bad(await tool(outsider.mcp, 'comment_task', { id: task, text: 'no' }));
    bad(await tool(outsider.mcp, 'update_task', { id: task, status: 'done' }));
  });

  it('rejects invalid encodings/types, missing retry keys and insufficient scopes before writes', async () => {
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM attachments WHERE owner_id=$1', [ana.id])).rows[0].n;
    const before = await count();
    const base = { chat, ...file('bad.png', PNG, 'image/png') };
    for (const data_base64 of ['!!!', 'A===', 'data:image/png;base64,' + PNG.toString('base64')]) bad(await tool(ana.mcp, 'upload_chat_attachment', { ...base, data_base64 }));
    bad(await tool(ana.mcp, 'upload_chat_attachment', { ...base, data_base64: Buffer.from('not a PNG').toString('base64') }));
    bad(await tool(ana.mcp, 'upload_chat_attachment', { chat, ...file('fake.pdf', PNG, 'application/pdf') }));
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1);
    PNG.copy(oversized);
    bad(await tool(ana.mcp, 'upload_chat_attachment', { chat, ...file('too-large.png', oversized, 'image/png') }));
    const beforeMessages = (await pool.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1', [chat])).rows[0].n;
    bad(await tool(ana.mcp, 'send_message', { chat, attachment_ids: [pendingId] }));
    expect((await pool.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1', [chat])).rows[0].n).toBe(beforeMessages);
    const { idempotency_key: _ignored, ...withoutKey } = base;
    bad(await tool(ana.mcp, 'upload_chat_attachment', withoutKey));
    bad(await tool(outsider.mcp, 'upload_chat_attachment', { chat, ...file('private.png', PNG, 'image/png') }));
    const limited = (await request('/api/v1/me/mcp-tokens', ana.session, { name: 'read-only', scopes: ['chats:read', 'tasks:read'] })).json.token;
    const list = await rpc(limited, 'tools/list', {});
    expect(list.tools.map((x: any) => x.name)).not.toContain('upload_chat_attachment');
    expect(list.tools.map((x: any) => x.name)).not.toContain('upload_task_attachment');
    bad(await tool(limited, 'upload_chat_attachment', base), 'forbidden_scope');
    bad(await tool(limited, 'upload_task_attachment', { id: task, ...file('private.png', PNG, 'image/png') }), 'forbidden_scope');
    expect(await count()).toBe(before);
  });

  it('rolls back attachment and task changes if receipt persistence fails, then retries safely', async () => {
    const marker = `rollback-${run}.pdf`;
    const fn = `mcp_receipt_fail_${run}`;
    await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.response::text LIKE '%${marker}%' THEN RAISE EXCEPTION 'fixture receipt failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT OR UPDATE ON mcp_idempotency FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    const args = { id: task, ...file(marker, PDF, 'application/pdf') };
    try {
      bad(await tool(ana.mcp, 'upload_task_attachment', args));
      expect((await pool.query('SELECT count(*)::int AS n FROM attachments WHERE owner_id=$1 AND name=$2', [ana.id, marker])).rows[0].n).toBe(0);
    } finally { await pool.query(`DROP TRIGGER ${fn} ON mcp_idempotency`); await pool.query(`DROP FUNCTION ${fn}()`); }
    const ok = good(await tool(ana.mcp, 'upload_task_attachment', args));
    expect(good(await tool(ana.mcp, 'get_task', { id: task })).task.attachments.map((x: any) => x.id)).toContain(ok.attachment.id);
    expect((await pool.query('SELECT count(*)::int AS n FROM attachments WHERE owner_id=$1 AND name=$2', [ana.id, marker])).rows[0].n).toBe(1);
  });

  it('does not reveal the upload receipt after its file becomes view-once', async () => {
    const args = { chat, ...file('sealed.png', PNG, 'image/png') };
    const uploaded = good(await tool(ana.mcp, 'upload_chat_attachment', args));
    const sent = await request(`/api/v1/conversations/${chat}/messages`, ana.session, {
      clientMessageId: randomUUID(), body: '', attachmentIds: [uploaded.attachment.id], viewOnce: true,
    });
    expect(sent.status).toBe(201);
    bad(await tool(ana.mcp, 'upload_chat_attachment', args));
  });

  it('respects history restrictions both with a receipt and after its retention window', async () => {
    const args = { chat, ...file('old-history.png', PNG, 'image/png') };
    const uploaded = good(await tool(ana.mcp, 'upload_chat_attachment', args));
    const sendArgs = { chat, attachment_ids: [uploaded.attachment.id], idempotency_key: randomUUID() };
    const sent = good(await tool(ana.mcp, 'send_message', sendArgs));
    const previous = (await pool.query('SELECT history_from_seq FROM conversation_memberships WHERE conversation_id=$1 AND user_id=$2', [chat, ana.id])).rows[0].history_from_seq;
    try {
      await pool.query('UPDATE conversation_memberships SET history_from_seq=$3 WHERE conversation_id=$1 AND user_id=$2', [chat, ana.id, sent.message.seq]);
      bad(await tool(ana.mcp, 'upload_chat_attachment', args));
      bad(await tool(ana.mcp, 'send_message', sendArgs));
      // Simulate the existing24h receipt cleanup, preserving the durable product message.
      await pool.query('DELETE FROM mcp_idempotency WHERE key=$1', [`chaggu-v1:${sendArgs.idempotency_key}`]);
      bad(await tool(ana.mcp, 'send_message', sendArgs));
    } finally {
      await pool.query('UPDATE conversation_memberships SET history_from_seq=$3 WHERE conversation_id=$1 AND user_id=$2', [chat, ana.id, previous]);
    }
  });

  it('does not replay metadata after a chat upload is attached to a now-private task', async () => {
    const args = { chat, ...file('private-task.png', PNG, 'image/png') };
    const uploaded = good(await tool(ana.mcp, 'upload_chat_attachment', args));
    const created = await request(`/api/v1/conversations/${chat}/issues`, beto.session, { title: 'Restricted attachment fixture' });
    expect(created.status).toBe(200);
    const attach = await request(`/api/v1/issues/${created.json.id}`, ana.session, { attachmentIds: [uploaded.attachment.id] }, 'PATCH');
    expect(attach.status).toBe(200);
    const restrict = await request(`/api/v1/issues/${created.json.id}`, beto.session, { visibility: 'private', assigneeIds: [beto.id], viewerIds: [] }, 'PATCH');
    expect(restrict.status).toBe(200);
    bad(await tool(ana.mcp, 'upload_chat_attachment', args));
  });

  it('revalidates access before replaying a successful upload or task mutation', async () => {
    const args = { chat, ...file('before-removal.png', PNG, 'image/png') };
    good(await tool(ana.mcp, 'upload_chat_attachment', args));
    const comment = { id: task, text: 'Before membership removal', idempotency_key: randomUUID() };
    good(await tool(ana.mcp, 'comment_task', comment));
    await pool.query('UPDATE conversation_memberships SET removed_at=now() WHERE conversation_id=$1 AND user_id=$2', [chat, ana.id]);
    bad(await tool(ana.mcp, 'upload_chat_attachment', args));
    bad(await tool(ana.mcp, 'comment_task', comment));
    bad(await tool(ana.mcp, 'read_messages', { chat }));
  });
});
