import { describe, expect, it } from 'vitest';
import type { WaChatDTO } from '@tiecoms/contracts';
import { sortWaChats } from '../src/wa-chat-order.ts';
const chat = (jid: string, date: string | null, pinned = false, accountId = 'personal') => ({ jid, accountId, lastMessageAt: date, pinned }) as WaChatDTO;
describe('WhatsApp visible recent ordering', () => {
  it('places only explicit pins before newer conversations, then compares actual timestamps', () => {
    const list = [chat('old','2026-10-01T21:00:00-05:00'), chat('new','2026-10-02T04:10:00Z'), chat('pin','2026-09-30T12:00:00Z',true)];
    expect(sortWaChats(list).map(c => c.jid)).toEqual(['pin','new','old']);
    expect(list[0]!.jid).toBe('old');
    expect(sortWaChats(list.map(c => ({...c,pinned:false}))).map(c => c.jid)).toEqual(['new','old','pin']);
  });
  it('orders null/invalid dates last and identity ties consistently across accounts', () => {
    expect(sortWaChats([chat('same',null,false,'b'),chat('z','invalid'),chat('same',null,false,'a'),chat('now','2026-10-02T04:00:00Z')]).map(c=>`${c.accountId}:${c.jid}`)).toEqual(['personal:now','a:same','b:same','personal:z']);
  });
});
