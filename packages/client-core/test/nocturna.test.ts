/** Local core regressions, no authenticated network calls or private data. */
import {describe,expect,it,vi} from 'vitest';
import {TieComsClient,dndActive} from '../src/client.ts';
const options:any={apiOrigin:'http://127.0.0.1:1',storage:{get:async()=>null,set:async()=>{},remove:async()=>{}},secrets:{get:async()=>null,set:async()=>{},remove:async()=>{}},device:{deviceId:'fixture',name:'fixture',platform:'web'}};
describe('nocturna core',()=>{
  it('newer deliberate unread revision can decrease cursor; delayed older read cannot undo it',()=>{
    const c:any=new TieComsClient(options);c.state={...c.state,data:{me:{id:'fixture'},conversations:[{id:'chat',lastMessageSeq:10,lastReadSeq:10,readRevision:2,historyFromSeq:0,unread:0}]}};
    c.applyConfirmedRead('chat',6,3);expect(c.getState().data.conversations[0].unread).toBe(4);c.applyConfirmedRead('chat',10,2);expect(c.getState().data.conversations[0].lastReadSeq).toBe(6);expect(c.getState().data.conversations[0].readRevision).toBe(3);
  });
  it('legacy DND and effective silence remain compatible; expired state and busy do not suppress notices',()=>{
    expect(dndActive({data:{me:{dndUntil:new Date(Date.now()+60000).toISOString(),availability:{mode:'busy',silent:false}}}} as any)).toBe(true);
    expect(dndActive({data:{me:{availability:{mode:'focus',silent:true,until:new Date(Date.now()-1).toISOString()}}}} as any)).toBe(false);
    expect(dndActive({data:{me:{availability:{mode:'busy',silent:false}}}} as any)).toBe(false);
  });
  it('an ACK arriving after account transition cannot mutate the new account',async()=>{
    const c:any=new TieComsClient(options);c.state={...c.state,data:{me:{id:'old'},conversations:[{id:'chat',lastMessageSeq:10,lastReadSeq:0,historyFromSeq:0,unread:10}]}};
    let resolve:any;c.request=vi.fn(()=>new Promise(r=>resolve=r));c.markRead('chat',10);await new Promise(r=>setTimeout(r,450));c.sessionGeneration++;c.state={...c.state,data:{me:{id:'new'},conversations:[{id:'chat',lastMessageSeq:10,lastReadSeq:0,historyFromSeq:0,unread:10}]}};
    resolve({lastReadSeq:10,readRevision:1});await new Promise(r=>setTimeout(r,0));expect(c.state.data.me.id).toBe('new');expect(c.state.data.conversations[0].lastReadSeq).toBe(0);
  });
});
