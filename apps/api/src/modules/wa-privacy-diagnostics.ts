/** Only fixed labels and bounded protocol counters may reach privacy diagnostics. */
const collections=new Set(['critical_block','critical_unblock_low','regular_high','regular_low','regular']);
const errorTypes=new Set(['Error','TypeError','RangeError','ReferenceError','TimeoutError','AbortError','Boom','DatabaseError','error']);
const errorCodes=new Set(['23505','23503','23502','40001','40P01','42P01','42703','53300','57014','08006','08003','57P01','ETIMEDOUT','ECONNRESET','EPIPE','ENOTFOUND','ECONNREFUSED','ABORT_ERR']);
const bounded=(value:unknown,max:number)=>typeof value==='number' && Number.isInteger(value) && value>=0 && value<=max ? value : null;

function reason(message:string) {
  if(/blocked on missing key|failed to find key|myAppStateKey.*not present|Falta clave de estado de privacidad/.test(message)) return 'missing_app_state_key';
  if(/HMAC index verification failed/.test(message)) return 'index_mac_failed';
  if(/Invalid patch mac/.test(message)) return 'patch_mac_failed';
  if(/LTHash|hash.*mismatch/i.test(message)) return 'state_hash_failed';
  if(/privacy timeout/.test(message)) return 'privacy_deadline';
  if(/Estado de privacidad incompleto/.test(message)) return 'incomplete_state';
  if(/Estado de privacidad cambió|La privacidad sigue cambiando/.test(message)) return 'state_changed';
  if(/Lease de privacidad vencido/.test(message)) return 'lease_lost';
  if(/No se pudo confirmar privacidad/.test(message)) return 'confirmation_failed';
  if(/Timed Out|timed out|timeout/i.test(message)) return 'provider_timeout';
  return 'unclassified';
}

export function privacyExceptionDetails(error:unknown) {
  const e=error && typeof error==='object' ? error as Record<string,any> : {};
  return {
    reason:reason(typeof e.message==='string' ? e.message : ''),
    errorType:errorTypes.has(e.name) ? e.name as string : null,
    errorCode:errorCodes.has(e.code) ? e.code as string : null,
    statusCode:bounded(e.output?.statusCode,599),
  };
}

export function privacyWarningDetails(args:unknown[]) {
  const data=args.find(v=>v && typeof v==='object' && collections.has((v as any).name)) as Record<string,unknown> | undefined;
  // Error strings may contain key IDs or JIDs; inspect them only to select a fixed label.
  const messages=args.filter(v=>typeof v==='string').join(' ')+(typeof data?.error==='string' ? ' '+data.error : '');
  return {
    collection:data && collections.has(data.name as string) ? data.name as string : null,
    reason:reason(messages),
    attempt:bounded(data?.attempt,100),
    errorType:errorTypes.has(data?.errorType as string) ? data!.errorType as string : null,
    statusCode:bounded(data?.statusCode,599),
  };
}
