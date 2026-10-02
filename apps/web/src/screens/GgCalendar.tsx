import { useEffect, useRef, useState } from 'react';
import { client } from '../app-client.ts';
import { errorText, locale } from '../i18n.ts';
import { Modal } from '../ui.tsx';
import { navigate } from '../router.ts';
import './GgMail.css';

type Slot = { startsAt: string; endsAt: string };
type Slots = { status: 'ready' | 'needs_connect' | 'reconnect' | 'error' | 'needs_clarification'; provider: 'google' | 'microsoft' | null; checkedAt: string | null; timezone: string; slots: Slot[] };
const tr = (es: string, en: string) => locale().startsWith('en') ? en : es;
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
function nextWeek() { const d=new Date();d.setDate(d.getDate()+((8-d.getDay())%7 || 7));return d; }
/** Lo que gg prepara desde el chat (POST /gg/meeting-draft): nada se agenda hasta «Confirmar y agendar». */
type Draft = { title: string; durationMin: number; attendeeEmails: string[]; invitees: { id: string; name: string }[]; missingPeople: string[]; links: string[]; description: string };
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
  const [invitees,setInvitees]=useState<{ id: string; name: string }[]>([]),[draft,setDraft]=useState<Draft|null|'loading'>('loading');
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  // 2-oct-2026: gg llena el formulario con el chat (título, quiénes, correos escritos y enlaces) y busca horarios. Si gg no
  // puede (sin permiso de IA, sin red), el formulario queda vacío como antes.
  useEffect(() => { let on = true;
    void client.request<Draft>('/gg/meeting-draft',{method:'POST',json:{source,messageIds}}).then((d)=>{ if(!on) return;
      setDraft(d); setTitle(d.title); setMinutes(d.durationMin); setEmails(d.attendeeEmails.join(', ')); setDescription(d.description); setInvitees(d.invitees);
      void search(d.durationMin);
    }).catch(()=>{ if(on) setDraft(null); });
    return () => { on = false; }; }, []);
  const format=(iso:string)=>new Date(iso).toLocaleString(locale(),{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:timezone});
  const search=async(duration=minutes)=>{
    if(busy)return;setBusy(true);setError(null);setResult(null);setChosen(null);setSaved(false);
    try { if (endHour<=startHour) throw new Error(tr('La hora final debe ser posterior a la inicial.','End time must be after start time.')); const start=new Date(`${from}T00:00:00`), end=new Date(`${to}T23:59:59`); if(!Number.isFinite(start.getTime())||end<=start||end.getTime()-start.getTime()>31*86400000)throw new Error(tr('Elige un rango de hasta 31 días.','Choose a range up to 31 days.'));
      setResult(await client.request<Slots>('/gg/calendar/slots',{method:'POST',json:{source,messageIds,from:start.toISOString(),to:end.toISOString(),durationMin:duration,timezone,startHour,endHour}}));
    } catch(e){setError(errorText(e));} finally{setBusy(false);}
  };
  const save=async()=>{
    if(busy||!chosen||!result?.provider||!title.trim())return;setBusy(true);setError(null);
    try{const attendeeEmails=[...new Set(emails.split(/[;,\s]+/).map((e)=>e.trim()).filter(Boolean))]; if(attendeeEmails.length>20||attendeeEmails.some((email)=>!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)))throw new Error(tr('Revisa los correos de los invitados (máximo 20).','Check guest email addresses (up to 20).')); await client.request('/gg/calendar/confirm',{method:'POST',json:{source,messageIds,provider:result.provider,idempotencyKey:idempotency.current,title:title.trim(),description:description.trim()||undefined,attendeeEmails,...(invitees.length&&source.startsWith('c:')?{inviteeIds:invitees.map((p)=>p.id)}:{}),...chosen,timezone,shareToChat:false}});setSaved(true);}
    catch(e){setError(errorText(e));}finally{setBusy(false);}
  };
  return <Modal title={tr('Horarios libres y agenda','Availability and scheduling')} onClose={onClose}>
    <p className="small muted">{tr('Consulta tu calendario principal conectado y tu agenda de Chaggu.','Checks your connected primary calendar and Chaggu agenda.')} · {timezone}</p>
    {draft==='loading' && <p className="small muted" role="status">✨ {tr('gg está preparando la reunión con lo que se habló…','gg is preparing the meeting from the chat…')}</p>}
    {draft && draft!=='loading' && <div className="gg-draft-note small" role="status">✨ {tr('gg lo preparó con el chat. Revisa todo: nada se agenda hasta que confirmes.','gg prepared this from the chat. Review everything: nothing is scheduled until you confirm.')}
      {draft.missingPeople.length>0 && <div>⚠ {tr('No encontré en el chat a','Not found in the chat')}: <b>{draft.missingPeople.join(', ')}</b>. {tr('Escribe su correo en invitados si quieres incluirlos.','Type their email under guests to include them.')}</div>}
      {draft.links.length>0 && <div>🔗 {tr('Enlaces en la descripción','Links in the description')}: {draft.links.map((l)=><a key={l} href={l} target="_blank" rel="noopener noreferrer" className="gg-draft-link">{l.replace(/^https?:\/\//,'').slice(0,40)}</a>)}</div>}
    </div>}
    <div className="gg-meeting-fields"><label className="field"><span>{tr('Título de la reunión','Meeting title')}</span><input className="input" value={title} maxLength={200} onChange={(e)=>setTitle(e.target.value)} /></label>{invitees.length>0&&<div className="field"><span>{tr('Del chat (reciben la invitación en chaggu)','From the chat (invited in chaggu)')}</span><div className="row" style={{flexWrap:'wrap',gap:6}}>{invitees.map((p)=><span key={p.id} className="chip gg-invitee">{p.name}<button className="link-btn" aria-label={tr('Quitar','Remove')} onClick={()=>setInvitees((l)=>l.filter((x)=>x.id!==p.id))}>×</button></span>)}</div></div>}<label className="field"><span>{tr('Invitados (correos separados por coma)','Guests (comma-separated emails)')}</span><input className="input" type="text" inputMode="email" value={emails} maxLength={2000} onChange={(e)=>setEmails(e.target.value)} /></label><label className="field"><span>{tr('Descripción (opcional)','Description (optional)')}</span><textarea className="input" value={description} maxLength={4000} rows={3} onChange={(e)=>setDescription(e.target.value)} /></label></div>
    <div className="row" style={{flexWrap:'wrap'}}>
      <label className="field"><span>{tr('Desde','From')}</span><input className="input" type="date" value={from} onChange={(e)=>{setFrom(e.target.value);setResult(null);setChosen(null);}} /></label>
      <label className="field"><span>{tr('Hasta','Until')}</span><input className="input" type="date" value={to} onChange={(e)=>{setTo(e.target.value);setResult(null);setChosen(null);}} /></label>
      <label className="field"><span>{tr('Duración','Duration')}</span><select className="input" value={minutes} onChange={(e)=>{setMinutes(+e.target.value);setResult(null);setChosen(null);}}>{[...new Set([15,30,45,60,90,120,minutes])].sort((a,b)=>a-b).map((m)=><option key={m} value={m}>{m} min</option>)}</select></label>
    </div>
    <div className="row" style={{flexWrap:'wrap'}}><label className="field"><span>{tr('Cada día desde','Each day from')}</span><select className="input" value={startHour} onChange={(e)=>{setStartHour(+e.target.value);setResult(null);setChosen(null);}}>{Array.from({length:24},(_,h)=><option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>)}</select></label><label className="field"><span>{tr('Hasta','Until')}</span><select className="input" value={endHour} onChange={(e)=>{setEndHour(+e.target.value);setResult(null);setChosen(null);}}>{Array.from({length:24},(_,i)=>i+1).map((h)=><option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>)}</select></label></div>
    <button className="btn" disabled={busy} onClick={()=>void search()}>{busy ? tr('Consultando…','Checking…') : tr('Buscar horarios libres','Find available times')}</button>
    {result?.status==='ready' && <div className="list" style={{marginTop:12}}><p className="small muted">{tr('Calendario consultado','Calendar checked')}: {result.checkedAt ? format(result.checkedAt) : ''}</p>
      {!result.slots.length && <p>{tr('No encontré horarios libres en este rango.','No available times found in this range.')}</p>}
      {result.slots.map((s)=><button key={s.startsAt} className={`btn ${chosen?.startsAt===s.startsAt?'primary':''}`} onClick={()=>{setChosen(s);setSaved(false);idempotency.current=crypto.randomUUID();}}>{format(s.startsAt)} – {new Date(s.endsAt).toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit'})}</button>)}
    </div>}
    {result && result.status!=='ready' && <div role="status"><p>{tr('No pude verificar tu disponibilidad. Conecta o revisa el calendario antes de elegir un horario.','Could not verify availability. Connect or check your calendar before choosing a time.')}</p><button className="btn" onClick={()=>{onClose();navigate('/ajustes');}}>{tr('Revisar conexión','Check connection')}</button></div>}
    {chosen&&!saved&&<div className="card" style={{padding:12,marginTop:12}}><b>{format(chosen.startsAt)} · {timezone}</b><p className="small muted">{title.trim() ? <>«{title.trim()}» · {minutes} min{invitees.length ? ` · ${invitees.map((p)=>p.name).join(', ')}` : ''}{emails.trim() ? ` · ${emails}` : ''}</> : tr('Escribe el título arriba.','Type the title above.')}</p><button className="btn primary" disabled={busy||!title.trim()} onClick={()=>void save()}>{tr('Confirmar y agendar','Confirm and schedule')}</button></div>}
    {saved&&<p role="status">✓ {tr('Reunión guardada en tu calendario.','Meeting saved to your calendar.')}</p>}
    {error&&<div className="error" role="alert">{error}</div>}
  </Modal>;
}
