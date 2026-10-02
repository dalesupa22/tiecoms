/** Heavy WhatsApp protocol/download code is loaded only by the dedicated bridge. */
import {createHash,randomUUID} from 'node:crypto';
import {downloadMediaMessage,normalizeMessageContent,type WASocket,type WAMessage} from 'baileys';
import {MAX_ATTACHMENT_BYTES,MAX_VOICE_MS} from '@tiecoms/contracts';
import {pool} from '../db.ts';
import {objectKey,putObject,deleteObject} from '../storage.ts';
import {imageSize,sniffAudio,sniffImage} from './attachments.ts';
import {openWa} from './wa-sync.ts';
import type {MediaInfo} from './wa-media.ts';

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

