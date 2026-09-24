import { useEffect, useState, type FormEvent } from 'react';
import type { OrgInvitationPreviewDTO } from '@tiecoms/contracts';
import { client } from '../app-client.ts';
import { errorText, t } from '../i18n.ts';
import { asset, navigate } from '../router.ts';

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
        <form onSubmit={submit}>
          {mode === 'signup' && (
            <>
              <label className="field"><span>{t('auth.name')}</span><input className="input" autoComplete="name" required value={f.name} onChange={set('name')} /></label>
              {!joining && <label className="field"><span>{t('auth.company')}</span><input className="input" autoComplete="organization" required value={f.orgName} onChange={set('orgName')} placeholder={t('auth.companyPh')} /></label>}
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
