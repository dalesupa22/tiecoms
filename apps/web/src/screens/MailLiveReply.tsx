import { useState } from 'react';
import type { MailMessageDTO, MailProvider } from '@tiecoms/contracts';
import { client } from '../app-client.ts';
import { errorText, t } from '../i18n.ts';
import { toast } from '../menu.tsx';

/** Replies directly to the connected mailbox; no shared chat is needed. */
export function MailLiveReply({ provider, id, m, onSent }: { provider: MailProvider; id: string; m: MailMessageDTO; onSent?: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const recipients = m.box === 'sent' ? m.to : m.from ? [m.from] : [];
  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await client.replyLiveMail(provider, id, { body: text.trim() });
      toast(t('grid.replySent')); setText(''); setOpen(false); onSent?.();
    } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  }
  if (!open) return <button className="btn primary small" onClick={() => setOpen(true)} disabled={!recipients.length}>{t('grid.replyOpen')}</button>;
  return <div className="reply-box">
    <div className="small muted">{t('grid.replyTo', { to: recipients.map((a) => a.name || a.email).join(', ') })}</div>
    <textarea className="input" autoFocus rows={5} maxLength={20000} placeholder={t('grid.replyPh')} value={text} onChange={(e) => setText(e.target.value)} />
    <div className="row" style={{ justifyContent: 'flex-end' }}>
      <button className="btn ghost small" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</button>
      <button className="btn primary small" disabled={!text.trim() || busy} onClick={() => void send()}>{t(busy ? 'grid.replySending' : 'grid.replySend')}</button>
    </div>
  </div>;
}
