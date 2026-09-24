import { useState, type FormEvent } from 'react';
import { client } from '../app-client.ts';
import { asset, navigate } from '../router.ts';

export function AuthScreen({ mode, after }: { mode: 'login' | 'signup'; after?: string }) {
  const [f, setF] = useState({ name: '', email: '', password: '', orgName: '', title: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await client.login(f.email, f.password);
      else await client.signup({ name: f.name, email: f.email, password: f.password, orgName: f.orgName, title: f.title || undefined });
      navigate(after ?? '/', true);
    } catch (err: any) {
      const details = Array.isArray(err?.details) ? err.details.map((d: any) => d.message).join(' · ') : '';
      setError(details || err?.message || 'No se pudo continuar');
    } finally {
      setBusy(false);
    }
  }

  const q = after ? `?next=${encodeURIComponent(after)}` : '';
  return (
    <div className="auth">
      <div className="auth-card">
        <img src={asset("/tiecoms-logo.svg")} alt="TieComs · conecta humanos, empresas y bots" width={260} height={77} />
        <p className="muted" style={{ fontSize: 16, margin: 0 }}>Una sola red entre las empresas con las que trabajas. Cada persona ve su propio alcance.</p>
        <form onSubmit={submit}>
          {mode === 'signup' && (
            <>
              <label className="field"><span>Tu nombre</span><input className="input" autoComplete="name" required value={f.name} onChange={set('name')} /></label>
              <label className="field"><span>Tu empresa</span><input className="input" autoComplete="organization" required value={f.orgName} onChange={set('orgName')} placeholder="Nombre de la empresa" /></label>
              <label className="field"><span>Tu cargo (opcional)</span><input className="input" autoComplete="organization-title" value={f.title} onChange={set('title')} /></label>
            </>
          )}
          <label className="field"><span>Correo de trabajo</span><input className="input" type="email" autoComplete="email" required value={f.email} onChange={set('email')} /></label>
          <label className="field"><span>Contraseña</span><input className="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'signup' ? 10 : 1} value={f.password} onChange={set('password')} />
            {mode === 'signup' && <small className="hint">Mínimo 10 caracteres.</small>}
          </label>
          {error && <div className="error" role="alert">{error}</div>}
          <button className="btn primary" disabled={busy}>{busy ? 'Un momento…' : mode === 'login' ? 'Entrar' : 'Crear cuenta y empresa'}</button>
        </form>
        <div className="auth-switch">
          {mode === 'login'
            ? <>¿Tu empresa aún no está en TieComs? <a href={asset(`/signup${q}`)} onClick={(e) => { e.preventDefault(); navigate(`/signup${q}`); }}>Crear cuenta</a></>
            : <>¿Ya tienes cuenta? <a href={asset(`/login${q}`)} onClick={(e) => { e.preventDefault(); navigate(`/login${q}`); }}>Entrar</a></>}
        </div>
      </div>
    </div>
  );
}
