import { describe, expect, it, vi } from 'vitest';
import { IssuePageQuery, issuePage } from '../src/modules/issue-pagination.ts';

describe('opt-in issue pagination', () => {
  it('keeps old clients unpaginated and parses bounded page parameters', () => {
    expect(IssuePageQuery.parse({ mine: '1' })).toEqual({});
    expect(IssuePageQuery.parse({ limit: '200', offset: '400' })).toEqual({ limit: 200, offset: 400 });
    for (const query of [{ limit: '0' }, { limit: '201' }, { limit: '-1' }, { limit: '1.5' }, { limit: 'NaN' }, { limit: '2', offset: '-1' }, { limit: '2', offset: '9007199254740992' }, { offset: '0' }]) {
      expect(IssuePageQuery.safeParse(query).success).toBe(false);
    }
  });
  it('walks past 500 without duplicates and stops on exact or short final pages', () => {
    const tasks = Array.from({ length: 601 }, (_, id) => ({ id }));
    const result: typeof tasks = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: { issues: typeof tasks; nextOffset: number | null } = issuePage(tasks.slice(offset, offset + 201), 200, offset);
      result.push(...page.issues); offset = page.nextOffset;
    }
    expect(result).toEqual(tasks);
    expect(issuePage(tasks.slice(0, 200), 200, 400).nextOffset).toBeNull();
    expect(issuePage([], 200, 800)).toEqual({ issues: [], nextOffset: null });
  });
  it('uses identical access and legacy filter predicates on every page', async () => {
    const { listIssues, listIssuesPage } = await import('../src/modules/issues.ts');
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const db = { query } as any;
    const filter = { workspaceId: 'space', conversationId: 'chat', mine: true, open: true, personal: false };
    await listIssues('viewer', filter, db);
    await listIssuesPage('viewer', filter, { limit: 200, offset: 400 }, db);
    expect(query.mock.calls[0]![0]).toBe(query.mock.calls[1]![0]);
    expect(query.mock.calls[0]![1]).toEqual(['viewer', 'space', 'chat', true, true, false, 500, 0]);
    expect(query.mock.calls[1]![1]).toEqual(['viewer', 'space', 'chat', true, true, false, 201, 400]);
    const sql = query.mock.calls[1]![0] as string;
    expect(sql).toContain('vcm.removed_at IS NULL');
    expect(sql).toContain('vwm.revoked_at IS NULL');
    expect(sql).toContain('vwm.expires_at > now()');
    expect(sql).toContain('vv.user_id = $1');
    expect(sql).toContain('i.conversation_id IS NULL AND i.created_by = $1');
    expect(sql).toContain('i.created_at DESC, i.id');
  });
});
