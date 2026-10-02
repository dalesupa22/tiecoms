import {lockWaLease,WaLeaseLost} from './wa-lease.ts';
/** Provider Chat Lock policy shared by API and bridge; deliberately no Baileys import. */
import { enqueueOutbox, pool, tx, type Tx } from '../db.ts';
import { notFound } from '../errors.ts';

/** List queries keep the account gate on the account row, avoiding one scan per chat. */
export function visibleWaChatSql(chat='c',account='a') {
  return `wa_account_visible(${account}.id) AND NOT ${chat}.privacy_only AND ${chat}.wa_locked IS NOT TRUE AND NOT EXISTS (
    SELECT 1 FROM wa_jid_alias privacy_alias JOIN wa_chats privacy_lock
      ON privacy_lock.account_id=privacy_alias.account_id AND (privacy_lock.jid=privacy_alias.lid OR privacy_lock.jid=privacy_alias.pn)
    WHERE privacy_alias.account_id=${chat}.account_id AND (privacy_alias.lid=${chat}.jid OR privacy_alias.pn=${chat}.jid)
      AND privacy_lock.wa_locked IS TRUE)`;
}

export async function requireWaVisible(db: typeof pool | Tx, accountId: string, jid: string) {
  const r = await db.query('SELECT wa_chat_visible($1,$2) AS visible', [accountId, jid]);
  if (!r.rows[0]?.visible) throw notFound('Chat');
}

async function tombstone(c: Tx, userId: string, accountId: string, jids: string[], reset = false) {
  const payloads:unknown[]=[
    {userIds:[userId],event:{type:'wa.privacy',accountId,...(reset ? {reset:true} : {jids})}},
    {userIds:[userId],event:{type:'whatsapp.updated',accountId}},
  ];
  // Old clients understand removal through wa.inbox. No name, preview or message content.
  for(const jid of jids) payloads.push({userIds:[userId],event:{type:'wa.inbox',chat:{
    accountId,jid,name:'',accountLabel:'',accountKind:'personal',isGroup:jid.endsWith('@g.us'),participants:null,
    description:null,lastMessageAt:null,lastPreview:null,unread:0,category:'otros',categoryManual:false,pinned:false,
    hidden:true,archivedInWhatsApp:false,linkedConversationId:null,inboxPlace:null,inboxPinnedAt:null,
  }}});
  // A bounded bulk payload per SQL call and one wake-up for the whole transaction.
  for(let i=0;i<payloads.length;i+=1000) await c.query(`INSERT INTO outbox(topic,payload)
    SELECT 'account.event', value FROM jsonb_array_elements($1::jsonb) AS batch(value)`,[JSON.stringify(payloads.slice(i,i+1000))]);
  await c.query("SELECT pg_notify('tiecoms_outbox','')");
}

export async function quarantineWaAccount(accountId: string, userId: string, leaseOwner?:string|null) {
  await tx(async c => {
    await lockWaLease(c,accountId,leaseOwner,true);
    const changed=await c.query(`UPDATE wa_accounts SET privacy_synced_at=NULL,privacy_quarantined_at=now()
      WHERE id=$1 AND (privacy_synced_at IS NOT NULL OR privacy_quarantined_at IS NULL) RETURNING id`,[accountId]);
    await c.query("UPDATE wa_outbox SET status='failed',body='',error='Chat no disponible' WHERE account_id=$1 AND status='queued'",[accountId]);
    if(!changed.rowCount) return;
    const rows=await c.query('SELECT jid FROM wa_chats WHERE account_id=$1 AND inbox_place IS NOT NULL',[accountId]);
    await tombstone(c,userId,accountId,rows.rows.map(r=>r.jid),true);
  });
}

/** All addresses in the same PN/LID component, including multiple known LIDs for one PN. */
async function lockJids(c:Tx,accountId:string,jid:string) {
  const aliases=await c.query(`SELECT lid,pn FROM wa_jid_alias WHERE account_id=$1
    AND (lid=$2 OR pn=$2 OR pn IN (SELECT pn FROM wa_jid_alias WHERE account_id=$1 AND lid=$2))`,[accountId,jid]);
  return [...new Set([jid,...aliases.rows.flatMap(r=>[r.lid,r.pn])])] as string[];
}

