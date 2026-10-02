/** User-invoked calendar proposals. No message or AI suggestion executes a booking. */
import { z } from 'zod';
import { conversationAccess } from '../access.ts';
import { pool } from '../db.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { busyIntervals, connectedCalendar } from './booking-calendars.ts';
import { createMeeting } from './meetings.ts';
import { ownChat } from './whatsapp.ts';

const sourceFields={source:z.string().max(500),messageIds:z.array(z.string().min(1).max(200)).max(30).optional()};
export const CalendarSlotsInput=z.object({...sourceFields,from:z.iso.datetime({offset:true}),to:z.iso.datetime({offset:true}),durationMin:z.number().int().min(15).max(240),timezone:z.string().min(1).max(64)});
export const CalendarConfirmInput=z.object({...sourceFields,provider:z.enum(['google','microsoft']),idempotencyKey:z.string().min(8).max(80),title:z.string().trim().min(2).max(200),startsAt:z.iso.datetime({offset:true}),endsAt:z.iso.datetime({offset:true}),timezone:z.string().min(1).max(64),conversationId:z.uuid().nullable().optional(),shareToChat:z.boolean().default(false),description:z.string().trim().max(4000).optional(),attendeeEmails:z.array(z.email().max(254)).max(20).optional(),inviteeIds:z.array(z.uuid()).max(20).optional()});

