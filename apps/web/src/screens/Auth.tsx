import { useEffect, useState, type FormEvent } from 'react';
import type { OrgInvitationPreviewDTO } from '@tiecoms/contracts';
import { client, platform } from '../app-client.ts';
import { errorText, t } from '../i18n.ts';
import { asset, navigate, queryParam } from '../router.ts';

export function AuthScreen({ mode, after }: { mode: 'login' | 'signup'; after?: string }) {
  const orgToken = new URLSearchParams(location.search).get('org') ?? undefined;
  const [orgInvite, setOrgInvite] = useState<OrgInvitationPreviewDTO | null>(null);
  const [f, setF] = useState({ name: '', email: '', password: '', orgName: '', title: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const joining = mode === 'signup' && !!orgToken;

  useEffect(() => {
    if (!joining) return;
    client.previewOrgInvitation(orgToken!).then((p) => { setOrgInvite(p); if (p.email) setF((x) => ({ ...x, email: p.email! })); }).catch((e) => setError(errorText(e)));
  }, [joining, orgToken]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await client.login(f.email, f.password);
      else await client.signup({
        name: f.name, email: f.email, password: f.password, title: f.title || undefined,
        ...(joining ? { orgInviteToken: orgToken } : { orgName: f.orgName }),
      });
      navigate(after ?? '/', true);
    } catch (err: any) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const q = after ? `?next=${encodeURIComponent(after)}` : '';
  async function sso(provider: 'google' | 'microsoft') {
    if (mode === 'signup' && !joining && !f.orgName.trim()) { setError(t('auth.ssoNeedsCompany')); return; }
    setBusy(true);
    setError(null);
    try {
      location.assign(await client.ssoStartUrl(provider, {
        next: after, ...(joining ? { orgInviteToken: orgToken } : mode === 'signup' ? { orgName: f.orgName.trim() } : {}),
      }));
    } catch (err: any) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <div className="auth">
      <div className="auth-card">
        <img src={asset('/tiecoms-logo.svg')} alt="TieComs" width={260} height={77} />
        <p className="muted" style={{ fontSize: 16, margin: 0 }}>{t('brand.tagline')}</p>
        {joining && orgInvite && (
          <div className="card" style={{ padding: 14 }}>
            <b>{t('auth.joining', { org: orgInvite.orgName })}</b>
            <div className="small muted">{orgInvite.valid ? t('auth.joiningBy', { name: orgInvite.invitedByName }) : t('auth.inviteInvalid')}</div>
          </div>
        )}
        {/* En las apps el SSO va por el navegador del sistema (Google bloquea los WebView); aquí solo la web. */}
        {platform === 'web' && (
          <div className="sso">
            {mode === 'signup' && !joining && <label className="field"><span>{t('auth.company')}</span><input className="input" autoComplete="organization" value={f.orgName} onChange={set('orgName')} placeholder={t('auth.companyPh')} /></label>}
            <button type="button" className="btn sso-btn" disabled={busy} onClick={() => sso('google')}><GoogleMark /> {t('auth.withGoogle')}</button>
            <button type="button" className="btn sso-btn" disabled={busy} onClick={() => sso('microsoft')}><MicrosoftMark /> {t('auth.withMicrosoft')}</button>
            <div className="sso-or"><span>{t('auth.orEmail')}</span></div>
          </div>
        )}
        <form onSubmit={submit}>
          {mode === 'signup' && (
            <>
              <label className="field"><span>{t('auth.name')}</span><input className="input" autoComplete="name" required value={f.name} onChange={set('name')} /></label>
              {!joining && platform !== 'web' && <label className="field"><span>{t('auth.company')}</span><input className="input" autoComplete="organization" required value={f.orgName} onChange={set('orgName')} placeholder={t('auth.companyPh')} /></label>}
              <label className="field"><span>{t('auth.title')}</span><input className="input" autoComplete="organization-title" value={f.title} onChange={set('title')} /></label>
            </>
          )}
          <label className="field"><span>{t('auth.email')}</span><input className="input" type="email" autoComplete="email" required value={f.email} onChange={set('email')} /></label>
          <label className="field"><span>{t('auth.password')}</span><input className="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'signup' ? 10 : 1} value={f.password} onChange={set('password')} />
            {mode === 'signup' && <small className="hint">{t('auth.passwordHint')}</small>}
          </label>
          {error && <div className="error" role="alert">{error}</div>}
          <button className="btn primary" disabled={busy || (joining && orgInvite?.valid === false)}>{busy ? t('common.wait') : mode === 'login' ? t('auth.login') : joining ? t('auth.signupJoin') : t('auth.signup')}</button>
        </form>
        <div className="auth-switch">
          {mode === 'login'
            ? <>{t('auth.noAccount')} <a href={asset(`/signup${q}`)} onClick={(e) => { e.preventDefault(); navigate(`/signup${q}`); }}>{t('auth.createAccount')}</a></>
            : <>{t('auth.haveAccount')} <a href={asset(`/login${q}`)} onClick={(e) => { e.preventDefault(); navigate(`/login${q}`); }}>{t('auth.login')}</a></>}
        </div>
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" /><rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" /><rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

/** Regreso de Google/Microsoft: /auth/sso?code=… o ?error=…&message=… */
export function SsoReturnScreen() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const code = queryParam('code');
    const next = queryParam('next');
    const failed = queryParam('error');
    if (failed) { setError(errorText({ code: failed, message: queryParam('message') })); return; }
    if (!code) { setError(t('err.sso_failed')); return; }
    // El código es de un solo uso: se quita de la barra de direcciones antes de canjearlo.
    history.replaceState(null, '', location.pathname);
    client.ssoComplete(code).then(() => navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', true)).catch((e) => setError(errorText(e)));
  }, []);
  return (
    <div className="auth">
      <div className="auth-card">
        <img src={asset('/tiecoms-logo.svg')} alt="TieComs" width={260} height={77} />
        {error
          ? <>
              <div className="error" role="alert">{error}</div>
              <button className="btn primary" onClick={() => navigate('/login', true)}>{t('auth.backToLogin')}</button>
            </>
          : <p className="muted">{t('common.wait')}</p>}
      </div>
    </div>
  );
}