async function persistLock(c:Tx,accountId:string,userId:string,jids:string[],locked:boolean,revision:number,fromHistory=false) {
  const old=(await c.query('SELECT jid,wa_locked,wa_lock_revision FROM wa_chats WHERE account_id=$1 AND jid=ANY($2)',[accountId,jids])).rows;
  if(fromHistory) {
    const explicit=old.filter(r=>Number(r.wa_lock_revision)>0).sort((a,b)=>Number(b.wa_lock_revision)-Number(a.wa_lock_revision))[0];
    if(explicit) {locked=explicit.wa_locked;revision=Number(explicit.wa_lock_revision);fromHistory=false;}
  }
  const changed=await c.query(`INSERT INTO wa_chats(account_id,jid,is_group,wa_locked,privacy_only,wa_lock_revision)
    SELECT $1,j,j LIKE '%@g.us',$3,true,$5 FROM unnest($2::text[]) t(j)
    ON CONFLICT(account_id,jid) DO UPDATE SET wa_locked=EXCLUDED.wa_locked,
      wa_lock_revision=EXCLUDED.wa_lock_revision,updated_at=now()
    WHERE (CASE WHEN $4 THEN wa_chats.wa_lock_revision=0 AND (EXCLUDED.wa_locked OR wa_chats.wa_locked IS NULL)
      ELSE wa_chats.wa_lock_revision<=EXCLUDED.wa_lock_revision END)
      AND (wa_chats.wa_locked IS DISTINCT FROM EXCLUDED.wa_locked OR wa_chats.wa_lock_revision<>EXCLUDED.wa_lock_revision)
    RETURNING jid`,[accountId,jids,locked,fromHistory,revision]);
  const prior=new Map(old.map(r=>[r.jid,r.wa_locked]));
  if(!locked || !changed.rows.some(r=>prior.get(r.jid)!==true)) return;
  await c.query(`UPDATE wa_chats SET linked_conversation_id=NULL,linked_since=NULL,inbox_place=NULL,inbox_pinned_at=NULL
    WHERE account_id=$1 AND jid=ANY($2)`,[accountId,jids]);
  await c.query("UPDATE wa_outbox SET status='failed',body='',error='Chat no disponible' WHERE account_id=$1 AND jid=ANY($2) AND status IN ('queued','sending')",[accountId,jids]);
  const unresolved=jids.length===1 && !jids[0]!.endsWith('@g.us');
  const affected=unresolved ? [...new Set([...jids,...(await c.query('SELECT jid FROM wa_chats WHERE account_id=$1 AND inbox_place IS NOT NULL',[accountId])).rows.map(r=>r.jid)])] : jids;
  await tombstone(c,userId,accountId,affected,unresolved);
}

/** Absent fields never unlock. Only ordered explicit app-state actions overrule prior explicit state. */
export async function applyWaLocks(accountId: string, userId: string, changes: {jid:string;locked:boolean}[], fromHistory = false, leaseOwner?:string) {
  if(!changes.length) return;
  await tx(async c=>{
    await lockWaLease(c,accountId,leaseOwner);
    for(const {jid,locked} of changes) {
      const jids=await lockJids(c,accountId,jid);
      const revision=fromHistory ? 0 : Number((await c.query("SELECT nextval('wa_lock_revision_seq') AS revision")).rows[0].revision);
      await persistLock(c,accountId,userId,jids,locked,revision,fromHistory);
    }
  });
}

