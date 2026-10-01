import { useState } from 'react';
import { getLang } from '../i18n.ts';
import { updatePersonalPreferences, usePersonalPreferences } from '../personal-prefs.ts';
import { accentPreference, themePreference, useAccentPreference, useThemePreference, type ThemePref } from '../theme.ts';

export function AppearanceSettings() {
  usePersonalPreferences();
  const mode = useThemePreference();
  const accent = useAccentPreference();
  const [custom, setCustom] = useState(accentPreference() ?? '#0a7c87');
  const [busy, setBusy] = useState(false);
  const tr = (es: string, en: string) => getLang() === 'en' ? en : es;
  async function save(nextMode: ThemePref, nextAccent = accent) {
    setBusy(true);
    try { await updatePersonalPreferences((current) => ({ ...current, appearance: { mode: nextMode, accent: nextAccent } })); } catch { /* the preferences helper reports errors */ } finally { setBusy(false); }
  }
  return <div style={{ display: 'grid', gap: 12, marginBottom: 24, maxWidth: 480 }} data-testid="appearance-setting">
    <div className="seg" role="radiogroup" aria-label={tr('Tema', 'Theme')}>{([['system', 'Automático', 'Automatic'], ['light', 'Día', 'Day'], ['dark', 'Noche', 'Night']] as const).map(([id, es, en]) => <button key={id} disabled={busy} role="radio" aria-checked={mode === id} className={mode === id ? 'on' : ''} onClick={() => void save(id)}>{tr(es, en)}</button>)}</div>
    <label className="row"><span className="grow">{tr('Color personalizado', 'Custom color')}</span><input type="color" aria-label={tr('Color personalizado', 'Custom color')} value={custom} onChange={(event) => setCustom(event.target.value)} /><button className="btn small" disabled={busy} onClick={() => void save(themePreference(), custom)}>{tr('Aplicar', 'Apply')}</button></label>
    {accent && <button className="link-btn" disabled={busy} onClick={() => void save(themePreference(), null)}>{tr('Restaurar colores de chaggu', 'Restore chaggu colors')}</button>}
    <div className="hint">{tr('El tema y tu color se guardan en tu cuenta. El contraste del texto se ajusta automáticamente.', 'Your theme and color are saved to your account. Text contrast adjusts automatically.')}</div>
  </div>;
}
