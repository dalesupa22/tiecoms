import { useEffect, useState } from 'react';
import type { InvitationPreviewDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { asset, navigate } from '../router.ts';

const ROLE: Record<string, string> = { member: 'participante', admin: 'administración', guest: 'tercero invitado', lead: 'líder' };

export function InviteScreen({ token }: { token: string }) {
  const status = useClient((s) => s.status);
  const me = useClient((s) => s.data?.me);
  const [inv, setInv] = useState<InvitationPreviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { client.previewInvitation(token).then(setInv).catch((e) => setError(e.message)); }, [token]);

  async function accept() {
    setBusy(true);
    try {
      const r = await client.acceptInvitation(token);
      navigate(r.conversationIds[0] ? `/c/${r.conversationIds[0]}` : `/w/${r.workspaceId}`, true);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  const next = `/invite/${encodeURIComponent(token)}`;

  return (
    <div className="auth">
      <div className="auth-card">
        <img src={asset("/tiecoms-logo.svg")} alt="TieComs" width={220} height={65} />
        {error && <div className="error">{error}</div>}
        {!inv && !error && <div className="muted">Cargando invitación…</div>}
        {inv && (
          <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="eyebrow">Invitación</div>
            <div className="serif" style={{ fontSize: 30, lineHeight: 1.1 }}>{inv.workspaceName}</div>
            <div className="muted">{inv.invitedByName}{inv.invitedByOrg ? ` · ${inv.invitedByOrg}` : ''} te invita como <b>{ROLE[inv.role] ?? inv.role}</b>.</div>
            {inv.email && <div className="hint">Esta invitación es para {inv.email}.</div>}
            {!inv.valid && <div className="error">La invitación ya fue usada, se revocó o venció.</div>}
            {inv.valid && status === 'ready' && (
              <>
                <div className="hint">Entrarás como {me?.name}. Tu empresa conserva su identidad: nadie es "invitado" en la casa de otro.</div>
                <button className="btn primary" disabled={busy} onClick={accept}>{busy ? 'Uniéndote…' : 'Aceptar y entrar'}</button>
              </>
            )}
            {inv.valid && status === 'anonymous' && (
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="btn primary" onClick={() => navigate(`/signup?next=${encodeURIComponent(next)}`)}>Crear cuenta</button>
                <button className="btn" onClick={() => navigate(`/login?next=${encodeURIComponent(next)}`)}>Ya tengo cuenta</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
