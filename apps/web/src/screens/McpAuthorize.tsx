import { useEffect, useState } from 'react';
import { client, useClient } from '../app-client.ts';
import { errorText, t } from '../i18n.ts';
import { asset } from '../router.ts';
import { MCP_SCOPES, McpPermsPicker, permsPayload, useWaAccounts, type McpPermsValue } from './McpPerms.tsx';

/**
 * /autorizar-ia: una IA (Claude, Codex, ChatGPT…) pide entrar a chaggu por el conector MCP (docs/MCP.md).
 * La persona ya inició sesión con SU cuenta; al aprobar, la IA recibe un token solo de ella.
 */
export function McpAuthorizeScreen() {
  const me = useClient((s) => s.data?.me);
  const q = new URLSearchParams(location.search);
  const req = {
    clientId: q.get('client_id') ?? '', redirectUri: q.get('redirect_uri') ?? '', state: q.get('state') ?? undefined,
    codeChallenge: q.get('code_challenge') ?? '', codeChallengeMethod: q.get('code_challenge_method') ?? '',
  };
  const [info, setInfo] = useState<{ name: string; redirectHost: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Permisos: los que pidió la IA (scope=…) o todos; WhatsApp: los números con «Compartir con integraciones».
  const asked = (q.get('scope') ?? '').split(/\s+/).filter((x) => (MCP_SCOPES as readonly string[]).includes(x));
  const [perms, setPerms] = useState<McpPermsValue>({ scopes: asked.length ? asked : [...MCP_SCOPES], wa: 'shared' });
  const accounts = useWaAccounts();
  const valid = q.get('response_type') === 'code' && req.clientId && req.redirectUri && req.codeChallenge && req.codeChallengeMethod === 'S256';

  useEffect(() => {
    if (!valid) { setError(t('mcpAuth.invalid')); return; }
    client.request<{ name: string; redirectHost: string }>(`/mcp-oauth/client?client_id=${encodeURIComponent(req.clientId)}&redirect_uri=${encodeURIComponent(req.redirectUri)}`)
      .then(setInfo).catch((e) => setError(errorText(e)));
  }, []);

  const go = (path: 'approve' | 'deny') => {
    setBusy(true);
    client.request<{ redirect: string }>(`/mcp-oauth/${path}`, { method: 'POST', json: path === 'approve' ? { ...req, ...permsPayload(perms, accounts) } : { clientId: req.clientId, redirectUri: req.redirectUri, state: req.state } })
      .then((r) => { location.href = r.redirect; }).catch((e) => { setError(errorText(e)); setBusy(false); });
  };

  return (
    <div className="auth">
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <img src={asset('/chaggu-logo.svg')} alt="chaggu" width={110} height={48} />
        <h1 style={{ fontSize: 22, margin: '14px 0 6px' }}>{info ? t('mcpAuth.title', { name: info.name }) : t('mcpAuth.titleGeneric')}</h1>
        {error && <div className="error">{error}</div>}
        {info && !error && (
          <>
            <p className="muted">{t('mcpAuth.lead', { name: me?.name ?? '' })}</p>
            <ul className="small" style={{ paddingLeft: 18, lineHeight: 1.6 }}>
              <li>{t('mcpAuth.can1')}</li><li>{t('mcpAuth.can2')}</li><li>{t('mcpAuth.can3')}</li>
            </ul>
            <McpPermsPicker value={perms} onChange={setPerms} accounts={accounts} />
            <p className="small muted" style={{ marginTop: 10 }}>{t('mcpAuth.only')}</p>
            <p className="small muted">{t('mcpAuth.returnsTo', { host: info.redirectHost })}</p>
            <div className="row" style={{ gap: 8, marginTop: 14 }}>
              <button className="btn" disabled={busy} onClick={() => go('deny')}>{t('mcpAuth.deny')}</button>
              <button className="btn primary grow" disabled={busy || !perms.scopes.length} onClick={() => go('approve')}>{busy ? t('common.wait') : t('mcpAuth.allow')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
