import { describe, expect, it } from 'vitest';
import { communityGroups, communityPosts, suggestedCommunity } from './community.ts';
describe('community audience and feed', () => {
  it('never turns direct messages into community groups', () => {
    const c = [{ id: 'd', name: 'Comunidad', kind: 'direct' }, { id: 'g', name: 'Novedades', kind: 'group' }] as any;
    expect(communityGroups(c).map((x) => x.id)).toEqual(['g']); expect(suggestedCommunity(c)).toBe('g');
  });
  it('excludes deleted, system and view-once content and orders newest first', () => {
    const rows = [{ seq: 1, kind: 'text' }, { seq: 2, kind: 'system' }, { seq: 3, kind: 'text', viewOnce: true }, { seq: 4, kind: 'text', deletedAt: 'today' }, { seq: 5, kind: 'text' }] as any;
    expect(communityPosts(rows).map((m) => m.seq)).toEqual([5, 1]);
  });
});
