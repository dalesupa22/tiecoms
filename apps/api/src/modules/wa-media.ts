/** Original WA media is private to the linked-account owner. Shared copies use canonical destination ACL. */
import { createHash, randomUUID } from 'node:crypto';
import { downloadMediaMessage, normalizeMessageContent, type WASocket, type WAMessage } from 'baileys';
import { MAX_ATTACHMENT_BYTES, MAX_VOICE_MS, type AttachmentDTO, type WaMediaDTO } from '@tiecoms/contracts';
import { pool, type Tx } from '../db.ts';
import { ApiError, notFound } from '../errors.ts';
import { getObject, objectKey, putObject, deleteObject } from '../storage.ts';
import { imageSize, sniffAudio, sniffImage, toDTO } from './attachments.ts';
import { openWa } from './wa-sync.ts';

type MediaInfo = { key: string; name: string; contentType: string; sizeBytes: number; width: number | null; height: number | null; kind: 'voice'|'file'; durationMs: number | null; sha256: string };
export function waMediaDTO(row: any): WaMediaDTO | undefined {
  if (!row.media_state && !['image','audio','video','document','sticker'].includes(row.kind)) return undefined;
  const status: WaMediaDTO['status']=row.media_state ?? 'unavailable';
  const info=row.media_info as MediaInfo | null;
  const url=`/api/v1/whatsapp/media/${encodeURIComponent(row.account_id)}/${encodeURIComponent(row.chat_jid)}/${encodeURIComponent(row.id)}`;
  return {status, ...(status==='ready' && info ? {attachment:{id:row.id,name:info.name,contentType:info.contentType,sizeBytes:info.sizeBytes,width:info.width,height:info.height,url,thumbUrl:info.contentType.startsWith('image/') ? url : null,kind:info.kind,durationMs:info.durationMs}} : {}), ...(status==='failed' ? {error:'No se pudo descargar el original. Reintenta.'} : {})};
}
export async function ownMedia(userId:string,accountId:string,jid:string,messageId:string) {
  const r=await pool.query(`SELECT m.* FROM wa_messages m JOIN wa_accounts a ON a.id=m.account_id WHERE m.account_id=$1 AND m.chat_jid=$2 AND m.id=$3 AND a.user_id=$4 AND a.removed_at IS NULL`,[accountId,jid,messageId,userId]);
  if (!r.rows[0]) throw notFound('Archivo de WhatsApp'); return r.rows[0];
}
export async function readWaMedia(userId:string,accountId:string,jid:string,messageId:string) {
  const row=await ownMedia(userId,accountId,jid,messageId);
  if (row.media_state!=='ready' || !row.media_info) throw new ApiError(409,'wa_media_unavailable','El original todavía no está disponible');
  return getObject(row.media_info.key);
}
export async function retryWaMedia(userId:string,accountId:string,jid:string,messageId:string) {
  const row=await ownMedia(userId,accountId,jid,messageId);
  if (row.media_state==='restricted') throw new ApiError(409,'wa_media_restricted','Este contenido temporal no puede copiarse como un archivo permanente');
  if (!row.media_envelope) throw new ApiError(409,'wa_media_unavailable','Original no disponible. Comparte el archivo de nuevo.');
  if (row.media_state!=='ready') await pool.query("UPDATE wa_messages SET media_state='pending' WHERE account_id=$1 AND chat_jid=$2 AND id=$3",[accountId,jid,messageId]);
  await pool.query("SELECT pg_notify('tiecoms_wa',$1)",[accountId]); return {status:row.media_state==='ready' ? 'ready' : 'pending'};
}

const logger:any={level:'silent',trace(){},debug(){},info(){},warn(){},error(){},child(){return this;}};
/** One bounded download at a time in the leased bridge; retries are explicit, never an unbounded loop. */
export async function downloadPendingWaMedia(accountId:string,sock:WASocket,isCurrent=()=>true) {
  const rows=await pool.query(`SELECT m.* FROM wa_messages m JOIN wa_accounts a ON a.id=m.account_id WHERE m.account_id=$1 AND a.removed_at IS NULL AND m.media_state='pending' ORDER BY m.sent_at DESC LIMIT 2`,[accountId]);
  for(const row of rows.rows) {
    if(!isCurrent()) break;
    try {
      const original=openWa(row.media_envelope) as WAMessage;
      const content=normalizeMessageContent(original.message);
      const node:any=content?.imageMessage ?? content?.audioMessage ?? content?.videoMessage ?? content?.documentMessage ?? content?.stickerMessage;
      if (!node || Number(node.fileLength ?? 0)>MAX_ATTACHMENT_BYTES) throw new Error('size');
      const stream=await downloadMediaMessage(original,'stream',{options:{signal:AbortSignal.timeout(15_000)}},{logger,reuploadRequest:sock.updateMediaMessage.bind(sock)});
      let bytes=0;const chunks:Buffer[]=[];
      const timer=setTimeout(()=>stream.destroy(new Error('timeout')),20_000);
      try { for await(const chunk of stream) {const b=Buffer.from(chunk);bytes+=b.length;if(bytes>MAX_ATTACHMENT_BYTES) {stream.destroy();throw new Error('size');} chunks.push(b);} } finally {clearTimeout(timer);stream.destroy();}
      const body=Buffer.concat(chunks), image=sniffImage(body), audio=content?.audioMessage ? sniffAudio(body) : null;
      const type=image ?? audio ?? (body.length>12 && body.toString('ascii',4,8)==='ftyp' ? 'video/mp4' : body.subarray(0,5).toString()==='%PDF-' ? 'application/pdf' : null);
      if (!type || !body.length) throw new Error('type');
      const ptt=!!content?.audioMessage?.ptt;
      const durationMs=Number(node.seconds)>0 ? Math.round(Number(node.seconds)*1000) : null;
      if(ptt && (!audio || !durationMs || durationMs>MAX_VOICE_MS)) throw new Error('duration');
      const dims=image ? imageSize(body) ?? {width:null,height:null} : {width:null,height:null};
      const key=objectKey(`wa-originals/${accountId}/${randomUUID()}`);
      const info:MediaInfo={key,name:String(node.fileName ?? (ptt ? 'nota-de-voz.ogg' : image ? `foto.${type.split('/')[1]}` : `archivo.${type.split('/')[1]}`)).slice(0,200),contentType:type,sizeBytes:body.length,width:dims.width,height:dims.height,kind:ptt ? 'voice' : 'file',durationMs,sha256:createHash('sha256').update(body).digest('hex')};
      if(!isCurrent()) break;
      await putObject(key,body,type);
      const updated=await pool.query(`UPDATE wa_messages m SET media_state='ready',media_info=$4 FROM wa_accounts a WHERE m.account_id=$1 AND m.chat_jid=$2 AND m.id=$3 AND a.id=m.account_id AND a.removed_at IS NULL AND m.media_state='pending'`,[accountId,row.chat_jid,row.id,JSON.stringify(info)]);
      if(!updated.rowCount) await deleteObject(key).catch(()=>{});
    } catch { await pool.query("UPDATE wa_messages SET media_state='failed' WHERE account_id=$1 AND chat_jid=$2 AND id=$3 AND media_state='pending'",[accountId,row.chat_jid,row.id]); }
  }
  return rows.rowCount ?? 0;
}

/** External I/O happens before the sharing transaction; the independent key remains owned by the target copy. */
export async function prepareWaCopy(row:any) {
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
