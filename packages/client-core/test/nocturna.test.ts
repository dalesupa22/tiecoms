/** Local core regressions, no authenticated network calls or private data. */
import {describe,expect,it,vi} from 'vitest';
import {TieComsClient,dndActive} from '../src/client.ts';
const options:any={apiOrigin:'http://127.0.0.1:1',storage:{get:async()=>null,set:async()=>{},remove:async()=>{}},secrets:{get:async()=>null,set:async()=>{},remove:async()=>{}},device:{deviceId:'fixture',name:'fixture',platform:'web'}};
describe('nocturna core',()=>{
  it('newer deliberate unread revision can decrease cursor; delayed older read cannot undo it',()=>{
    const c:any=new TieComsClient(options);c.state={...c.state,data:{me:{id:'fixture'},conversations:[{id:'chat',lastMessageSeq:10,lastReadSeq:10,readRevision:2,historyFromSeq:0,unread:0}]}};
    c.applyConfirmedRead('chat',6,3);expect(c.getState().data.conversations[0].unread).toBe(4);c.applyConfirmedRead('chat',10,2);expect(c.getState().data.conversations[0].lastReadSeq).toBe(6);expect(c.getState().data.conversations[0].readRevision).toBe(3);
  });
  it('an own-message canonical read event wins over a delayed preceding HTTP read ACK',()=>{
    const c:any=new TieComsClient(options);c.state={...c.state,data:{me:{id:'fixture'},conversations:[{id:'chat',lastMessageSeq:11,lastReadSeq:10,readRevision:4,historyFromSeq:0,unread:1}]}};
    c.applyConfirmedRead('chat',11,6);c.applyConfirmedRead('chat',10,5);
    expect(c.getState().data.conversations[0]).toMatchObject({lastReadSeq:11,readRevision:6,unread:0});
  });
  it('a held bootstrap cannot replace a newer socket unread revision or preserve revoked conversations',async()=>{
    const c:any=new TieComsClient(options);const chat={id:'chat',lastMessageSeq:12,lastReadSeq:12,readRevision:4,historyFromSeq:0,unread:0,unreadMentions:0};
    c.state={...c.state,data:{me:{id:'fixture',dndUntil:null},conversations:[chat,{...chat,id:'revoked'}]}};
    let resolve:any;c.request=vi.fn(()=>new Promise(r=>resolve=r));c.schedulePersist=()=>{};
    const boot=c.loadBootstrap();c.applyConfirmedRead('chat',7,5);
    resolve({me:{id:'fixture',dndUntil:null},conversations:[{...chat}]});await boot;
    expect(c.getState().data.conversations).toHaveLength(1);
    expect(c.getState().data.conversations[0]).toMatchObject({lastReadSeq:7,readRevision:5,unread:5});
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
  it('a distant jump preserves a contiguous history that can still page older',async()=>{
    const c:any=new TieComsClient(options);
    const message=(seq:number)=>({id:`m${seq}`,conversationId:'chat',seq,authorId:'u',body:String(seq),kind:'text'});
    c.state={...c.state,conversations:{chat:{messages:Array.from({length:50},(_,i)=>message(951+i)),loaded:true,loading:false,hasMore:true,lastEventSeq:1000}}};
    c.openConversation=async()=>{};
    c.request=vi.fn(async(path:string)=>{expect(path).not.toContain('/around');const q=new URL(path,'http://localhost').searchParams,before=+q.get('before')!,limit=+q.get('limit')!;const first=Math.max(1,before-limit);return {messages:Array.from({length:before-first},(_,i)=>message(first+i)),hasMore:first>1};});
    expect(await c.ensureMessage('chat',100)).toBe(true);
    const messages=c.state.conversations.chat.messages;
    expect(messages.at(-1).seq).toBe(1000);for(let i=1;i<messages.length;i++)expect(messages[i].seq).toBe(messages[i-1].seq+1);
    expect(c.request.mock.calls.length).toBeLessThanOrEqual(10);
    await c.loadOlder('chat');expect(c.state.conversations.chat.messages[0].seq).toBe(1);
  });
  it('a downloaded blob cannot cross an account transition during response streaming',async()=>{
    const c:any=new TieComsClient(options);let complete:any;let started:any;const reading=new Promise(r=>started=r);
    c.raw=async()=>({status:200,ok:true,blob:()=>{started();return new Promise(r=>complete=r);}});
    const result=c.fetchBlob('/api/v1/attachments/private');const rejected=expect(result).rejects.toMatchObject({code:'session_changed'});
    await reading;c.sessionGeneration++;complete(new Blob(['private bytes']));await rejected;
  });

});
