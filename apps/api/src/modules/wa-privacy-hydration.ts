import {serialize,deserialize} from 'node:v8';
/**
 * Rebuild only derived app-state versions in memory. Signal/session credentials and
 * app-state encryption keys continue using the durable store. Failed reconstructions
 * never replace durable versions and never attest privacy readiness.
 */
export const PRIVACY_COLLECTIONS = ['critical_block','critical_unblock_low','regular_high','regular_low','regular'] as const;
export function privacyAppState(base: {get: Function;set: Function}, reconstruct = true) {
  const states = new Map<string,unknown>();
  let failed=false;
  let checkpoint:Record<string,unknown> | null=null;
  const completed=new Set<string>();
  const loaded=new Set<string>();
  let receiptReceived=false;
  const receiptCompleted=new Set<string>();
  const receiptFailed=new Set<string>();
  return {
    keys: {
      async get(type:string,ids:string[]) {
        if(type!=='app-state-sync-version') return base.get(type,ids);
        if(!reconstruct) {
          const missing=ids.filter(id=>!loaded.has(id));
          if(missing.length) { const saved=await base.get(type,missing);for(const id of missing) {loaded.add(id);if(saved[id]) states.set(id,saved[id]);} }
        }
        return Object.fromEntries(ids.filter(id=>states.has(id)).map(id=>[id,states.get(id)]));
      },
      async set(data:Record<string,Record<string,unknown>>) {
        const rest={...data};
        if(rest['app-state-sync-version']) {
          for(const [id,value] of Object.entries(rest['app-state-sync-version'])) {
            loaded.add(id);
            if(value) states.set(id,value); else states.delete(id);
          }
          delete rest['app-state-sync-version'];
        }
        if(Object.keys(rest).length) await base.set(rest);
      },
    },
    recordFailure() { failed=true; },
    acceptReceipt(receipt:unknown) {
      const r=receipt as {completedCollections?:unknown;failedCollections?:unknown} | null;
      receiptReceived=true;
      // Diagnostic metadata is allowlisted separately; it never changes readiness.
      for(const name of PRIVACY_COLLECTIONS) {
        if(Array.isArray(r?.completedCollections) && r.completedCollections.includes(name)) receiptCompleted.add(name);
        if(Array.isArray(r?.failedCollections) && r.failedCollections.includes(name)) receiptFailed.add(name);
      }
      if(!r || !Array.isArray(r.completedCollections) || !Array.isArray(r.failedCollections) || r.failedCollections.length) {failed=true;return;}
      for(const name of r.completedCollections) if(typeof name==='string') completed.add(name);
      // Freeze before awaiting lock persistence: subsequent live deltas must not
      // advance the durable checkpoint ahead of their corresponding SQL locks.
      checkpoint=deserialize(serialize(Object.fromEntries(PRIVACY_COLLECTIONS.map(name=>[name,states.get(name) ?? null]))));
    },
    complete() { return !failed && PRIVACY_COLLECTIONS.every(name=>completed.has(name)); },
    diagnostics() { return {failureLatched:failed,receiptReceived,completedCollections:[...receiptCompleted],failedCollections:[...receiptFailed],missingCollections:PRIVACY_COLLECTIONS.filter(name=>!receiptCompleted.has(name))}; },
    async commit() {
      if(failed || !PRIVACY_COLLECTIONS.every(name=>completed.has(name))) throw new Error('Estado de privacidad incompleto');
      await base.set({'app-state-sync-version':checkpoint});
    },
  };
}
