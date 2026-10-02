/** Synthetic fixtures only; never contacts a WhatsApp account or a production DB. */
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {privacyAppState,PRIVACY_COLLECTIONS} from '../src/modules/wa-privacy-hydration.ts';
import {privacyExceptionDetails,privacyWarningDetails} from '../src/modules/wa-privacy-diagnostics.ts';

describe('privacy app-state reconstruction',()=>{
  it('diagnostics expose only fixed labels and bounded counters, never key IDs or provider strings',()=>{
    const secret='synthetic-private-key-and-jid';
    const warning=privacyWarningDetails([{name:'regular',attempt:2,errorType:'Boom',statusCode:404,error:`Error: failed to find key "${secret}" to decode mutation`},'regular blocked on missing key']);
    expect(warning).toEqual({collection:'regular',reason:'missing_app_state_key',attempt:2,errorType:'Boom',statusCode:404});
    expect(JSON.stringify(warning)).not.toContain(secret);
    expect(privacyWarningDetails([{name:secret,errorType:secret,attempt:999999,statusCode:999999,error:secret},secret])).toEqual({collection:null,reason:'unclassified',attempt:null,errorType:null,statusCode:null});
    expect(privacyExceptionDetails({message:secret,name:secret,code:secret})).toEqual({reason:'unclassified',errorType:null,errorCode:null,statusCode:null});
    expect(privacyExceptionDetails({message:secret,name:'error',code:'40001'})).toMatchObject({errorCode:'40001'});
  });
  it('diagnostics distinguish final warning before a complete receipt while retaining fail-closed behavior',()=>{
    const state=privacyAppState({get:async()=>({}),set:async()=>{}});
    state.recordFailure();state.acceptReceipt({completedCollections:[...PRIVACY_COLLECTIONS],failedCollections:[]});
    expect(state.complete()).toBe(false);
    expect(state.diagnostics()).toEqual({failureLatched:true,receiptReceived:true,completedCollections:[...PRIVACY_COLLECTIONS],failedCollections:[],missingCollections:[]});
    const partial=privacyAppState({get:async()=>({}),set:async()=>{}});
    partial.acceptReceipt({completedCollections:['regular','synthetic-private-key'],failedCollections:['critical_block','synthetic-private-key']});
    expect(partial.diagnostics()).toMatchObject({completedCollections:['regular'],failedCollections:['critical_block']});
    expect(JSON.stringify(partial.diagnostics())).not.toContain('synthetic-private-key');
    expect(partial.complete()).toBe(false);
  });
  it('shadows derived versions only, preserving credentials and encryption keys on failure',async()=>{
    const writes:any[]=[];const base={get:async(type:string)=>({saved:{type}}),set:async(data:any)=>{writes.push(data);}};
    const state=privacyAppState(base);
    expect(await state.keys.get('app-state-sync-version',['saved'])).toEqual({});
    expect(await state.keys.get('app-state-sync-key',['saved'])).toEqual({saved:{type:'app-state-sync-key'}});
    await state.keys.set({'app-state-sync-version':{regular:{version:2}},session:{s:{fixture:true}}});
    expect(writes).toEqual([{session:{s:{fixture:true}}}]);
    await expect(state.commit()).rejects.toThrow('incompleto');
    expect(writes).toHaveLength(1);
  });
  it('never attests a partial or silently failed resync; commits a complete reconstruction once',async()=>{
    const writes:any[]=[];const state=privacyAppState({get:async()=>({}),set:async(d:any)=>{writes.push(d);}});
    for(const name of PRIVACY_COLLECTIONS) await state.keys.set({'app-state-sync-version':{[name]:{version:1}}});
    expect(state.complete()).toBe(false);
    state.acceptReceipt({completedCollections:[...PRIVACY_COLLECTIONS],failedCollections:[]});
    expect(state.complete()).toBe(true);await state.commit();expect(writes).toHaveLength(1);
    const failed=privacyAppState({get:async()=>({}),set:async()=>{throw new Error('must not persist');}});
    for(const name of PRIVACY_COLLECTIONS) await failed.keys.set({'app-state-sync-version':{[name]:{version:1}}});
    failed.acceptReceipt({completedCollections:[...PRIVACY_COLLECTIONS],failedCollections:[]});
    failed.recordFailure();expect(failed.complete()).toBe(false);await expect(failed.commit()).rejects.toThrow('incompleto');
  });
  it('attests valid empty collections and rejects void or a swallowed provider failure',async()=>{
    const writes:any[]=[];const state=privacyAppState({get:async()=>({}),set:async(d:any)=>{writes.push(d);}});
    state.acceptReceipt({completedCollections:[...PRIVACY_COLLECTIONS],failedCollections:[]});
    expect(state.complete()).toBe(true);await state.commit();
    expect(Object.values(writes[0]['app-state-sync-version'])).toEqual(PRIVACY_COLLECTIONS.map(()=>null));
    for(const receipt of [undefined,{completedCollections:[...PRIVACY_COLLECTIONS],failedCollections:['regular']}]) {
      const bad=privacyAppState({get:async()=>({}),set:async()=>{}});bad.acceptReceipt(receipt);expect(bad.complete()).toBe(false);
    }
  });
  it('uses saved versions for subsequent delta sync without touching them before receipt',async()=>{
    const writes:any[]=[];const saved={version:9};const state=privacyAppState({get:async()=>({regular:saved}),set:async(d:any)=>{writes.push(d);}},false);
    expect(await state.keys.get('app-state-sync-version',['regular'])).toEqual({regular:saved});
    await state.keys.set({'app-state-sync-version':{regular:{version:10}}});expect(writes).toEqual([]);
  });
  it('keeps live versions ephemeral and freezes the durable checkpoint before asynchronous lock writes',async()=>{
    const writes:any[]=[];const state=privacyAppState({get:async()=>({}),set:async(d:any)=>{writes.push(d);}});
    await state.keys.set({'app-state-sync-version':{regular:{version:1}}});
    state.acceptReceipt({completedCollections:[...PRIVACY_COLLECTIONS],failedCollections:[]});
    await state.keys.set({'app-state-sync-version':{regular:{version:2}}});
    await state.commit();expect(writes[0]['app-state-sync-version'].regular.version).toBe(1);
    await state.keys.set({'app-state-sync-version':{regular:{version:3}},session:{s:'fixture'}});
    expect(writes).toHaveLength(2);expect(writes[1]).toEqual({session:{s:'fixture'}});
    expect(await state.keys.get('app-state-sync-version',['regular'])).toEqual({regular:{version:3}});
  });
  it('installed Baileys decoder emits success for empty and failure for swallowed decode errors',async()=>{
    const path=createRequire(import.meta.url).resolve('baileys').replace(/index\.js$/,'Socket/chats.js');
    const source=readFileSync(path,'utf8');
    const start=source.indexOf('    const resyncAppState =');const end=source.indexOf('    /**',start);
    const section=source.slice(start,end);
    const decoder=(fail:boolean)=>new Function('env',`with(env) { ${section}; return resyncAppState; }`)({
      ev:{createBufferedFunction:(fn:any)=>fn},authState:{keys:{transaction:async(fn:any)=>fn(),get:async()=>({}),set:async()=>{}},creds:{}},
      getAppStateSyncKey:async()=>null,newLTHashState:()=>({version:0}),query:async()=>({}),S_WHATSAPP_NET:'fixture',
      extractSyncdPatches:async()=>Object.fromEntries(PRIVACY_COLLECTIONS.map(name=>[name,{patches:[],hasMorePatches:false,...(fail?{snapshot:{}}:{})}])),
      decodeSyncdSnapshot:async()=>{throw new Error('synthetic decode failure');},appStateMacVerification:{snapshot:true},
      logger:{info(){},warn(){}},isMissingKeyError:()=>false,isAppStateSyncIrrecoverable:()=>true,blockedCollections:new Set(),config:{},
      newAppStateChunkHandler:()=>({onMutation(){}}),
    });
    expect(await decoder(false)([...PRIVACY_COLLECTIONS],false)).toEqual({completedCollections:[...PRIVACY_COLLECTIONS],failedCollections:[]});
    expect(await decoder(true)([...PRIVACY_COLLECTIONS],false)).toEqual({completedCollections:[],failedCollections:[...PRIVACY_COLLECTIONS]});
  });
});

