import { useEffect, useState } from 'react';
import type { InvitationPreviewDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, t } from '../i18n.ts';
import { asset, navigate } from '../router.ts';
import { InvitePreviewText } from './Groups.tsx';

export function InviteScreen({ token }: { token: string }) {
  const status = useClient((s) => s.status);
  const me = useClient((s) => s.data?.me);
  const [inv, setInv] = useState<InvitationPreviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { client.previewInvitation(token).then(setInv).catch((e) => setError(errorText(e))); }, [token]);

  async function accept() {
    setBusy(true);
    try {
      const r = await client.acceptInvitation(token);
      navigate(r.conversationIds[0] ? `/c/${r.conversationIds[0]}` : `/w/${r.workspaceId}`, true);
    } catch (e: any) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const next = `/invite/${encodeURIComponent(token)}`;

  return (
    <div className="auth">
      <div className="auth-card">
        <img src={asset('/tiecoms-logo.svg')} alt="TieComs" width={220} height={65} />
        {error && <div className="error">{error}</div>}
        {!inv && !error && <div className="muted">{t('common.loading')}</div>}
        {inv && (
          <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="eyebrow">{t('invite.title')}</div>
            <InvitePreviewText inv={inv} />
            {inv.email && <div className="hint">{t('invite.forEmail', { email: inv.email })}</div>}
            {!inv.valid && <div className="error">{t('invite.invalid')}</div>}
            {inv.valid && status === 'ready' && (
              <>
                <div className="hint">{t('invite.as', { name: me?.name ?? '' })}</div>
                <button className="btn primary" disabled={busy} onClick={accept}>{busy ? t('invite.accepting') : t('invite.accept')}</button>
              </>
            )}
            {inv.valid && status === 'anonymous' && (
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="btn primary" onClick={() => navigate(`/signup?next=${encodeURIComponent(next)}`)}>{t('auth.createAccount')}</button>
                <button className="btn" onClick={() => navigate(`/login?next=${encodeURIComponent(next)}`)}>{t('invite.have')}</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
