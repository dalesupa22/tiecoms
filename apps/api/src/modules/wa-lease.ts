/** The bridge heartbeat must continue while provider sends/downloads are awaiting I/O. */
import {pool,tx,type Tx} from '../db.ts';

export class WaLeaseLost extends Error { constructor(){super('Lease de privacidad vencido');} }

/** Row fencing: a delayed former owner cannot mutate state after takeover. */
export async function lockWaLease(c:Tx,accountId:string,owner?:string|null,allowExpired=false) {
  const row=(await c.query('SELECT id,lease_owner,lease_until FROM wa_accounts WHERE id=$1 FOR UPDATE',[accountId])).rows[0];
  if(owner!==undefined && (!row || row.lease_owner!==owner || (!allowExpired && !(new Date(row.lease_until).getTime()>Date.now())))) throw new WaLeaseLost();
  return row;
}

export async function waLeaseQuery(accountId:string,owner:string|undefined,sql:string,params:any[]) {
  if(owner===undefined) return pool.query(sql,params); // Synthetic fixtures, never used by a live bridge.
  return tx(async c=>{await lockWaLease(c,accountId,owner);return c.query(sql,params);});
}


export function startWaLeaseHeartbeat<T extends {id:string;stopping:boolean}>(
  sessions:()=>T[], owner:string, seconds:number,
  onLost:(session:T)=>void, intervalMs=15_000,
) {
  let pending:Promise<void>|null=null;
  const renew=()=>{
    if(pending) return pending;
    const active=sessions().filter(s=>!s.stopping);
    if(!active.length) return Promise.resolve();
    pending=(async()=>{
      const r=await pool.query(`UPDATE wa_accounts SET lease_until=clock_timestamp()+make_interval(secs=>$3)
        WHERE id=ANY($1) AND lease_owner=$2 AND lease_until>clock_timestamp() RETURNING id`,[active.map(s=>s.id),owner,seconds]);
      const renewed=new Set(r.rows.map(row=>row.id));
      for(const session of active) if(!renewed.has(session.id)) onLost(session);
    })().finally(()=>{pending=null;});
    return pending;
  };
  const timer=setInterval(()=>void renew().catch(()=>console.error('[wa] no pude renovar leases')),intervalMs);
  timer.unref();
  return {renew,stop:()=>clearInterval(timer)};
}
