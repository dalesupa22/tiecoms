/**
 * gg redacta un correo con el chat y la persona lo revisa (API: gg-actions.ts). Pedido de Danny, 2-oct-2026: «siempre
 * pidiendo confirmación». Nada sale sin tocar «Enviar» y confirmar; la clave evita que salga dos veces.
 * Destinatarios: gg solo propone correos que estén escritos en el chat (chaggu no revela el correo de nadie).
 */
import { useEffect, useRef, useState } from 'react';
import { client } from '../app-client.ts';
import { errorText, locale } from '../i18n.ts';
import { navigate } from '../router.ts';
import { Modal } from '../ui.tsx';
import { toast } from '../menu.tsx';
import './GgMail.css';

type Draft = { provider: 'google' | 'microsoft' | null; from: string | null; status: 'ready' | 'needs_connect'; to: string[]; cc: string[]; missingPeople: string[]; subject: string; body: string };
const tr = (es: string, en: string) => (locale().startsWith('en') ? en : es);
const parse = (s: string) => [...new Set(s.split(/[;,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
const valid = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

export function GgMailDialog({ source, messageIds, instruction, onClose }: { source: string; messageIds: string[]; instruction?: string; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft | null | 'loading'>('loading');
  const [to, setTo] = useState(''), [cc, setCc] = useState(''), [subject, setSubject] = useState(''), [body, setBody] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [sent, setSent] = useState(false);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    let on = true;
    void client.request<Draft>('/gg/mail-draft', { method: 'POST', json: { source, messageIds, ...(instruction ? { instruction } : {}) } })
      .then((d) => { if (!on) return; setDraft(d); setTo(d.to.join(', ')); setCc(d.cc.join(', ')); setSubject(d.subject); setBody(d.body); })
      .catch((e) => { if (on) { setDraft(null); setError(errorText(e)); } });
    return () => { on = false; };
  }, []);
  const ready = draft && draft !== 'loading' && draft.status === 'ready' && draft.provider;
  const toList = parse(to), ccList = parse(cc);
  const bad = [...toList, ...ccList].filter((e) => !valid(e));
  const send = async () => {
    if (!ready || busy || sent) return;
    if (!toList.length || bad.length || !subject.trim() || !body.trim()) { setError(bad.length ? tr(`Revisa: ${bad.join(', ')}`, `Check: ${bad.join(', ')}`) : tr('Falta destinatario, asunto o texto.', 'Missing recipient, subject or text.')); return; }
    // La confirmación explícita: a quién y desde qué cuenta.
    if (!confirm(tr(`¿Enviar este correo desde ${draft.from ?? 'tu correo'} a ${toList.join(', ')}${ccList.length ? ` (copia: ${ccList.join(', ')})` : ''}?`, `Send this email from ${draft.from ?? 'your mailbox'} to ${toList.join(', ')}${ccList.length ? ` (cc: ${ccList.join(', ')})` : ''}?`))) return;
    setBusy(true); setError(null);
    try {
      await client.request('/gg/mail-send', { method: 'POST', json: { source, provider: draft.provider, idempotencyKey: key.current, to: toList, cc: ccList, subject: subject.trim(), body: body.trim() } });
      setSent(true); toast(tr('Correo enviado', 'Email sent'));
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  // Si cambia lo que se va a enviar, es otro correo: otra clave.
  const edit = (f: (v: string) => void) => (e: { target: { value: string } }) => { f(e.target.value); key.current = crypto.randomUUID(); };
  return (
    <Modal title={tr('Correo con gg', 'Email with gg')} onClose={onClose}>
      {draft === 'loading' && <p className="small muted" role="status">✨ {tr('gg está redactando el correo con lo que se habló…', 'gg is drafting the email from the chat…')}</p>}
      {draft && draft !== 'loading' && draft.status === 'needs_connect' && <div role="status"><p>{tr('Conecta tu Gmail u Outlook para enviar correos desde chaggu.', 'Connect Gmail or Outlook to send email from chaggu.')}</p><button className="btn" onClick={() => { onClose(); navigate('/correo'); }}>{tr('Conectar correo', 'Connect email')}</button></div>}
      {ready && !sent && <>
        <div className="gg-draft-note small">✨ {tr('gg lo redactó con el chat. Revísalo y edítalo: no se envía hasta que toques «Enviar» y confirmes.', 'gg drafted this from the chat. Review and edit it: nothing is sent until you tap “Send” and confirm.')}
          {draft.missingPeople.length > 0 && <div>⚠ {tr('No veo el correo de', 'No email visible for')} <b>{draft.missingPeople.join(', ')}</b>. {tr('Escríbelo si quieres incluirlos.', 'Type it to include them.')}</div>}
        </div>
        <div className="gg-mail-from small muted">{tr('Desde', 'From')}: <b>{draft.from ?? (draft.provider === 'google' ? 'Gmail' : 'Outlook')}</b></div>
        <label className="field"><span>{tr('Para', 'To')}</span><input className="input" inputMode="email" value={to} maxLength={2000} onChange={edit(setTo)} placeholder="correo@empresa.com" /></label>
        <label className="field"><span>{tr('Copia', 'Cc')}</span><input className="input" inputMode="email" value={cc} maxLength={2000} onChange={edit(setCc)} /></label>
        <label className="field"><span>{tr('Asunto', 'Subject')}</span><input className="input" value={subject} maxLength={300} onChange={edit(setSubject)} /></label>
        <label className="field"><span>{tr('Mensaje', 'Message')}</span><textarea className="input gg-mail-body" rows={9} value={body} maxLength={20000} onChange={edit(setBody)} /></label>
        <div className="row"><span className="grow" /><button className="btn" onClick={onClose}>{tr('Cancelar', 'Cancel')}</button><button className="btn primary" disabled={busy || !toList.length} onClick={() => void send()}>{busy ? tr('Enviando…', 'Sending…') : tr('Enviar', 'Send')}</button></div>
      </>}
      {sent && <p role="status">✓ {tr('Enviado. Queda en tus Enviados.', 'Sent. It is in your Sent folder.')}</p>}
      {error && <div className="error" role="alert">{error}</div>}
    </Modal>
  );
}
