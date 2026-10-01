import { describe, expect, it, vi } from 'vitest';
import type { IssueDTO } from '@tiecoms/contracts';
import { TieComsClient } from '../../../packages/client-core/src/client.ts';
describe('task move counts', () => {
  it('recounts the old and destination chats when a persisted task moves', async () => {
    const client = new TieComsClient({} as any);
    const source = { id: 'move', conversationId: 'from', status: 'open' } as IssueDTO;
    (client as any).state = { ...client.getState(), data: { me: { id: 'one' }, conversations: [{ id: 'from', openIssues: 1 }, { id: 'to', openIssues: 0 }] }, issues: { move: source } };
    vi.spyOn(client as any, 'request').mockResolvedValue({ ...source, conversationId: 'to' });
    vi.spyOn(client as any, 'schedulePersist').mockImplementation(() => {});
    await client.updateIssue('move', { conversationId: 'to' });
    expect(client.getState().data!.conversations.map((c) => c.openIssues)).toEqual([0, 1]);
  });
  it('loads complete report IDs into live state without overwriting a newer task event', async () => {
    const client = new TieComsClient({} as any);
    (client as any).state = { ...client.getState(), data: { me: { id: 'one' }, conversations: [] } };
    vi.spyOn(client as any, 'schedulePersist').mockImplementation(() => {});
    let resolve!: (value: unknown) => void;
    vi.spyOn(client, 'request').mockImplementation(() => new Promise((r) => { resolve = r; }));
    const report = client.issueReport();
    const old = { id: 'race', conversationId: 'chat', status: 'open', updatedAt: '2026-09-30T12:00:00Z' } as IssueDTO;
    const current = { ...old, status: 'done', updatedAt: '2026-09-30T13:00:00Z' };
    (client as any).onAccountEvent({ type: 'issue.updated', issue: current });
    const many = Array.from({ length: 501 }, (_, n) => ({ ...old, id: `task-${n}` }));
    resolve({ issues: [old, ...many] });
    expect((await report)[0]!.status).toBe('done');
    expect(Object.keys(client.getState().issues)).toHaveLength(502);
    expect(client.getState().issues.race!.status).toBe('done');
  });
  it('does not reintroduce a task revoked while the full report was loading, even if previously uncached', async () => {
    const client = new TieComsClient({} as any);
    (client as any).state = { ...client.getState(), data: { me: { id: 'one' }, conversations: [] } };
    vi.spyOn(client as any, 'schedulePersist').mockImplementation(() => {});
    let resolve!: (value: unknown) => void;
    vi.spyOn(client, 'request').mockImplementation(() => new Promise((r) => { resolve = r; }));
    const report = client.issueReport();
    (client as any).onAccountEvent({ type: 'issue.hidden', issueId: 'uncached', conversationId: 'chat' });
    resolve({ issues: [{ id: 'uncached', conversationId: 'chat', updatedAt: '2026-09-30T12:00:00Z' }] });
    expect(await report).toEqual([]); expect(client.getState().issues.uncached).toBeUndefined();
  });

});
