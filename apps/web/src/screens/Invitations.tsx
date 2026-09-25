import { useEffect, useState } from 'react';
import type { PendingInvitationDTO } from '@tiecoms/contracts';
import { client } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';

type Scope = 'organizations' | 'workspaces';

/** Resultado de enviar una invitación: confirma el correo o, si no salió, deja el enlace a mano. */
export function InviteResult({ email, emailSent, link }: { email: string; emailSent: boolean; link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {emailSent
        ? <div><b>{t('dlg.emailSent', { email })}</b></div>
        : <div className="error">{t('dlg.emailFailed', { email })}</div>}
      <div className="small muted">{emailSent ? t('dlg.linkBackup') : t('dlg.linkShare')}</div>
      <div className="linkbox">
        <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} />
        <button className="btn" onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true); }}>{copied ? t('common.copied') : t('common.copy')}</button>
      </div>
    </div>
  );
}

const fmt = (iso: string) => new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Invitaciones con correo sin aceptar: estado del envío, reenviar y revocar. `reload` cambia para volver a pedirlas. */
export function PendingInvitations({ scope, id, reload = 0 }: { scope: Scope; id: string; reload?: number }) {
  const [items, setItems] = useState<PendingInvitationDTO[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; bad?: boolean } | null>(null);
  const load = () => client.listInvitations(scope, id).then(setItems).catch(() => setItems([]));
  useEffect(() => { void load(); }, [scope, id, reload]);

  async function resend(inv: PendingInvitationDTO) {
    setBusy(inv.id); setNote(null);
    try {
      const r = await client.resendInvitation(scope, id, inv.id);
      setNote(r.emailSent ? { id: inv.id, text: t('inv.resent') } : { id: inv.id, text: t('dlg.emailFailed', { email: inv.email }), bad: true });
      await load();
    } catch (e) { setNote({ id: inv.id, text: errorText(e), bad: true }); } finally { setBusy(null); }
  }
  async function revoke(inv: PendingInvitationDTO) {
    if (!confirm(t('inv.revokeConfirm', { email: inv.email }))) return;
    setBusy(inv.id); setNote(null);
    try { await client.revokeInvitation(scope, id, inv.id); await load(); }
    catch (e) { setNote({ id: inv.id, text: errorText(e), bad: true }); } finally { setBusy(null); }
  }

  if (!items?.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="eyebrow">{t('inv.pending')} · {items.length}</div>
      <div className="list">
        {items.map((inv) => {
          const status = inv.expired ? t('inv.expired')
            : inv.emailStatus === 'sent' && inv.emailSentAt ? t('inv.sentAt', { date: fmt(inv.emailSentAt) })
            : t('inv.notSent');
          const warn = inv.expired || inv.emailStatus !== 'sent';
          return (
            <div key={inv.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <b style={{ wordBreak: 'break-all' }}>{inv.email}</b>
                  <span className="small muted"> · {t('inv.by', { name: inv.invitedByName })}</span>
                  <div className="small" style={{ color: warn ? 'var(--danger)' : undefined }}>
                    {status}{inv.sendCount > 1 ? ` · ${t('inv.times', { n: inv.sendCount })}` : ''}
                  </div>
                </span>
                {inv.canManage && (
                  <>
                    <button className="btn" disabled={busy === inv.id} onClick={() => resend(inv)}>{t('inv.resend')}</button>
                    <button className="btn ghost" disabled={busy === inv.id} onClick={() => revoke(inv)}>{t('inv.revoke')}</button>
                  </>
                )}
              </div>
              {note?.id === inv.id && <div className={note.bad ? 'error' : 'small'}>{note.text}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
