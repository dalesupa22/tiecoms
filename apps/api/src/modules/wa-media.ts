import { requireWaVisible } from './wa-privacy.ts';
/** Original WA media is private to the linked-account owner. Shared copies use canonical destination ACL. */
import { createHash, randomUUID } from 'node:crypto';
import { type AttachmentDTO, type WaMediaDTO } from '@tiecoms/contracts';
import { pool, type Tx } from '../db.ts';
import { ApiError, notFound } from '../errors.ts';
import { getObject, objectKey, putObject, deleteObject } from '../storage.ts';
import { toDTO } from './attachments.ts';

export type MediaInfo = { key: string; name: string; contentType: string; sizeBytes: number; width: number | null; height: number | null; kind: 'voice'|'file'; durationMs: number | null; sha256: string };
export function waMediaDTO(row: any): WaMediaDTO | undefined {
  if (!row.media_state && !['image','audio','video','document','sticker'].includes(row.kind)) return undefined;
  const status: WaMediaDTO['status']=row.media_state ?? 'unavailable';
  const info=row.media_info as MediaInfo | null;
  const url=`/api/v1/whatsapp/media/${encodeURIComponent(row.account_id)}/${encodeURIComponent(row.chat_jid)}/${encodeURIComponent(row.id)}`;
  return {status, ...(status==='ready' && info ? {attachment:{id:row.id,name:info.name,contentType:info.contentType,sizeBytes:info.sizeBytes,width:info.width,height:info.height,url,thumbUrl:info.contentType.startsWith('image/') ? url : null,kind:info.kind,durationMs:info.durationMs}} : {}), ...(status==='failed' ? {error:'No se pudo descargar el original. Reintenta.'} : {})};
}
export async function ownMedia(userId:string,accountId:string,jid:string,messageId:string) {
  const r=await pool.query(`SELECT m.* FROM wa_messages m JOIN wa_accounts a ON a.id=m.account_id WHERE m.account_id=$1 AND m.chat_jid=$2 AND m.id=$3 AND a.user_id=$4 AND a.removed_at IS NULL AND wa_chat_visible(m.account_id,m.chat_jid)`,[accountId,jid,messageId,userId]);
  if (!r.rows[0]) throw notFound('Archivo de WhatsApp'); return r.rows[0];
}
export async function readWaMedia(userId:string,accountId:string,jid:string,messageId:string) {
  const row=await ownMedia(userId,accountId,jid,messageId);
  if (row.media_state!=='ready' || !row.media_info) throw new ApiError(409,'wa_media_unavailable','El original todavía no está disponible');
  const object=await getObject(row.media_info.key);
  await requireWaVisible(pool,accountId,jid);
  return object;
}
export async function retryWaMedia(userId:string,accountId:string,jid:string,messageId:string) {
  const row=await ownMedia(userId,accountId,jid,messageId);
  if (row.media_state==='restricted') throw new ApiError(409,'wa_media_restricted','Este contenido temporal no puede copiarse como un archivo permanente');
  if (!row.media_envelope) throw new ApiError(409,'wa_media_unavailable','Original no disponible. Comparte el archivo de nuevo.');
  if (row.media_state!=='ready') await pool.query("UPDATE wa_messages SET media_state='pending' WHERE account_id=$1 AND chat_jid=$2 AND id=$3",[accountId,jid,messageId]);
  await pool.query("SELECT pg_notify('tiecoms_wa',$1)",[accountId]); return {status:row.media_state==='ready' ? 'ready' : 'pending'};
}

/** External I/O happens before the sharing transaction; the independent key remains owned by the target copy. */
export async function prepareWaCopy(row:any) {
  await requireWaVisible(pool,row.account_id,row.chat_jid);
  if (row.media_state==='restricted') throw new ApiError(409,'wa_media_restricted','Este contenido temporal no puede compartirse como archivo permanente');
  if (row.media_state==='pending' || row.media_state==='failed') throw new ApiError(409,'wa_media_pending','El archivo todavía no está listo. Reintenta la descarga antes de compartir.');
  if(row.media_state!=='ready' || !row.media_info) return null;
  const info=row.media_info as MediaInfo; const original=await getObject(info.key);
  if(original.body.length!==info.sizeBytes || createHash('sha256').update(original.body).digest('hex')!==info.sha256) throw new ApiError(409,'wa_media_unavailable','No se pudo verificar el original');
  const key=objectKey(`attachments/wa-copy/${randomUUID()}`);await putObject(key,original.body,info.contentType);return {...info,key};
}
export async function insertWaCopy(c:Tx,ownerId:string,conversationId:string,info:Awaited<ReturnType<typeof prepareWaCopy>>):Promise<AttachmentDTO[]> {
  if(!info) return [];
  const r=await c.query(`INSERT INTO attachments(conversation_id,owner_id,name,content_type,size_bytes,width,height,s3_key,kind,duration_ms,transcript) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[conversationId,ownerId,info.name,info.contentType,info.sizeBytes,info.width,info.height,info.key,info.kind,info.durationMs,info.kind==='voice' ? JSON.stringify({status:'disabled',aiConsent:false}) : null]);
  if(info.kind==='voice') await c.query("INSERT INTO jobs(kind,payload,max_attempts) VALUES('voice.transcribe',$1,1)",[JSON.stringify({attachmentId:r.rows[0].id})]);
  return [toDTO(r.rows[0])];
}

export async function discardWaCopy(info:Awaited<ReturnType<typeof prepareWaCopy>>) { if(info) await deleteObject(info.key).catch(()=>{}); }
