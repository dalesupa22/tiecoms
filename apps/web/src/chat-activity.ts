/** Task lifecycle notices belong to activity, separate from the message feed. */
export function isTaskActivity(m: { kind: string; body: string }) {
  if (m.kind !== 'system') return false;
  try { const key = JSON.parse(m.body)?.k; return typeof key === 'string' && key.startsWith('issue.'); } catch { return false; }
}