const dbUrl=process.env.DATABASE_URL;
describe.skipIf(!dbUrl)('Chat Lock SQL and API policy (isolated PostgreSQL)',()=>{
  let db:any,wa:any,sync:any,privacy:any,media:any,gg:any,mail:any;
  const user=randomUUID(),other=randomUUID(),account=randomUUID(),otherAccount=randomUUID();
  const plain='privacy-normal@g.us',secret='privacy-locked@g.us',pn='570001000001@s.whatsapp.net',lid='100001@lid';
  const session:any={id:account,userId:user,kind:'personal',pairPhone:null,sock:null,stopping:false,retries:0,registered:true,me:null,notifyTimer:null};
  beforeAll(async()=>{
    const url=new URL(dbUrl!);
    if(!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='55481'||!/^\/tiecoms_wa_privacy_[a-z0-9_]+$/.test(url.pathname)) throw new Error('Dedicated local privacy fixture database required');
    db=await import('../src/db.ts');await (await import('../src/migrate.ts')).migrate();
    [wa,sync,privacy,media,gg,mail]=await Promise.all([import('../src/modules/whatsapp.ts'),import('../src/modules/wa-sync.ts'),import('../src/modules/wa-privacy.ts'),import('../src/modules/wa-media.ts'),import('../src/modules/gg-side.ts'),import('../src/modules/mailbox.ts')]);
    await db.pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'privacy-fixture'),($3,$4,'other-fixture')",[user,user+'@example.com',other,other+'@example.com']);
    await db.pool.query("INSERT INTO wa_accounts(id,user_id,label,kind,status,send_enabled) VALUES($1,$2,'fixture','personal','connected',true),($3,$4,'other','personal','connected',true)",[account,user,otherAccount,other]);
    await sync.upsertChats(session,[{jid:plain,name:'normal fixture',isGroup:true},{jid:secret,name:'sensitive fixture',isGroup:true}]);
    await db.pool.query("UPDATE wa_chats SET inbox_place='groups',last_preview='sensitive fixture preview',unread=3 WHERE account_id=$1 AND jid=$2",[account,secret]);
    await db.pool.query("INSERT INTO wa_messages(account_id,chat_jid,id,body,sent_at) VALUES($1,$2,'fixture-message','sensitive fixture body',now())",[account,secret]);
  });
  afterAll(async()=>{if(session.notifyTimer) clearTimeout(session.notifyTimer);if(db) await db.pool.end();});
  it('existing accounts begin closed until privacy rehydration, including counts',async()=>{
    expect((await wa.listAccounts(user))[0]).toMatchObject({privacyReady:false,chats:0,groups:0});
    expect((await wa.listChats(user,{limit:100})).chats).toEqual([]);
    await expect(wa.ownChat(user,account,plain)).rejects.toMatchObject({status:404});
    await db.pool.query(`UPDATE wa_accounts SET privacy_synced_at=now(),lease_owner='fixture',lease_until=now()+interval '1 hour' WHERE id=ANY($1)`,[[account,otherAccount]]);
    expect((await wa.listChats(user,{limit:100})).chats).toHaveLength(2);
  });
  it('separates missing, false, archive and group admin lock',async()=>{
    expect(sync.chatFromWa({id:secret,locked:false}).locked).toBe(false);
    expect(sync.chatFromWa({id:secret}).locked).toBeNull();
    expect(sync.groupRow({id:plain,subject:'fixture',locked:true}).locked).toBeUndefined();
    await privacy.applyWaLocks(account,user,[{jid:secret,locked:true}]);
    await sync.upsertChats(session,[sync.chatFromWa({id:secret,archived:false}),sync.chatFromWa({id:secret,locked:false})]);
    expect((await db.pool.query('SELECT wa_locked FROM wa_chats WHERE account_id=$1 AND jid=$2',[account,secret])).rows[0].wa_locked).toBe(true);
  });
  it('excludes locked chats from list/search/hidden/categories/inbox/account counts',async()=>{
    const listed=await wa.listChats(user,{limit:100});expect(listed.chats.map((c:any)=>c.jid)).toEqual([plain]);
    expect(Object.values(listed.categories).reduce((n:number,c:any)=>n+c.total,0)).toBe(1);
    expect((await wa.listChats(user,{limit:100,search:'sensitive'})).chats).toEqual([]);
    expect((await wa.listChats(user,{limit:100,hidden:true})).chats).toEqual([]);
    expect(await wa.inboxChats(user)).toEqual([]);
    expect((await wa.listAccounts(user))[0]).toMatchObject({privacyReady:true,chats:1,groups:1});
  });
  it('denies direct messages, send, media, retry, GG history/context and sharing',async()=>{
    const denied=[()=>wa.ownChat(user,account,secret),()=>wa.listChatMessages(user,account,secret,undefined,50),()=>wa.sendToChat(user,account,secret,'fixture outgoing'),()=>media.ownMedia(user,account,secret,'fixture-message'),()=>media.retryWaMedia(user,account,secret,'fixture-message'),()=>wa.messagesForGg(account,secret,{}),()=>gg.thread(user,`wa:${account}:${secret}`),()=>mail.shareWhatsApp(user,{accountId:account,jid:secret,messageId:'fixture-message',conversationIds:[randomUUID()]})];
    for(const read of denied) await expect(read()).rejects.toMatchObject({status:404});
    await expect(wa.ownChat(other,account,plain)).rejects.toMatchObject({status:404});
    expect((await db.pool.query('SELECT id FROM wa_outbox WHERE account_id=$1',[account])).rowCount).toBe(0);
    await db.pool.query('INSERT INTO gg_side_state(user_id,source,pending_count) VALUES($1,$2,7)',[user,`wa:${account}:${secret}`]);
    expect(await gg.pendingCounts(user,`wa:${account}:${secret}`)).toEqual({[`wa:${account}:${secret}`]:0});
  });
  it('revokes both PN/LID aliases, quarantines unresolved locks and recovers unrelated chats after mapping',async()=>{
    await sync.upsertChats(session,[{jid:pn,name:'alias fixture',isGroup:false}]);
    await privacy.applyWaLocks(account,user,[{jid:lid,locked:true}]);
    expect((await wa.listAccounts(user))[0].privacyReady).toBe(false);
    expect((await wa.listChats(user,{limit:100})).chats).toEqual([]);
    await sync.storeAliases(session,[{lid,pn}]);
    expect((await wa.listAccounts(user))[0].privacyReady).toBe(true);
    for(const jid of [lid,pn]) await expect(wa.ownChat(user,account,jid)).rejects.toMatchObject({status:404});
    expect((await wa.listChats(user,{limit:100})).chats.map((c:any)=>c.jid)).toEqual([plain]);
    await privacy.applyWaLocks(account,user,[{jid:pn,locked:false}]);
    expect((await wa.ownChat(user,account,pn)).jid).toBe(pn);
    await expect(wa.ownChat(user,account,lid)).rejects.toMatchObject({status:404});
    expect((await wa.listChats(user,{limit:100})).chats.filter((c:any)=>[pn,lid].includes(c.jid)).map((c:any)=>c.jid)).toEqual([pn]);
    await sync.upsertChats(session,[sync.chatFromWa({id:lid,archived:false})],false);
    await expect(wa.ownChat(user,account,lid)).rejects.toMatchObject({status:404});
    await sync.upsertChats(session,[{jid:lid,name:'real history fixture',isGroup:false}]);
    expect((await wa.ownChat(user,account,lid)).jid).toBe(lid);
  });
  it.each(['snapshot','delta'])('latest explicit PN/LID action wins after a late mapping (%s)',async mode=>{
    const p=`late-${mode}@s.whatsapp.net`,l=`late-${mode}@lid`;
    await sync.upsertChats(session,[{jid:p,name:'late alias fixture',isGroup:false}]);
    await privacy.applyWaLocks(account,user,[{jid:p,locked:true}]);
    await privacy.applyWaLocks(account,user,[{jid:l,locked:false}]);
    await sync.storeAliases(session,[{lid:l,pn:p}]);
    if(mode==='snapshot') await privacy.finishWaPrivacy(account,user,()=>true,[secret,p]);
    expect((await wa.ownChat(user,account,p)).jid).toBe(p);
    const rows=(await db.pool.query('SELECT wa_locked,wa_lock_revision FROM wa_chats WHERE account_id=$1 AND jid=ANY($2)',[account,[p,l]])).rows;
    expect(rows.every((r:any)=>r.wa_locked===false && Number(r.wa_lock_revision)>0)).toBe(true);
    expect(rows[0].wa_lock_revision).toBe(rows[1].wa_lock_revision);
    // Stale history metadata and repeated alias discovery cannot reverse the explicit unlock.
    await sync.upsertChats(session,[sync.chatFromWa({id:p,locked:true})]);await sync.storeAliases(session,[{lid:l,pn:p}]);
    expect((await wa.ownChat(user,account,p)).jid).toBe(p);
    await privacy.applyWaLocks(account,user,[{jid:l,locked:true}]);
    for(const jid of [p,l]) await expect(wa.ownChat(user,account,jid)).rejects.toMatchObject({status:404});
    await privacy.applyWaLocks(account,user,[{jid:p,locked:false}]);
  });
  it('lock cancels queued sends, detaches inbox and emits only minimal removal events',async()=>{
    await privacy.applyWaLocks(account,user,[{jid:secret,locked:false}]);
    await db.pool.query("INSERT INTO wa_outbox(account_id,user_id,jid,body) VALUES($1,$2,$3,'sensitive fixture outgoing')",[account,user,secret]);
    await db.pool.query("UPDATE wa_chats SET inbox_place='groups' WHERE account_id=$1 AND jid=$2",[account,secret]);
    await privacy.applyWaLocks(account,user,[{jid:secret,locked:true}]);
    const queued=(await db.pool.query('SELECT status,body FROM wa_outbox WHERE account_id=$1',[account])).rows[0];expect(queued).toMatchObject({status:'failed',body:''});
    const events=(await db.pool.query("SELECT payload->'event' AS event FROM outbox WHERE payload->'event'->>'type' IN ('wa.privacy','wa.inbox')")).rows;
    expect(events.some((r:any)=>r.event.type==='wa.privacy')).toBe(true);
    const refreshed=await db.pool.query("SELECT payload->'event' AS event FROM outbox WHERE payload->'event'->>'type'='whatsapp.updated' AND payload->'event'->>'accountId'=$1",[account]);
    expect(refreshed.rows.some((r:any)=>Object.keys(r.event).sort().join(',')==='accountId,type')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('sensitive fixture');
    expect(events.filter((r:any)=>r.event.type==='wa.inbox').every((r:any)=>r.event.chat.hidden && r.event.chat.inboxPlace===null && r.event.chat.name==='')).toBe(true);
  });
  it('snapshot reconciliation is atomic and refuses a concurrent privacy revision',async()=>{
    await privacy.quarantineWaAccount(account,user);
    await expect(privacy.finishWaPrivacy(account,user,()=>false,[])).rejects.toThrow('cambió');
    expect((await wa.listAccounts(user))[0].privacyReady).toBe(false);
    await privacy.finishWaPrivacy(account,user,()=>true,[secret]);
    expect((await wa.listAccounts(user))[0].privacyReady).toBe(true);
    await expect(wa.ownChat(user,account,secret)).rejects.toMatchObject({status:404});
    // A complete authoritative snapshot without this lock may clear a stale saved flag.
    await privacy.quarantineWaAccount(account,user);await privacy.finishWaPrivacy(account,user,()=>true,[]);
    expect((await wa.ownChat(user,account,secret)).jid).toBe(secret);
  });
  it('expired or missing bridge leases close all lists and media even with a previous privacy checkpoint',async()=>{
    await expect(privacy.finishWaPrivacy(account,user,()=>true,[],'different-bridge')).rejects.toThrow('Lease');
    await privacy.finishWaPrivacy(account,user,()=>true,[],'fixture');
    await db.pool.query('UPDATE wa_accounts SET lease_until=now()-interval \'1 second\' WHERE id=$1',[account]);
    expect((await wa.listAccounts(user))[0]).toMatchObject({privacyReady:false,chats:0});
    expect((await wa.listChats(user,{limit:100})).chats).toEqual([]);
    await expect(media.ownMedia(user,account,secret,'fixture-message')).rejects.toMatchObject({status:404});
    await db.pool.query('UPDATE wa_accounts SET lease_until=now()+interval \'1 hour\',lease_owner=NULL WHERE id=$1',[account]);
    expect((await wa.listAccounts(user))[0].privacyReady).toBe(false);
    await db.pool.query("UPDATE wa_accounts SET lease_owner='fixture' WHERE id=$1",[account]);
    expect((await wa.listAccounts(user))[0].privacyReady).toBe(true);
  });
  it('a delayed former owner cannot unlock, change aliases or persist history after lease takeover',async()=>{
    await privacy.applyWaLocks(account,user,[{jid:secret,locked:true}],false,'fixture');
    await db.pool.query("UPDATE wa_accounts SET lease_owner='replacement',privacy_synced_at=now(),privacy_quarantined_at=NULL WHERE id=$1",[account]);
    await privacy.applyWaLocks(account,user,[{jid:secret,locked:true}],false,'replacement');
    const stale={...session,leaseOwner:'fixture'};
    await expect(privacy.applyWaLocks(account,user,[{jid:secret,locked:false}],false,'fixture')).rejects.toThrow('Lease');
    await expect(sync.upsertChats(stale,[sync.chatFromWa({id:secret,locked:false})])).rejects.toThrow('Lease');
    await expect(sync.storeAliases(stale,[{lid:'former@lid',pn:'former@s.whatsapp.net'}])).rejects.toThrow('Lease');
    await expect(sync.storeMessages(stale,[{chat:secret,id:'former-message',fromMe:false,authorJid:null,authorName:null,kind:'text',body:'former fixture',sentAt:new Date()}],true)).rejects.toThrow('Lease');
    await expect(privacy.quarantineWaAccount(account,user,'fixture')).rejects.toThrow('Lease');
    expect((await db.pool.query('SELECT wa_locked FROM wa_chats WHERE account_id=$1 AND jid=$2',[account,secret])).rows[0].wa_locked).toBe(true);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM wa_jid_alias WHERE account_id=$1 AND lid='former@lid'",[account])).rows[0].n).toBe(0);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM wa_messages WHERE account_id=$1 AND id='former-message'",[account])).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT privacy_synced_at FROM wa_accounts WHERE id=$1',[account])).rows[0].privacy_synced_at).not.toBeNull();
    await db.pool.query("UPDATE wa_accounts SET lease_owner='fixture' WHERE id=$1",[account]);
    await privacy.applyWaLocks(account,user,[{jid:secret,locked:false}],false,'fixture');
  });
  it('graceful shutdown quarantines before socket stop and leaves no usable lease',async()=>{
    let stopped=false;
    await privacy.shutdownWaPrivacy([{id:account,userId:user}],'fixture',async()=>{
      const beforeStop=(await db.pool.query('SELECT privacy_synced_at,lease_owner FROM wa_accounts WHERE id=$1',[account])).rows[0];
      expect(beforeStop).toEqual({privacy_synced_at:null,lease_owner:null});stopped=true;
    });
    expect(stopped).toBe(true);
    const state=(await db.pool.query('SELECT privacy_synced_at,lease_owner,lease_until FROM wa_accounts WHERE id=$1',[account])).rows[0];
    expect(state).toEqual({privacy_synced_at:null,lease_owner:null,lease_until:null});
    expect((await wa.listChats(user,{limit:100})).chats).toEqual([]);
    await expect(media.ownMedia(user,account,secret,'fixture-message')).rejects.toMatchObject({status:404});
  });
  it('held finish transactions cannot reopen either account once shutdown begins',async()=>{
    await db.pool.query("UPDATE wa_accounts SET lease_owner='fixture',lease_until=now()+interval '1 hour',privacy_synced_at=NULL WHERE id=ANY($1)",[[account,otherAccount]]);
    const active=[{id:account,userId:user,stopping:false},{id:otherAccount,userId:other,stopping:false}];
    const gate=await db.pool.connect();await gate.query('BEGIN');await gate.query('SELECT id FROM wa_accounts WHERE id=ANY($1) FOR UPDATE',[[account,otherAccount]]);
    const finishing=active.map(a=>privacy.finishWaPrivacy(a.id,a.userId,()=>!a.stopping,undefined,'fixture').then(()=>null,(e:any)=>e));
    const stopping=privacy.shutdownWaPrivacy(active,'fixture',()=>{});
    expect(active.every(a=>a.stopping)).toBe(true);
    await gate.query('COMMIT');gate.release();
    for(const done of finishing) expect((await done)?.message).toMatch(/Estado de privacidad cambió|Lease de privacidad vencido/);
    await stopping;
    const ready=(await db.pool.query('SELECT count(*)::int AS n FROM wa_accounts WHERE id=ANY($1) AND privacy_synced_at IS NOT NULL',[[account,otherAccount]])).rows[0].n;
    expect(ready).toBe(0);
  });
  it('large quarantines emit minimal batched invalidations once until privacy becomes ready again',async()=>{
    if(session.notifyTimer) {clearTimeout(session.notifyTimer);session.notifyTimer=null;}
    await db.pool.query("UPDATE wa_chats SET inbox_place=NULL WHERE account_id=$1",[account]);
    await db.pool.query(`INSERT INTO wa_chats(account_id,jid,is_group,inbox_place)
      SELECT $1,'batch-'||n||'@g.us',true,'groups' FROM generate_series(1,1500)n`,[account]);
    await db.pool.query("UPDATE wa_accounts SET privacy_synced_at=now(),privacy_quarantined_at=NULL WHERE id=$1",[account]);
    const count=async()=>Number((await db.pool.query("SELECT count(*) AS n FROM outbox WHERE payload->'event'->>'type'='wa.inbox' AND payload->'event'->'chat'->>'accountId'=$1",[account])).rows[0].n);
    const before=await count();await privacy.quarantineWaAccount(account,user);expect(await count()).toBe(before+1500);
    await privacy.quarantineWaAccount(account,user);await privacy.quarantineWaAccount(account,user);expect(await count()).toBe(before+1500);
    const events=(await db.pool.query("SELECT payload->'event'->'chat' AS chat FROM outbox WHERE payload->'event'->'chat'->>'accountId'=$1 AND payload->'event'->'chat'->>'jid' LIKE 'batch-%'",[account])).rows;
    expect(events.every((r:any)=>r.chat.hidden && r.chat.name==='' && r.chat.lastPreview===null)).toBe(true);
  });
  it('lease heartbeat progresses independently while provider I/O remains pending',async()=>{
    await db.pool.query("UPDATE wa_accounts SET lease_owner='fixture',lease_until=now()+interval '150 milliseconds' WHERE id=$1",[account]);
    const active={id:account,stopping:false};let sent=false;let release!:()=>void;
    const providerIO=new Promise<void>(resolve=>{release=()=>{sent=true;resolve();};});
    const lease=await import('../src/modules/wa-lease.ts');
    const heartbeat=lease.startWaLeaseHeartbeat(()=>[active],'fixture',30,()=>{active.stopping=true;},10);
    try {
      await new Promise(resolve=>setTimeout(resolve,250));
      const remaining=(await db.pool.query('SELECT extract(epoch FROM lease_until-now()) AS seconds FROM wa_accounts WHERE id=$1',[account])).rows[0].seconds;
      expect(Number(remaining)).toBeGreaterThan(20);expect(sent).toBe(false);
      await db.pool.query("UPDATE wa_accounts SET lease_owner='different' WHERE id=$1",[account]);
      await heartbeat.renew();expect(active.stopping).toBe(true);
    } finally {heartbeat.stop();release();await providerIO;}
  });
  it('an expired lease with the same owner is never revived by heartbeat',async()=>{
    await db.pool.query("UPDATE wa_accounts SET lease_owner='fixture',lease_until=now()-interval '1 second',privacy_synced_at=now() WHERE id=$1",[account]);
    const before=(await db.pool.query('SELECT lease_until FROM wa_accounts WHERE id=$1',[account])).rows[0].lease_until;
    const active={id:account,stopping:false};let lost=false;
    const lease=await import('../src/modules/wa-lease.ts');
    const heartbeat=lease.startWaLeaseHeartbeat(()=>[active],'fixture',30,()=>{lost=true;active.stopping=true;},60_000);
    try {
      await heartbeat.renew();
      expect(lost).toBe(true);expect(active.stopping).toBe(true);
      expect((await db.pool.query('SELECT lease_until FROM wa_accounts WHERE id=$1',[account])).rows[0].lease_until).toEqual(before);
      expect((await wa.listAccounts(user))[0].privacyReady).toBe(false);
    } finally {heartbeat.stop();}
  });
  it('quarantine DB failure pauses renewal and stops the session instead of extending a stale lease',async()=>{
    await db.pool.query("UPDATE wa_accounts SET lease_owner='fixture',lease_until=now()+interval '20 milliseconds' WHERE id=$1",[account]);
    const active={id:account,userId:user,stopping:false,leasePaused:false};let stopped=false;
    const broken=vi.spyOn(db.pool,'connect').mockRejectedValueOnce(new Error('fixture DB unavailable'));
    try {await expect(privacy.quarantineWaSession(active,'fixture',()=>{stopped=true;})).rejects.toThrow('DB unavailable');} finally {broken.mockRestore();}
    expect(active).toMatchObject({stopping:true,leasePaused:true});expect(stopped).toBe(true);
    const lease=await import('../src/modules/wa-lease.ts');
    const heartbeat=lease.startWaLeaseHeartbeat(()=>[active].filter(s=>!s.leasePaused),'fixture',30,()=>{},10);
    try {
      await new Promise(resolve=>setTimeout(resolve,100));
      expect((await db.pool.query('SELECT lease_until<now() AS expired FROM wa_accounts WHERE id=$1',[account])).rows[0].expired).toBe(true);
    } finally {heartbeat.stop();}
  });
  it('reconnect quarantine invalidates all access without deleting encrypted credentials',async()=>{
    await db.pool.query("INSERT INTO wa_auth(account_id,key,value) VALUES($1,'creds',$2)",[account,Buffer.from('synthetic encrypted credentials')]);
    await privacy.quarantineWaAccount(account,user);
    expect((await wa.listChats(user,{limit:100})).chats).toEqual([]);
    expect((await db.pool.query('SELECT key FROM wa_auth WHERE account_id=$1',[account])).rowCount).toBe(1);
  });
});