/** Resolve late mappings under the account lock; latest explicit revision wins, even when false. */
export async function reconcileWaLockAliases(accountId:string,userId:string,jids:string[],leaseOwner?:string) {
  if(!jids.length) return;
  await tx(async c=>{
    await lockWaLease(c,accountId,leaseOwner);
    // Most contact mappings have no privacy state. Resolve only affected components.
    const relevant=await c.query(`SELECT DISTINCT al.pn FROM wa_jid_alias al JOIN wa_chats locked
      ON locked.account_id=al.account_id AND (locked.jid=al.lid OR locked.jid=al.pn)
      WHERE al.account_id=$1 AND (al.lid=ANY($2) OR al.pn=ANY($2)) AND locked.wa_locked IS NOT NULL`,[accountId,jids]);
    const seen=new Set<string>();
    for(const {pn:jid} of relevant.rows) {
      if(seen.has(jid)) continue;
      const component=await lockJids(c,accountId,jid);
      for(const address of component) seen.add(address);
      const rows=(await c.query(`SELECT wa_locked,wa_lock_revision FROM wa_chats WHERE account_id=$1
        AND jid=ANY($2) AND wa_locked IS NOT NULL ORDER BY wa_lock_revision DESC,wa_locked DESC LIMIT 1`,[accountId,component])).rows;
      if(rows[0]) await persistLock(c,accountId,userId,component,rows[0].wa_locked,Number(rows[0].wa_lock_revision));
    }
  });
}

/** Atomic completion; a lock event received while committing invalidates this attempt. */
export async function finishWaPrivacy(accountId:string, userId:string, guard:()=>boolean, snapshotLocked?:string[], leaseOwner?:string) {
  await tx(async c=>{
    await lockWaLease(c,accountId,leaseOwner);
    if(!guard()) throw new Error('Estado de privacidad cambió');
    if(snapshotLocked) {
      const aliases=await c.query('SELECT lid,pn FROM wa_jid_alias WHERE account_id=$1 AND (lid=ANY($2) OR pn=ANY($2))',[accountId,snapshotLocked]);
      const locked=[...new Set([...snapshotLocked,...aliases.rows.flatMap(r=>[r.lid,r.pn])])];
      await c.query('UPDATE wa_chats SET wa_locked=false WHERE account_id=$1 AND wa_locked IS TRUE AND NOT (jid=ANY($2))',[accountId,locked]);
    }
    await c.query('UPDATE wa_accounts SET privacy_synced_at=now(),privacy_hydrated_at=now(),privacy_quarantined_at=NULL WHERE id=$1',[accountId]);
    if(!guard()) throw new Error('Estado de privacidad cambió');
    await enqueueOutbox(c,'account.event',{userIds:[userId],event:{type:'whatsapp.updated',accountId}});
    if(!guard()) throw new Error('Estado de privacidad cambió');
  },1);
}

/** Close visibility before stopping sockets and releasing leases on graceful shutdown. */
export async function shutdownWaPrivacy<T extends {id:string;userId:string;stopping?:boolean}>(accounts:T[],owner:string,stop:(account:T)=>void|Promise<void>) {
  // Invalidate every in-memory guard synchronously, then close ALL leases in one commit.
  for(const account of accounts) account.stopping=true;
  const released=await tx(async c=>{
    const rows=await c.query(`UPDATE wa_accounts SET privacy_synced_at=NULL,lease_owner=NULL,lease_until=NULL
      WHERE id=ANY($1) AND lease_owner=$2 RETURNING id`,[accounts.map(a=>a.id),owner]);
    if(rows.rowCount) await c.query("UPDATE wa_outbox SET status='failed',body='',error='Chat no disponible' WHERE account_id=ANY($1) AND status='queued'",[rows.rows.map(r=>r.id)]);
    return new Set(rows.rows.map(r=>r.id));
  });
  // A new bridge may already have claimed a released account; never invalidate that owner's state.
  for(const account of accounts) if(released.has(account.id)) {
    try {await quarantineWaAccount(account.id,account.userId,null);} catch(e) {if(!(e instanceof WaLeaseLost)) throw e;}
  }
  for(const account of accounts) await stop(account);
}

/** Quarantine failure must remove the session from future heartbeat renewal. */
export async function quarantineWaSession<T extends {id:string;userId:string;stopping:boolean;leasePaused?:boolean}>(session:T,owner:string,stop:(s:T)=>void) {
  session.leasePaused=true;
  try {
    await quarantineWaAccount(session.id,session.userId,owner);
    if(!session.stopping) session.leasePaused=false;
  } catch(e) {
    session.stopping=true;
    stop(session);
    throw e;
  }
}
