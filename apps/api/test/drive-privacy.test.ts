/** Isolated ACL regression tests: no database, object storage, or outbound network. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateFolderInput, UploadFileQuery } from '@tiecoms/contracts';

const m = vi.hoisted(() => ({ query: vi.fn(), workspace: vi.fn(), conversation: vi.fn(), put: vi.fn(), sign: vi.fn(), event: vi.fn() }));
vi.mock('../src/db.ts', () => ({ pool: { query: m.query }, tx: async (fn: any) => fn({ query: m.query }), enqueueOutbox: m.event }));
vi.mock('../src/access.ts', () => ({ workspaceAccess: m.workspace, conversationAccess: m.conversation }));
vi.mock('../src/storage.ts', () => ({ objectKey: (s: string) => s, putObject: m.put, presignDownload: m.sign }));
import { deleteFolder, downloadLink, tree, updateFile, uploadFile } from '../src/modules/drive.ts';

const file = (extra: object = {}) => ({ id: 'file', owner_id: 'owner', purpose: 'document', workspace_id: 'space', conversation_id: null,
  visibility: 'shared', folder_id: null, s3_key: 'test-only', content_type: 'text/plain', name: 'test.txt', size_bytes: 4,
  created_at: new Date(), updated_at: new Date(), ...extra });
function setFile(extra: object = {}) {
  m.query.mockImplementation(async (sql: string) => sql.startsWith('SELECT * FROM files WHERE id') ? { rows: [file(extra)] } : { rows: [], rowCount: 0 });
}

beforeEach(() => {
  vi.resetAllMocks();
  m.query.mockResolvedValue({ rows: [], rowCount: 0 });
  m.workspace.mockResolvedValue({ role: 'admin' });
  m.conversation.mockResolvedValue({ canManage: true, canPost: true });
  m.sign.mockResolvedValue('https://files.example.test/local');
});

describe('per-file privacy and conversation audiences', () => {
  it('never signs another person’s private file, even for a workspace admin', async () => {
    setFile({ visibility: 'private' });
    await expect(downloadLink('admin', 'file')).rejects.toMatchObject({ status: 404 });
    expect(m.workspace).not.toHaveBeenCalled(); expect(m.sign).not.toHaveBeenCalled();
  });
  it('requires active workspace membership before signing shared bytes', async () => {
    setFile();
    m.workspace.mockRejectedValue(new Error('Membership revoked'));
    await expect(downloadLink('outsider', 'file')).rejects.toMatchObject({ status: 404 });
    expect(m.sign).not.toHaveBeenCalled();
  });
  it('signs a shared DM file only after checking that exact conversation', async () => {
    setFile({ workspace_id: null, conversation_id: 'dm' });
    expect(await downloadLink('peer', 'file')).toMatchObject({ expiresIn: 300 });
    expect(m.conversation).toHaveBeenCalledWith(expect.anything(), 'peer', 'dm', 'read');
    expect(m.workspace).not.toHaveBeenCalled(); expect(m.sign).toHaveBeenCalledOnce();
  });
  it('excludes private rows from shared tree SQL and separates personal trees from DMs', async () => {
    await tree('peer', null, 'dm');
    const [query, params] = m.query.mock.calls.find(([sql]) => sql.includes('FROM files f'))!;
    expect(query).toContain('f.conversation_id = $1');
    expect(query).toContain("f.visibility = 'shared' OR f.owner_id = $2");
    expect(params).toEqual(['dm', 'peer']);
    m.query.mockClear();
    await tree('owner', null);
    expect(m.query.mock.calls.find(([sql]) => sql.includes('FROM files f'))![0]).toContain('f.conversation_id IS NULL');
  });
  it('does not grant file audience access through message supervision', async () => {
    m.conversation.mockResolvedValueOnce({ oversight: true, canPost: false, canManage: false });
    await expect(tree('supervisor', null, 'dm')).rejects.toMatchObject({ status: 404 });
    expect(m.query).not.toHaveBeenCalled();
  });
  it('does not let an admin change another uploader’s visibility', async () => {
    setFile();
    await expect(updateFile('admin', 'file', { visibility: 'private' })).rejects.toMatchObject({ status: 403 });
    expect(m.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
  it('rejects personal sharing without an explicit group/chat audience', async () => {
    setFile({ workspace_id: null, visibility: 'private' });
    await expect(updateFile('owner', 'file', { visibility: 'shared' })).rejects.toMatchObject({ status: 400 });
  });
  it('rechecks membership after object upload and before storing metadata', async () => {
    m.conversation.mockResolvedValueOnce({ canPost: true, canManage: false }).mockRejectedValueOnce(new Error('Removed while uploading'));
    await expect(uploadFile('owner', { workspaceId: null, conversationId: 'dm', folderId: null, name: 'test.txt', contentType: 'text/plain', body: Buffer.from('test') })).rejects.toThrow('Removed while uploading');
    expect(m.put).toHaveBeenCalledOnce();
    expect(m.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO files'))).toBe(false);
  });
  it('protects other people’s private files when deleting an ancestor folder', async () => {
    m.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM folders')) return { rows: [{ id: 'folder', workspace_id: 'space', conversation_id: null, created_by: 'admin' }] };
      if (sql.startsWith('WITH RECURSIVE down')) return { rows: [{ id: 'folder' }] };
      if (sql.startsWith('SELECT id, owner_id, visibility FROM files')) return { rows: [{ id: 'private', owner_id: 'owner', visibility: 'private' }] };
      return { rows: [], rowCount: 0 };
    });
    await expect(deleteFolder('admin', 'folder')).rejects.toMatchObject({ status: 403 });
    expect(m.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
  it('rejects conflicting workspace/conversation upload and folder scopes', () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111', conversationId = '22222222-2222-4222-8222-222222222222';
    expect(CreateFolderInput.safeParse({ workspaceId, conversationId, name: 'Folder' }).success).toBe(false);
    expect(UploadFileQuery.safeParse({ workspaceId, conversationId, name: 'file.txt' }).success).toBe(false);
  });
});
