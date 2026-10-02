import { useRef, useState } from 'react';
import { client } from '../app-client.ts';
import { errorText, locale } from '../i18n.ts';
import { Modal } from '../ui.tsx';
import { navigate } from '../router.ts';

type Slot = { startsAt: string; endsAt: string };
type Slots = { status: 'ready' | 'needs_connect' | 'reconnect' | 'error' | 'needs_clarification'; provider: 'google' | 'microsoft' | null; checkedAt: string | null; timezone: string; slots: Slot[] };
const tr = (es: string, en: string) => locale().startsWith('en') ? en : es;
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
function nextWeek() { const d=new Date();d.setDate(d.getDate()+((8-d.getDay())%7 || 7));return d; }
/** Availability is read only on request; saving is a separate, idempotent explicit action. */
export function GgCalendarDialog({ source, messageIds, onClose }: { source: string; messageIds: string[]; onClose: () => void }) {
  const [from, setFrom]=useState(()=>day(nextWeek()));
  const [to, setTo]=useState(()=>{const d=nextWeek();d.setDate(d.getDate()+4);return day(d);});
  const [minutes,setMinutes]=useState(60), [title,setTitle]=useState('');
  const [emails,setEmails]=useState(''),[description,setDescription]=useState('');
  const [startHour,setStartHour]=useState(9),[endHour,setEndHour]=useState(18);
  const [result,setResult]=useState<Slots|null>(null), [chosen,setChosen]=useState<Slot|null>(null);
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false);
  const idempotency = useRef(crypto.randomUUID());
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const format=(iso:string)=>new Date(iso).toLocaleString(locale(),{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:timezone});
  const search=async()=>{
    if(busy)return;setBusy(true);setError(null);setResult(null);setChosen(null);setSaved(false);
    try { if (endHour<=startHour) throw new Error(tr('La hora final debe ser posterior a la inicial.','End time must be after start time.')); const start=new Date(`${from}T00:00:00`), end=new Date(`${to}T23:59:59`); if(!Number.isFinite(start.getTime())||end<=start||end.getTime()-start.getTime()>31*86400000)throw new Error(tr('Elige un rango de hasta 31 días.','Choose a range up to 31 days.'));
      setResult(await client.request<Slots>('/gg/calendar/slots',{method:'POST',json:{source,messageIds,from:start.toISOString(),to:end.toISOString(),durationMin:minutes,timezone,startHour,endHour}}));
    } catch(e){setError(errorText(e));} finally{setBusy(false);}
  };
  const save=async()=>{
    if(busy||!chosen||!result?.provider||!title.trim())return;setBusy(true);setError(null);
    try{const attendeeEmails=[...new Set(emails.split(/[;,\s]+/).map((e)=>e.trim()).filter(Boolean))]; if(attendeeEmails.length>20||attendeeEmails.some((email)=>!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)))throw new Error(tr('Revisa los correos de los invitados (máximo 20).','Check guest email addresses (up to 20).')); await client.request('/gg/calendar/confirm',{method:'POST',json:{source,messageIds,provider:result.provider,idempotencyKey:idempotency.current,title:title.trim(),description:description.trim()||undefined,attendeeEmails,...chosen,timezone,shareToChat:false}});setSaved(true);}
    catch(e){setError(errorText(e));}finally{setBusy(false);}
  };
  return <Modal title={tr('Horarios libres y agenda','Availability and scheduling')} onClose={onClose}>
    <p className="small muted">{tr('Consulta tu calendario principal conectado y tu agenda de Chaggu.','Checks your connected primary calendar and Chaggu agenda.')} · {timezone}</p>
    <div className="row" style={{flexWrap:'wrap'}}>
      <label className="field"><span>{tr('Desde','From')}</span><input className="input" type="date" value={from} onChange={(e)=>{setFrom(e.target.value);setResult(null);setChosen(null);}} /></label>
      <label className="field"><span>{tr('Hasta','Until')}</span><input className="input" type="date" value={to} onChange={(e)=>{setTo(e.target.value);setResult(null);setChosen(null);}} /></label>
      <label className="field"><span>{tr('Duración','Duration')}</span><select className="input" value={minutes} onChange={(e)=>{setMinutes(+e.target.value);setResult(null);setChosen(null);}}>{[15,30,45,60,90,120].map((m)=><option key={m} value={m}>{m} min</option>)}</select></label>
    </div>
    <div className="row" style={{flexWrap:'wrap'}}><label className="field"><span>{tr('Cada día desde','Each day from')}</span><select className="input" value={startHour} onChange={(e)=>{setStartHour(+e.target.value);setResult(null);setChosen(null);}}>{Array.from({length:24},(_,h)=><option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>)}</select></label><label className="field"><span>{tr('Hasta','Until')}</span><select className="input" value={endHour} onChange={(e)=>{setEndHour(+e.target.value);setResult(null);setChosen(null);}}>{Array.from({length:24},(_,i)=>i+1).map((h)=><option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>)}</select></label></div>
    <button className="btn" disabled={busy} onClick={()=>void search()}>{busy ? tr('Consultando…','Checking…') : tr('Buscar horarios libres','Find available times')}</button>
    {result?.status==='ready' && <div className="list" style={{marginTop:12}}><p className="small muted">{tr('Calendario consultado','Calendar checked')}: {result.checkedAt ? format(result.checkedAt) : ''}</p>
      {!result.slots.length && <p>{tr('No encontré horarios libres en este rango.','No available times found in this range.')}</p>}
      {result.slots.map((s)=><button key={s.startsAt} className={`btn ${chosen?.startsAt===s.startsAt?'primary':''}`} onClick={()=>{setChosen(s);setSaved(false);idempotency.current=crypto.randomUUID();}}>{format(s.startsAt)} – {new Date(s.endsAt).toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit'})}</button>)}
    </div>}
    {result && result.status!=='ready' && <div role="status"><p>{tr('No pude verificar tu disponibilidad. Conecta o revisa el calendario antes de elegir un horario.','Could not verify availability. Connect or check your calendar before choosing a time.')}</p><button className="btn" onClick={()=>{onClose();navigate('/ajustes');}}>{tr('Revisar conexión','Check connection')}</button></div>}
    {chosen&&!saved&&<div className="card" style={{padding:12,marginTop:12}}><b>{format(chosen.startsAt)} · {timezone}</b><p className="small muted">{tr('Confirma el título y los correos de quienes quieres invitar.','Confirm the title and email addresses of the people you want to invite.')}</p><label className="field"><span>{tr('Título de la reunión','Meeting title')}</span><input className="input" value={title} maxLength={200} onChange={(e)=>setTitle(e.target.value)} /></label><label className="field"><span>{tr('Invitados (correos separados por coma)','Guests (comma-separated emails)')}</span><input className="input" type="text" inputMode="email" value={emails} maxLength={2000} onChange={(e)=>setEmails(e.target.value)} /></label><label className="field"><span>{tr('Descripción (opcional)','Description (optional)')}</span><textarea className="input" value={description} maxLength={4000} rows={3} onChange={(e)=>setDescription(e.target.value)} /></label><button className="btn primary" disabled={busy||!title.trim()} onClick={()=>void save()}>{tr('Confirmar y agendar','Confirm and schedule')}</button></div>}
    {saved&&<p role="status">✓ {tr('Reunión guardada en tu calendario.','Meeting saved to your calendar.')}</p>}
    {error&&<div className="error" role="alert">{error}</div>}
  </Modal>;
}
