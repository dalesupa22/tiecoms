import { expect, it } from 'vitest';
import { isTaskActivity } from './chat-activity.ts';
it('only separates system task events, never user messages that look like JSON', () => {
  expect(isTaskActivity({ kind: 'system', body: '{"k":"issue.created"}' })).toBe(true);
  expect(isTaskActivity({ kind: 'system', body: '{"k":"issue.comments"}' })).toBe(true);
  expect(isTaskActivity({ kind: 'text', body: '{"k":"issue.created"}' })).toBe(false);
  expect(isTaskActivity({ kind: 'system', body: '{"k":"group.created"}' })).toBe(false);
  expect(isTaskActivity({ kind: 'system', body: 'invalid' })).toBe(false);
});
