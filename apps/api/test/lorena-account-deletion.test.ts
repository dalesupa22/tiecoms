/** Account deletion regression against the explicitly isolated local API and database. No worker required. */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3094';
const apiUrl = new URL(API);
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Account regression requires the isolated local DATABASE_URL');
const databaseUrl = new URL(connectionString);
const local = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
if (apiUrl.protocol !== 'http:' || !local(apiUrl.hostname) || apiUrl.port !== '3094') throw new Error('Account regression requires the dedicated local API on port 3094');
if (!local(databaseUrl.hostname) || databaseUrl.port !== '55434' || decodeURIComponent(databaseUrl.pathname) !== '/chaggu_lorena_test') throw new Error('Account regression requires localhost:55434/chaggu_lorena_test');

const db = new pg.Pool({ connectionString, ssl: false, max: 1 });
const run = randomUUID().slice(0, 8);
const PASSWORD = 'local-account-delete-test-2026';
type Actor = { id: string; token: string; email: string; orgId: string };
async function call(path: string, actor?: Actor, body?: unknown, method?: string) {
  const response = await fetch(`${API}/api/v1${path}`, { method: method ?? (body ? 'POST' : 'GET'),
    headers: { ...(actor ? { authorization: `Bearer ${actor.token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: await response.json() as any };
}
async function signup(name: string, invitation?: string): Promise<Actor> {
  const email = `${name.toLowerCase()}.delete.${run}@example.com`;
  const response = await call('/auth/signup', undefined, { name, email, password: PASSWORD, ...(invitation ? { orgInviteToken: invitation } : { orgName: `Deletion ${run}` }), device: { deviceId: randomUUID(), name: 'account deletion regression', platform: 'web' } });
  expect(response.status).toBe(200);
  return { id: response.json.user.id, token: response.json.accessToken, orgId: response.json.user.primaryOrgId, email };
}
async function upload(actor: Actor, name: string, scope: Record<string, string>) {
  const content = `Fixture ${run}: ${name}`;
  const response = await fetch(`${API}/api/v1/drive/files?${new URLSearchParams({ name, ...scope })}`, { method: 'POST', headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/octet-stream', 'x-file-type': 'text/plain' }, body: new TextEncoder().encode(content) });
  const file = await response.json() as any;
  expect(response.status).toBe(200);
  return { id: file.id as string, name, content };
}

beforeAll(async () => {
  expect((await db.query('SELECT current_database() AS name')).rows[0].name).toBe('chaggu_lorena_test');
});
afterAll(async () => { await db.end(); });

describe('deleting an account clears private Lorena data and retains shared records', () => {
  it('anonymizes new profile fields, deletes private notes/preferences and all private file scopes, while preserving shared group/DM/workspace documents', async () => {
    const owner = await signup('Owner');
    const invite = await call(`/organizations/${owner.orgId}/invitations`, owner, { email: `peer.delete.${run}@example.com`, role: 'member' });
    expect(invite.status).toBe(200);
    const peer = await signup('Peer', invite.json.token);
    // Ensure the HTTP fixtures really belong to the guarded local database before testing deletion.
    expect((await db.query('SELECT email FROM users WHERE id=$1', [owner.id])).rows[0].email).toBe(owner.email);
    const workspace = await call('/workspaces', owner, { name: `Workspace ${run}` });
    expect(workspace.status).toBe(200);
    const workspaceInvite = await call(`/workspaces/${workspace.json.id}/invitations`, owner, { role: 'member', conversationIds: [workspace.json.generalConversationId] });
    expect(workspaceInvite.status).toBe(200);
    expect((await call(`/invitations/${workspaceInvite.json.token}/accept`, peer, {})).status).toBe(200);
    const group = await call('/chats', owner, { name: `Shared group ${run}`, userIds: [peer.id] });
    const direct = await call('/directs', owner, { userId: peer.id });
    expect(group.status).toBe(200); expect(direct.status).toBe(200);
    const groupId = group.json.id as string, directId = direct.json.id as string, workspaceId = workspace.json.id as string;

    const privateFiles = [
      await upload(owner, 'personal-private.txt', {}),
      await upload(owner, 'workspace-private.txt', { workspaceId, visibility: 'private' }),
      await upload(owner, 'group-private.txt', { conversationId: groupId, visibility: 'private' }),
      await upload(owner, 'direct-private.txt', { conversationId: directId, visibility: 'private' }),
    ];
    const sharedFiles = [
      await upload(owner, 'workspace-shared.txt', { workspaceId, visibility: 'shared' }),
      await upload(owner, 'group-shared.txt', { conversationId: groupId, visibility: 'shared' }),
      await upload(owner, 'direct-shared.txt', { conversationId: directId, visibility: 'shared' }),
    ];
    const profile = { phone: '+57 300 987 6543', company: `Private profile ${run}`, bio: 'Remove this personal biography with the account' };
    expect((await call('/me', owner, profile, 'PATCH')).status).toBe(200);
    expect((await call('/notes', owner, { title: 'Delete my private note', body: 'Private history', tags: [{ kind: 'conversation', id: groupId, label: 'Shared group' }], fileIds: [privateFiles[0]!.id], links: ['https://example.com/note'] })).status).toBe(200);
    const sectionId = randomUUID();
    expect((await call('/me/personal-preferences', owner, { sections: [{ id: sectionId, name: 'Delete section' }], conversations: { [groupId]: { favorite: true, archived: true, sectionId, background: 'mint', font: 'serif' } }, appearance: { mode: 'dark', accent: '#0a7c87' } }, 'PUT')).status).toBe(200);
    expect((await db.query('SELECT count(*)::int AS n FROM personal_notes WHERE owner_id=$1', [owner.id])).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM user_personal_preferences WHERE user_id=$1', [owner.id])).rows[0].n).toBe(1);

    for (const file of privateFiles) expect((await call(`/drive/files/${file.id}/link`, peer)).status).toBe(404);
    const deletion = await call('/account', owner, { confirmEmail: owner.email, password: PASSWORD }, 'DELETE');
    expect(deletion.status).toBe(200);
    expect((await call('/notes', owner)).status).toBe(401);
    expect((await call('/me/personal-preferences', owner)).status).toBe(401);
    const account = (await db.query('SELECT name,email,password_hash,primary_org_id,profile_phone,profile_company,profile_bio,disabled_at FROM users WHERE id=$1', [owner.id])).rows[0];
    expect(account).toMatchObject({ name: 'Cuenta eliminada', email: `deleted+${owner.id}@deleted.tiecoms.invalid`, password_hash: null, primary_org_id: null, profile_phone: null, profile_company: null, profile_bio: null });
    expect(account.disabled_at).not.toBeNull();
    expect((await db.query('SELECT count(*)::int AS n FROM personal_notes WHERE owner_id=$1', [owner.id])).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM user_personal_preferences WHERE user_id=$1', [owner.id])).rows[0].n).toBe(0);

    const rows = (await db.query('SELECT id,name,deleted_at FROM files WHERE id=ANY($1)', [[...privateFiles, ...sharedFiles].map((file) => file.id)])).rows;
    const jobs = (await db.query("SELECT payload FROM jobs WHERE kind='account.delete_file' AND payload->>'fileId'=ANY($1)", [[...privateFiles, ...sharedFiles].map((file) => file.id)])).rows;
    for (const file of privateFiles) {
      expect(rows.find((row) => row.id === file.id)).toMatchObject({ name: null });
      expect(rows.find((row) => row.id === file.id)?.deleted_at).not.toBeNull();
      expect(jobs.some((job) => job.payload.fileId === file.id)).toBe(true);
      expect((await call(`/drive/files/${file.id}/link`, peer)).status).toBe(404);
    }
    for (const file of sharedFiles) {
      expect(rows.find((row) => row.id === file.id)).toMatchObject({ name: file.name, deleted_at: null });
      expect(jobs.some((job) => job.payload.fileId === file.id)).toBe(false);
      const download = await call(`/drive/files/${file.id}/link`, peer);
      expect(download.status).toBe(200);
      if (!local(new URL(download.json.url).hostname)) throw new Error('Shared fixture download must use local fake storage');
      const bytes = await fetch(download.json.url);
      expect(bytes.status).toBe(200); expect(await bytes.text()).toBe(file.content);
    }
    expect((await call('/bootstrap', peer)).json.people.some((person: any) => person.id === owner.id)).toBe(false);
    expect((await call('/drive/tree', peer)).json.files).toEqual([]);
  }, 30_000);
});
