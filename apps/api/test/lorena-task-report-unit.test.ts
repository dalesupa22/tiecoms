import { describe, expect, it } from 'vitest';
import type { IssueDTO } from '@tiecoms/contracts';
import { normalizeAssignees } from '../src/modules/issue-assignees.ts';
import { assignedTo, buildTaskReport, csvCell, mergeTaskSnapshot, taskReportCsv, taskReportHtml, taskStats } from '../../web/src/task-report.ts';
const task = (id: string, extra: Partial<IssueDTO> = {}) => ({ id, title: id, status: 'open', ownerId: 'one', assigneeIds: ['one', 'two'], dueDate: '2026-10-01', statusSince: '2026-09-25T12:00:00Z', conversationId: 'chat', updatedAt: '2026-09-30T12:00:00Z', ...extra } as IssueDTO);
const options = { title: 'Informe <equipo>', scope: 'Todos', generatedAt: '30 septiembre 2026', today: '2026-09-30', lang: 'es' as const, personName: (id: string) => id, conversationName: () => 'Chat' };
describe('task model and exports', () => {
  it('deduplicates responsibility and preserves legacy owner clients', () => {
    expect(normalizeAssignees({ assigneeIds: ['a', 'b', 'a'] }, ['c'])).toEqual(['a', 'b']);
    expect(normalizeAssignees({ ownerId: 'd' }, ['a', 'b'])).toEqual(['d']);
    expect(normalizeAssignees({ ownerId: null }, ['a'])).toEqual([]);
    expect(assignedTo({ ownerId: 'a' }, 'a')).toBe(true);
    expect(assignedTo(task('task'), 'two')).toBe(true);
  });
  it('counts important/overdue only among active tasks, counts completed without requiring due dates', () => {
    expect(taskStats([task('past', { dueDate: '2026-09-29' }), task('done', { status: 'done', dueDate: null }), task('cancelled', { status: 'cancelled' }), task('today', { dueDate: '2026-09-30', statusSince: '2026-09-30T12:00:00Z' })], '2026-09-30')).toMatchObject({ total: 4, pending: 2, completed: 1, important: 1, overdue: 1, today: 1 });
  });
  it('exports secondary assignment, children and completed tasks regardless of a page filter', () => {
    const r = buildTaskReport([task('parent'), task('child', { parentIssueId: 'parent', status: 'done' }), task('other', { assigneeIds: ['three'], ownerId: 'three' }), task('unassigned', { assigneeIds: [], ownerId: null })], { ...options, userId: 'two' });
    expect(r.rows).toHaveLength(2); expect(r.rows[1]!.parent).toBe('parent'); expect(r.rows[0]!.responsible).toBe('one, two'); expect(r.stats.completed).toBe(1);
  });
  it('escapes print HTML and neutralizes spreadsheet formulas without losing quoted content', () => {
    const r = buildTaskReport([task('one', { title: '<script>alert("X")</script>\n=HYPERLINK("evil")' })], options);
    expect(taskReportHtml(r)).not.toContain('<script>'); expect(taskReportHtml(r)).toContain('&lt;script&gt;'); expect(taskReportHtml(r)).toContain('@page{size:A4 landscape');
    expect(csvCell('=HYPERLINK("evil")')).toBe('"\'=HYPERLINK(""evil"")"');
    expect(taskReportCsv(r)).toContain('Responsables'); expect(taskReportCsv(r)).toContain('one, two'); expect(taskReportCsv(r).startsWith('\ufeff')).toBe(true);
  });


  it('keeps exact Today totals beyond 500 while applying live completion and lost access', () => {
    const complete = Array.from({ length: 501 }, (_, n) => task(`task-${n}`, { statusSince: '2026-09-30T12:00:00Z' }));
    const live = Object.fromEntries(complete.slice(0, 500).map((i) => [i.id, i]));
    live['task-0'] = task('task-0', { status: 'done', updatedAt: '2026-10-01T12:00:00Z' });
    const merged = mergeTaskSnapshot(complete, live, new Set(['task-1']));
    expect(taskStats(merged.filter((i) => assignedTo(i, 'two')), '2026-09-30')).toMatchObject({ total: 500, completed: 1, pending: 499 });
    expect(mergeTaskSnapshot(complete, {}, new Set())).toHaveLength(501);
  });

});