async function authorize(userId:string,source:string,ids:string[]=[]){
  if(source.startsWith('c:')) {
    const id=z.uuid().parse(source.slice(2));const access=await conversationAccess(pool,userId,id,'read');
    if(ids.length) {const parsed=ids.map((i)=>z.uuid().parse(i));const r=await pool.query('SELECT id FROM messages WHERE conversation_id=$1 AND id=ANY($2::uuid[]) AND seq>$3 AND deleted_at IS NULL AND NOT view_once',[id,parsed,access.historyFromSeq]);if(r.rowCount!==new Set(ids).size) throw notFound('Mensajes seleccionados');}
    return id;
  }
  if(source.startsWith('wa:')) {
    const sep=source.indexOf(':',3),accountId=z.uuid().parse(source.slice(3,sep)),jid=source.slice(sep+1);
    await ownChat(userId,accountId,jid);
    if(ids.length) {const r=await pool.query('SELECT id FROM wa_messages WHERE account_id=$1 AND chat_jid=$2 AND id=ANY($3::text[])',[accountId,jid,ids]);if(r.rowCount!==new Set(ids).size) throw notFound('Mensajes seleccionados');}
    return null;
  }
  throw badRequest('Fuente de calendario inválida');
}
async function ownAgendaBusy(userId:string,from:string,to:string):Promise<[number,number][]> {
  const r=await pool.query(`SELECT e.starts_at,e.ends_at FROM calendar_events e WHERE e.cancelled_at IS NULL AND e.starts_at<$3 AND e.ends_at>$2
    AND (e.organizer_id=$1 OR EXISTS(SELECT 1 FROM calendar_event_invitees i WHERE i.event_id=e.id AND i.user_id=$1 AND i.rsvp<>'no'))`,[userId,from,to]);
  return r.rows.map((e)=>[new Date(e.starts_at).getTime(),new Date(e.ends_at).getTime()]);
}
function zone(tz:string){try{new Intl.DateTimeFormat('en',{timeZone:tz});}catch{throw badRequest('Zona horaria inválida');}}
export async function calendarSlots(userId:string,input:z.infer<typeof CalendarSlotsInput>){
  await authorize(userId,input.source,input.messageIds);zone(input.timezone);
  const from=Date.parse(input.from),to=Date.parse(input.to);
  if(to<=from || to-from>31*86400_000) throw badRequest('Elige un rango de hasta 31 días');
  const provider=await busyIntervals(userId,from,to,input.timezone,true),checkedAt=new Date().toISOString();
  if(provider.state!=='ok') return {status:provider.state==='none' ? 'needs_connect' : provider.state,provider:'provider' in provider ? provider.provider : null,checkedAt:null,timezone:input.timezone,slots:[]};
  const busy=[...provider.intervals,...await ownAgendaBusy(userId,input.from,input.to)],duration=input.durationMin*60_000,step=15*60_000;
  const slots:{startsAt:string;endsAt:string}[]=[];
  for(let at=Math.ceil(Math.max(from,Date.now()+5*60_000)/step)*step;at+duration<=to && slots.length<3;at+=step) if(!busy.some(([a,b])=>a<at+duration && b>at)) {slots.push({startsAt:new Date(at).toISOString(),endsAt:new Date(at+duration).toISOString()});at+=duration-step;}
  return {status:'ready' as const,provider:provider.provider,calendar:'primary' as const,scope:'owned-primary-and-chaggu' as const,checkedAt,timezone:input.timezone,slots};
}
export async function confirmCalendar(userId:string,input:z.infer<typeof CalendarConfirmInput>){
  const sourceConversation=await authorize(userId,input.source,input.messageIds);zone(input.timezone);
  const durationMin=(Date.parse(input.endsAt)-Date.parse(input.startsAt))/60_000;
  if(!Number.isInteger(durationMin)||durationMin<15||durationMin>240) throw badRequest('Duración inválida');
  const conversationId=input.conversationId ?? sourceConversation;
  if(input.shareToChat && !conversationId) throw badRequest('Elige el chat al que compartir');
  if(conversationId) await conversationAccess(pool,userId,conversationId,'post');
  // IDs are deliberately selected conversation members; email addresses are deliberately captured dialog fields.
  if(input.inviteeIds?.length) {
    if(!conversationId) throw badRequest('Elige un chat para los asistentes de Chaggu');
    const members=await pool.query('SELECT user_id FROM conversation_memberships WHERE conversation_id=$1 AND removed_at IS NULL AND user_id=ANY($2::uuid[])',[conversationId,input.inviteeIds]);
    if(members.rowCount!==new Set(input.inviteeIds).size) throw badRequest('Los invitados deben participar en la conversación');
  }
  const inputMeeting={provider:input.provider,idempotencyKey:input.idempotencyKey,title:input.title,startsAt:input.startsAt,durationMin,timezone:input.timezone,conversationId,share:input.shareToChat,description:input.description,attendeeEmails:[...new Set(input.attendeeEmails ?? [])],inviteeIds:input.inviteeIds ?? (input.shareToChat ? [] : undefined)};
  // A connection-level advisory lock serializes our own confirmations without holding a SQL transaction over network I/O.
  const lock=await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('gg-calendar:'||$1))",[userId]);
    const previous=(await pool.query('SELECT id,status,operation_state FROM meetings WHERE user_id=$1 AND idempotency_key=$2',[userId,input.idempotencyKey])).rows[0];
    let expectedGeneration:string|undefined;
    if(!previous || previous.operation_state==='reserved') {
      const connection=await connectedCalendar(userId);if(connection.provider!==input.provider) throw new ApiError(409,'calendar_connect_required','Conecta o vuelve a autorizar el calendario elegido');
      const now=await busyIntervals(userId,Date.parse(input.startsAt),Date.parse(input.endsAt),input.timezone,true);
      if(now.state!=='ok') throw new ApiError(409,'calendar_unverified','No se pudo comprobar tu calendario. No se ha creado la reunión.');
      expectedGeneration=now.generation;
      const busy=[...now.intervals,...await ownAgendaBusy(userId,input.startsAt,input.endsAt)];
      if(busy.some(([a,b])=>a<Date.parse(input.endsAt)&&b>Date.parse(input.startsAt))) throw new ApiError(409,'calendar_conflict','Este horario ya está ocupado. Actualiza las opciones.');
    }
    return await createMeeting(userId,inputMeeting,expectedGeneration);
  } finally {await lock.query("SELECT pg_advisory_unlock(hashtext('gg-calendar:'||$1))",[userId]).catch(()=>{});lock.release();}
}
