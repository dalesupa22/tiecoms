/** Isolated DB/S3/WA-provider fixtures: proves persistence/ACL, never real WhatsApp or media playback. */
import { randomUUID, createHash,createCipheriv,randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({reply:'fixture reply',history:[] as any[],body:Buffer.from('R0lGODlhAwACAPAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAwACAAACAoRRACH5BAAKAAAALAAAAAADAAIAAAIChFEAOw==','base64')}));
vi.mock('../src/modules/assistant.ts',async(importOriginal)=>({...await importOriginal<any>(),respond:async(_u:any,h:any)=>{mock.history=h;return {reply:mock.reply,actions:[],suggestions:[]};},completeJson:async()=>JSON.stringify({answer:'Propuesta con calendario del servidor',followUps:['Buscar horarios'],suggestions:[]})}));
vi.mock('baileys',async(importOriginal)=>({...await importOriginal<any>(),downloadMediaMessage:async()=>Readable.from([mock.body])}));
const run=randomUUID().slice(0,8);
describe.skipIf(!process.env.DATABASE_URL)('nocturna compatible: API and canonical media',()=>{
  let app:any,db:any,api:any,s3:ChildProcess,fakeMeeting:ChildProcess,fakeUrl:string,a:any,b:any,c:any,d:any,ws:string,cid:string,account:string;
  async function req(method:string,path:string,token?:string,body?:unknown,ip='10.33.44.55'){
    const r=await app.inject({method,url:'/api/v1'+path,payload:body,headers:{...(token?{authorization:'Bearer '+token}:{}),'x-forwarded-for':ip,'x-tiecoms-contract':'2026-09-29.2'}});
    let json:any={};try{json=r.json();}catch{}return {status:r.statusCode,json,bytes:r.rawPayload};
  }
  async function signup(name:string){const r=await req('POST','/auth/signup',undefined,{name,orgName:name+run,email:name.toLowerCase()+run+'@example.com',password:'fixture-password-123',device:{deviceId:randomUUID(),name:'fixture',platform:'web'}},'10.12.0.'+Math.floor(Math.random()*200+1));expect(r.status).toBe(200);return {id:r.json.user.id,token:r.json.accessToken};}
  beforeAll(async()=>{
    const target=new URL(process.env.DATABASE_URL!);if(!['localhost','127.0.0.1'].includes(target.hostname) || target.port!=='55481' || !['/tiecoms_nocturna_20261001','/tiecoms_nocturna_20261001_fresh'].includes(target.pathname)) throw new Error('Dedicated local nocturna fixture DB required');
    const port=59900+Math.floor(Math.random()*70);s3=spawn(process.execPath,[fileURLToPath(new URL('./fake-s3.mjs',import.meta.url)),String(port)],{stdio:'ignore'});
    const meetPort=59700+Math.floor(Math.random()*70);fakeUrl='http://127.0.0.1:'+meetPort;fakeMeeting=spawn(process.execPath,[fileURLToPath(new URL('./fake-meetings.mjs',import.meta.url)),String(meetPort)],{stdio:'ignore'});
    Object.assign(process.env,{MEETINGS_ENABLED:'true',GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',MEETINGS_GOOGLE_API:fakeUrl+'/google/api',FFMPEG_PATH:fileURLToPath(new URL('./fake-ffmpeg.mjs',import.meta.url)),S3_ENDPOINT:'http://127.0.0.1:'+port,S3_BUCKET:'nocturna-fixture',AWS_ACCESS_KEY_ID:'fixture',AWS_SECRET_ACCESS_KEY:'fixture',CALLS_ENABLED:'true',CALLS_PROVIDER:'fake',MIGRATE_ON_START:'false'});
    await new Promise((r)=>setTimeout(r,400));
    db=await import('../src/db.ts');const {migrate}=await import('../src/migrate.ts');await migrate();api=await import('../src/http.ts');app=await api.buildHttp();
    a=await signup('NocturnaA');b=await signup('NocturnaB');c=await signup('NocturnaC');d=await signup('NocturnaD');
    const w=await req('POST','/workspaces',a.token,{name:'nocturna '+run});expect(w.status).toBe(200);cid=w.json.generalConversationId;ws=w.json.id;
    for(const user of [b,c]){await db.pool.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",[ws,user.id]);await db.pool.query("INSERT INTO conversation_memberships(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[cid,user.id]);}
    const acc=await req('POST','/whatsapp/accounts',a.token,{label:'fixture '+run,kind:'personal'});expect(acc.status).toBe(200);account=acc.json.id;
  });
  afterAll(async()=>{await app?.close();s3?.kill();fakeMeeting?.kill();await db?.pool.end();});

  it('partial preferences merge concurrently and legacy PUT preserves additive keys',async()=>{
    const both=await Promise.all([req('PATCH','/me/personal-preferences',a.token,{issues:{view:'board',grouping:'assignee'}}),req('PATCH','/me/personal-preferences',a.token,{appearance:{mode:'dark'}})]);expect(both.map((r)=>r.status)).toEqual([200,200]);
    let p=(await req('GET','/me/personal-preferences',a.token)).json;expect(p.issues).toEqual({view:'board',grouping:'assignee'});expect(p.appearance.mode).toBe('dark');
    expect((await req('PUT','/me/personal-preferences',a.token,{sections:[],conversations:{}})).status).toBe(200);
    p=(await req('GET','/me/personal-preferences',a.token)).json;expect(p.issues.view).toBe('board');expect(p.appearance.mode).toBe('dark');expect((await req('GET','/me/personal-preferences',b.token)).json.issues).toBeUndefined();
  });
  it('focus is compatible with old DND; busy does not silently lift silence and public state is minimal',async()=>{
    const until=new Date(Date.now()+3_600_000).toISOString();expect((await req('PUT','/me/availability',a.token,{mode:'focus',until})).status).toBe(200);
    let boot=(await req('GET','/bootstrap',a.token)).json;expect(boot.me.dndUntil).toBe(until);expect(boot.me.availability.mode).toBe('focus');
    await req('PUT','/me/availability',a.token,{mode:'busy'});boot=(await req('GET','/bootstrap',b.token)).json;const person=boot.people.find((p:any)=>p.id===a.id);expect(person.availability.silent).toBe(true);expect(Object.keys(person.availability).sort()).toEqual(['mode','revision','silent','until']);
    expect((await req('PUT','/me/availability',a.token,{mode:'rest'})).status).toBe(400);await req('PUT','/me/dnd',a.token,{until:null});
  });
  it('three assignees survive create, edit, reload and child-task without giving outsider visibility',async()=>{
    const r=await req('POST',`/conversations/${cid}/issues`,a.token,{title:'review group',assigneeIds:[a.id,b.id,c.id],visibility:'all'});expect(r.status).toBe(200);const id=r.json.id;expect(r.json.assigneeIds).toEqual([a.id,b.id,c.id]);
    const edit=await req('PATCH','/issues/'+id,a.token,{assigneeIds:[c.id,b.id,a.id]});expect(edit.status).toBe(200);expect(edit.json.assigneeIds).toEqual([c.id,b.id,a.id]);
    expect((await req('GET','/issues/'+id,b.token)).json.issue.assigneeIds).toEqual([c.id,b.id,a.id]);expect((await req('GET','/issues/'+id,d.token)).status).toBe(404);
    const child=await req('POST',`/issues/${id}/children`,a.token,{title:'review child',assigneeIds:[a.id,b.id,c.id]});expect(child.status).toBe(200);expect(child.json.assigneeIds).toHaveLength(3);
  });
  it('verified credits stay complete for legacy while display/edit preserve the comment and skip automatic link indexing',async()=>{
    const atts=await import('../src/modules/attachments.ts');const attachment=await atts.upload(a.id,cid,{body:mock.body,name:'fixture.gif',type:'image/gif'});
    const credit='GIF: fixture · Fuente: https://commons.wikimedia.org/wiki/File:Fixture.gif';const provenance={version:1,provider:'openverse',title:'fixture',attribution:credit,sourceUrl:'https://commons.wikimedia.org/wiki/File:Fixture.gif'};
    await db.pool.query('UPDATE attachments SET provenance=$2 WHERE id=$1',[attachment.id,JSON.stringify(provenance)]);
    const sent=await req('POST',`/conversations/${cid}/messages`,a.token,{clientMessageId:randomUUID(),body:'mi comentario',attachmentIds:[attachment.id]});expect(sent.status).toBe(201);expect(sent.json.message.displayBody).toBe('mi comentario');expect(sent.json.message.body).toBe('mi comentario\n\n'+credit);
    const links=await db.pool.query('SELECT * FROM message_links WHERE message_id=$1',[sent.json.message.id]);expect(links.rowCount).toBe(0);
    const edited=await req('PATCH','/messages/'+sent.json.message.id,a.token,{body:'otro comentario'});expect(edited.json.displayBody).toBe('otro comentario');expect(edited.json.body).toContain(credit);
    const legacyFile=await atts.upload(a.id,cid,{body:mock.body,name:'legacy.gif',type:'image/gif'});await db.pool.query('UPDATE attachments SET provenance=$2 WHERE id=$1',[legacyFile.id,JSON.stringify(provenance)]);
    const legacy=await req('POST',`/conversations/${cid}/messages`,a.token,{clientMessageId:randomUUID(),body:credit,attachmentIds:[legacyFile.id]});expect(legacy.json.message.displayBody).toBe('');expect((await db.pool.query('SELECT id FROM message_links WHERE message_id=$1',[legacy.json.message.id])).rowCount).toBe(0);
    const preview=(await req('GET','/bootstrap',a.token)).json.conversations.find((x:any)=>x.id===cid);expect(preview.lastMessagePreview).not.toContain('Fuente:');expect(preview.lastHumanPreview.body).toBe('');
  });
  it('directed message load respects granted history and descending unread revisions are authoritative',async()=>{
    const row=await req('POST',`/conversations/${cid}/messages`,a.token,{clientMessageId:randomUUID(),body:'around target'});const seq=row.json.message.seq;
    const around=await req('GET',`/conversations/${cid}/messages/around?seq=${seq}`,b.token);expect(around.status).toBe(200);expect(around.json.messages.some((m:any)=>m.seq===seq)).toBe(true);
    const read=await req('POST',`/conversations/${cid}/read`,b.token,{seq});const unread=await req('POST',`/conversations/${cid}/unread`,b.token,{seq});expect(unread.json.lastReadSeq).toBe(seq-1);expect(unread.json.readRevision).toBeGreaterThan(read.json.readRevision);
    await db.pool.query('UPDATE conversation_memberships SET history_from_seq=$3 WHERE conversation_id=$1 AND user_id=$2',[cid,c.id,seq]);expect((await req('GET',`/conversations/${cid}/messages/around?seq=${seq}`,c.token)).status).toBe(404);
    expect((await req('GET',`/conversations/${cid}/messages/around?seq=${seq}`,d.token)).status).toBe(404);
  });
  it('WA pages have stable ties, null-last and signed account/filter scoped cursors beyond old caps',async()=>{
    await db.pool.query(`INSERT INTO wa_chats(account_id,jid,name,is_group,last_message_at,pinned) SELECT $1,'fixture-'||n||'@s.whatsapp.net','fixture'||n,false,CASE WHEN n=1003 THEN NULL ELSE '2026-10-01T12:00:00Z'::timestamptz END,n=1 FROM generate_series(1,1003)n`,[account]);
    const all:string[]=[];let cursor='';for(let i=0;i<5;i++){const r=await req('GET','/whatsapp/chats?limit=300'+(cursor?'&cursor='+encodeURIComponent(cursor):''),a.token);expect(r.status).toBe(200);all.push(...r.json.chats.map((x:any)=>x.jid));cursor=r.json.next;if(!cursor)break;}
    expect(all).toHaveLength(1003);expect(new Set(all).size).toBe(1003);expect(all[0]).toBe('fixture-1@s.whatsapp.net');expect(all.at(-1)).toBe('fixture-1003@s.whatsapp.net');
    const first=await req('GET','/whatsapp/chats?limit=10',a.token);expect((await req('GET','/whatsapp/chats?groups=1&cursor='+encodeURIComponent(first.json.next),a.token)).status).toBe(400);expect((await req('GET','/whatsapp/chats?cursor='+encodeURIComponent(first.json.next),d.token)).status).toBe(400);
  });
  it('three-plus call guests retain unique attendees, one leave preserves others and capacity is atomic',async()=>{
    const calls=await import('../src/modules/calls.ts');
    const start=await req('POST',`/conversations/${cid}/call`,a.token,{kind:'video'});expect(start.status).toBe(200);const callId=start.json.call.id;
    await db.pool.query('INSERT INTO organization_memberships(org_id,user_id) SELECT org_id,$2 FROM organization_memberships WHERE user_id=$1 ON CONFLICT DO NOTHING',[a.id,b.id]);
    expect((await req('POST',`/calls/${callId}/join`,b.token,{})).status).toBe(200);
    const link=await calls.createLink(a.id,callId);const guests=await Promise.all(Array.from({length:12},(_,i)=>calls.guestJoin(link.token,'fixture '+i).then(x=>({ok:true,x}),e=>({ok:false,e}))));
    const good=guests.filter(x=>x.ok) as {ok:true;x:any}[];expect(good).toHaveLength(calls.MAX_GUESTS);expect(guests.filter(x=>!x.ok)).toHaveLength(2);
    expect(new Set(good.map(x=>x.x.attendee.Attendee.AttendeeId)).size).toBe(calls.MAX_GUESTS);expect(new Set(good.map(x=>x.x.attendee.Attendee.ExternalUserId)).size).toBe(calls.MAX_GUESTS);
    for(let i=0;i<40;i++){const g=good[i%good.length]!.x;expect((await req('POST',`/call-guests/${g.guestId}/heartbeat`,undefined,{secret:g.secret},'10.99.22.33')).status).toBe(200);}
    const leave=good[0]!.x;await calls.guestLeave(leave.guestId,leave.secret);const state=await calls.guestHeartbeat(good[1]!.x.guestId,good[1]!.x.secret);expect(state.guests).toHaveLength(calls.MAX_GUESTS-1);expect(state.activeUserIds.sort()).toEqual([a.id,b.id].sort());
    for(const g of good.slice(1)) await calls.guestLeave(g.x.guestId,g.x.secret);
  });
  it('availability deadlines fan out once, revise authoritatively, and do not repeatedly publish',async()=>{
    await req('PUT','/me/availability',a.token,{mode:'focus',until:new Date(Date.now()+60_000).toISOString()});
    await db.pool.query("UPDATE users SET availability_until=now()-interval '1 second',dnd_until=now()-interval '1 second' WHERE id=$1",[a.id]);
    const prefs=await import('../src/modules/prefs.ts');const n=await prefs.expireAvailability();expect(n).toBeGreaterThan(0);const boot=(await req('GET','/bootstrap',a.token)).json;expect(boot.me.availability.mode).toBeNull();expect(boot.me.availability.silent).toBe(false);expect(boot.me.dndUntil).toBeNull();expect(await prefs.expireAvailability()).toBe(0);
  });
  it('WA voice shares canonical original bytes with opt-out AI, local AAC rendition, and temporal content stays restricted',async()=>{
    const sync=await import('../src/modules/wa-sync.ts'),media=await import('../src/modules/wa-media.ts'),voice=await import('../src/modules/voice.ts');const jid='fixture-1@s.whatsapp.net';
    const session:any={id:account,userId:a.id,kind:'personal',me:'fixture@s.whatsapp.net'};
    const source:any={key:{id:'voice-'+run,remoteJid:jid},messageTimestamp:Math.floor(Date.now()/1000),message:{audioMessage:{mimetype:'audio/ogg;codecs=opus',ptt:true,seconds:2,mediaKey:Buffer.alloc(32),url:'https://fixture.invalid/voice'}}};
    const before=mock.body;mock.body=Buffer.from('OggS'+String.fromCharCode(0,0)+'fixture-opus');
    try {await sync.storeMessages(session,[sync.msgRow(session,source)!],false);await media.downloadPendingWaMedia(account,{updateMediaMessage:async(m:any)=>m} as any);
      const r=await req('POST','/whatsapp/share',a.token,{accountId:account,jid,messageId:source.key.id,conversationId:cid,clientMessageId:'voice-copy-'+run});expect(r.status).toBe(201);let at=r.json.emails[0].chagguAttachments[0];expect(at.kind).toBe('voice');expect(at.durationMs).toBe(2000);expect(at.contentType).toBe('audio/ogg');
      const stored=(await db.pool.query('SELECT * FROM attachments WHERE id=$1',[at.id])).rows[0];expect(stored.transcript.aiConsent).toBe(false);await voice.transcribeAttachment(at.id);const updated=(await db.pool.query('SELECT * FROM attachments WHERE id=$1',[at.id])).rows[0];expect(updated.play_type).toBe('audio/mp4');expect(updated.transcript.status).toBe('disabled');
      expect((await req('GET',at.url.replace('/api/v1','')+'?original=1',b.token)).bytes).toEqual(mock.body);
    } finally {mock.body=before;}
    const wrapped:any={...source,key:{...source.key,id:'once-'+run},message:{ephemeralMessage:{message:{imageMessage:{viewOnce:false,mimetype:'image/gif'}}}}};const restricted=sync.msgRow(session,wrapped)!;expect(restricted.mediaState).toBe('restricted');await sync.storeMessages(session,[restricted],false);
    expect((await req('POST','/whatsapp/share',a.token,{accountId:account,jid,messageId:wrapped.key.id,conversationId:cid})).status).toBe(409);
    // Redelivery may legitimately recover the original envelope of a legacy descriptor, without counting unread again.
    await db.pool.query('UPDATE wa_messages SET media_envelope=NULL,media_state=NULL WHERE account_id=$1 AND id=$2',[account,wrapped.key.id]);expect(await sync.storeMessages(session,[restricted],true)).toHaveLength(0);expect((await db.pool.query('SELECT media_state FROM wa_messages WHERE account_id=$1 AND id=$2',[account,wrapped.key.id])).rows[0].media_state).toBe('restricted');
  });
  it('WA original is encrypted/private, shared image copy opens for recipient without WA and survives origin disconnect',async()=>{
    const sync=await import('../src/modules/wa-sync.ts');const media=await import('../src/modules/wa-media.ts');const jid='fixture-1@s.whatsapp.net',id='photo-'+run;
    const session:any={id:account,userId:a.id,kind:'personal',me:'fixture@s.whatsapp.net'};
    const row=sync.msgRow(session,{key:{id,remoteJid:jid,fromMe:false},messageTimestamp:Math.floor(Date.now()/1000),message:{imageMessage:{mimetype:'image/gif',mediaKey:Buffer.alloc(32),url:'https://fixture.invalid/photo',fileLength:mock.body.length}}} as any)!;
    expect(row.mediaState).toBe('pending');await sync.storeMessages(session,[row],false);await media.downloadPendingWaMedia(account,{updateMediaMessage:async(m:any)=>m} as any);
    expect((await req('GET',`/whatsapp/media/${account}/${encodeURIComponent(jid)}/${id}`,b.token)).status).toBe(404);
    const request={accountId:account,jid,messageId:id,conversationId:cid,clientMessageId:'copy-'+run,comment:'foto de fixture'};
    const shared=await req('POST','/whatsapp/share',a.token,request);expect(shared.status).toBe(201);const attachment=shared.json.emails[0].chagguAttachments[0];expect(attachment.contentType).toBe('image/gif');
    const download=await req('GET',attachment.url.replace('/api/v1',''),b.token);expect(download.status).toBe(200);expect(createHash('sha256').update(download.bytes).digest('hex')).toBe(createHash('sha256').update(mock.body).digest('hex'));
    const retry=await req('POST','/whatsapp/share',a.token,request);expect(retry.json.emails[0].id).toBe(shared.json.emails[0].id);
    expect((await req('GET',attachment.url.replace('/api/v1',''),d.token)).status).toBe(404);
    await req('DELETE','/whatsapp/accounts/'+account,a.token);expect((await req('GET',attachment.url.replace('/api/v1',''),b.token)).status).toBe(200);
  });
  it('no calendar connection never fabricates free slots and source authorization is enforced',async()=>{
    const body={source:'c:'+cid,from:new Date(Date.now()+3_600_000).toISOString(),to:new Date(Date.now()+86_400_000).toISOString(),durationMin:30,timezone:'America/Bogota'};
    const r=await req('POST','/gg/calendar/slots',a.token,body);expect(r.status).toBe(200);expect(r.json.status).toBe('needs_connect');expect(r.json.slots).toEqual([]);expect(r.json.checkedAt).toBeNull();expect((await req('POST','/gg/calendar/slots',d.token,body)).status).toBe(404);
  });  it('real-adapter fake calendar checks busy slots, rechecks conflicts, invites only explicit attendees, and retries once',async()=>{
    const key=createHash('sha256').update('chaggu:meetings:'+process.env.JWT_SECRET).digest(),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const enc=Buffer.concat([cipher.update('at-fixture','utf8'),cipher.final()]);const sealed=Buffer.concat([iv,cipher.getAuthTag(),enc]);
    await db.pool.query("INSERT INTO meeting_connections(user_id,provider,access_token_enc,expires_at,status) VALUES($1,'google',$2,now()+interval '1 hour','active')",[a.id,sealed]);
    const from=new Date(Math.ceil((Date.now()+3600_000)/900_000)*900_000).toISOString(),to=new Date(Date.parse(from)+6*3600_000).toISOString();
    const control=async(body:any)=>fetch(fakeUrl+'/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    await control({busy:[{start:{dateTime:from},end:{dateTime:new Date(Date.parse(from)+3600_000).toISOString()}}]});
    const slots=await req('POST','/gg/calendar/slots',a.token,{source:'c:'+cid,from,to,durationMin:30,timezone:'America/Bogota'});expect(slots.json.status).toBe('ready');expect(slots.json.checkedAt).toBeTruthy();expect(slots.json.slots).toHaveLength(3);expect(Date.parse(slots.json.slots[0].startsAt)).toBeGreaterThanOrEqual(Date.parse(from)+3600_000);
    const slot=slots.json.slots[0],body={source:'c:'+cid,provider:'google',...slot,idempotencyKey:'calendar-'+run,title:'Revisión explícita',description:'Resumen aprobado',timezone:'America/Bogota',shareToChat:true,attendeeEmails:['explicit-invite@example.com'],inviteeIds:[b.id]};
    await control({busy:[{start:{dateTime:slot.startsAt},end:{dateTime:slot.endsAt}}]});expect((await req('POST','/gg/calendar/confirm',a.token,body)).json.error.code).toBe('calendar_conflict');
    await control({busy:[]});const made=await req('POST','/gg/calendar/confirm',a.token,body);expect(made.status).toBe(200);expect(made.json.status).toBe('created');const retry=await req('POST','/gg/calendar/confirm',a.token,body);expect(retry.json.id).toBe(made.json.id);
    const events=await(await fetch(fakeUrl+'/events')).json() as any[];expect(events.at(-1).attendees).toEqual([{email:'explicit-invite@example.com'}]);const invitees=(await db.pool.query('SELECT user_id FROM calendar_event_invitees WHERE event_id=$1',[made.json.calendarEventId])).rows.map((r:any)=>r.user_id).sort();expect(invitees).toEqual([a.id,b.id].sort());
    expect((await req('POST','/gg/calendar/confirm',a.token,{...body,title:'otra'})).status).toBe(409);expect((await req('POST','/gg/calendar/confirm',a.token,{...body,idempotencyKey:'unauthorized-'+run,inviteeIds:[d.id]})).status).toBe(400);
  });
  it('gg preserves complete UTF-8 input/output as authorized files without granting gg membership and retry duplicates',async()=>{
    await db.pool.query('UPDATE users SET ai_consent_at=now() WHERE id=$1',[a.id]);const atts=await import('../src/modules/attachments.ts'),gg=await import('../src/modules/gg.ts');
    const inputText='```typescript\n'+('const revisión = "íntegra";\n'.repeat(1000))+'```';const file=await atts.upload(a.id,cid,{body:Buffer.from(inputText),name:'review.md',type:'text/markdown'});
    const sent=await req('POST',`/conversations/${cid}/messages`,a.token,{clientMessageId:randomUUID(),body:'@gg revisa este archivo',attachmentIds:[file.id]});expect(sent.status).toBe(201);
    mock.reply='Respuesta íntegra 😃\n'.repeat(1000);await gg.reply(sent.json.message.id);await gg.reply(sent.json.message.id);expect(mock.history.some(h=>h.content.includes(inputText))).toBe(true);
    const answers=await db.pool.query('SELECT * FROM messages WHERE conversation_id=$1 AND client_message_id=$2',[cid,'gg-reply-'+sent.json.message.id]);expect(answers.rowCount).toBe(1);const attachment=answers.rows[0].attachments[0];expect(attachment.contentType).toBe('text/plain');expect((await req('GET',attachment.url.replace('/api/v1',''),b.token)).bytes.toString()).toBe(mock.reply);
    const member=await db.pool.query('SELECT 1 FROM conversation_memberships WHERE conversation_id=$1 AND user_id=$2',[cid,answers.rows[0].author_id]);expect(member.rowCount).toBe(0);expect((await req('GET',attachment.url.replace('/api/v1',''),d.token)).status).toBe(404);
  });
  it('gg selected source obtains structured real-adapter slots only for the explicit calendar gesture',async()=>{
    const text=await req('POST',`/conversations/${cid}/messages`,a.token,{clientMessageId:randomUUID(),body:'Necesitamos agendar una revisión'});
    const source='c:'+cid,messageIds=[text.json.message.id];const clarify=await req('POST','/gg/side/suggest',a.token,{source,messageIds});expect(clarify.status).toBe(200);expect(clarify.json.calendar.status).toBe('needs_clarification');expect(clarify.json.calendar.checkedAt).toBeNull();
    const from=new Date(Date.now()+24*3600_000).toISOString(),to=new Date(Date.now()+48*3600_000).toISOString();const before:any=await(await fetch(fakeUrl+'/stats')).json();
    const checked=await req('POST','/gg/side',a.token,{source,text:'Busca tres horarios',quotedMessageIds:messageIds,calendar:{from,to,durationMin:30,timezone:'America/Bogota'}});expect(checked.status).toBe(200);expect(checked.json.message.extra.calendar.status).toBe('ready');expect(checked.json.message.extra.calendar.slots).toHaveLength(3);expect(checked.json.message.extra.calendar.checkedAt).toBeTruthy();expect((await(await fetch(fakeUrl+'/stats')).json() as any).google).toBe(before.google);
  });

});
