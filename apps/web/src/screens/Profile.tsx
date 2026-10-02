import { useEffect, useRef, useState } from 'react';
import type { PersonDTO, UserDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { dndMenu, openDialog } from '../actions.tsx';
import { setSoundEnabled, soundEnabled } from '../sound.ts';
import { errorText, getLang, langPreference, setLang, t, type Lang } from '../i18n.ts';
import { openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { navigate } from '../router.ts';
import { THEME_PREFS, accentPreference, themePreference } from '../theme.ts';
import { updatePersonalPreferences } from '../personal-prefs.ts';
import { Avatar, Modal, orgById, personById } from '../ui.tsx';
import { PhotoCropDialog } from './PhotoCrop.tsx';
import '../personal.css';

export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const me = personById(d, d.me.id);
  const org = orgById(d, d.me.primaryOrgId);
  const [name, setName] = useState(d.me.name);
  const [title, setTitle] = useState(d.me.title ?? '');
  const [area, setArea] = useState(d.me.area ?? '');
  const [phone, setPhone] = useState(d.me.phone ?? '');
  const [company, setCompany] = useState(d.me.company ?? '');
  const [bio, setBio] = useState(d.me.bio ?? '');
  const [busy, setBusy] = useState<'save' | 'photo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const [cropFile, setCropFile] = useState<File | null>(null);
  function pick(file: File | undefined) {
    if (input.current) input.current.value = '';
    if (!file) return;
    setError(null);
    if (!file.type.startsWith('image/')) { setError(t('photo.invalid')); return; }
    setCropFile(file);
  }
  async function upload(blob: Blob) {
    setBusy('photo');
    try {
      await client.request<UserDTO>('/me/avatar', { method: 'POST', body: blob, headers: { 'content-type': blob.type } });
      await client.loadBootstrap();
      setPreview(URL.createObjectURL(blob));
    } finally { setBusy(null); }
  }
  async function removePhoto() {
    if (!confirm(t('photo.removeConfirm'))) return;
    setBusy('photo'); setError(null);
    try { await client.request('/me/avatar', { method: 'DELETE' }); setPreview(null); await client.loadBootstrap(); toast(t('photo.removed')); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function save() {
    setBusy('save'); setError(null);
    try {
      await client.request<UserDTO>('/me', { method: 'PATCH', json: { name: name.trim(), title: title.trim() || null, area: area.trim() || null, phone: phone.trim() || null, company: company.trim() || null, bio: bio.trim() || null } });
      await client.loadBootstrap();
      toast(t('profile.saved'));
      onClose();
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  const hasPhoto = !!(preview || me?.avatarUrl);
  const changed = name.trim() !== d.me.name || (title.trim() || null) !== (d.me.title ?? null) || (area.trim() || null) !== (d.me.area ?? null) || (phone.trim() || null) !== (d.me.phone ?? null) || (company.trim() || null) !== (d.me.company ?? null) || (bio.trim() || null) !== (d.me.bio ?? null);

  return (
    <Modal title={t('profile.title')} onClose={onClose}>
      <div className="profile-photo">
        <button className="photo-btn" title={t('photo.tapToChange')} aria-label={t('photo.choose')} disabled={!!busy} onClick={() => input.current?.click()}>
          {preview ? <img className="avatar" src={preview} alt="" width={88} height={88} style={{ borderRadius: 99, objectFit: 'cover' }} />
            : <Avatar person={me} org={org} size={88} />}
        </button>
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn small" disabled={!!busy} onClick={() => input.current?.click()}>📷 {busy === 'photo' ? t('common.wait') : hasPhoto ? t('profile.changePhoto') : t('profile.addPhoto')}</button>
            {hasPhoto && <button className="btn ghost small" disabled={!!busy} onClick={removePhoto}>{t('profile.removePhoto')}</button>}
          </div>
          <span className="hint">{t('profile.photoHint')}</span>
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      </div>
      <label className="field"><span>{t('auth.name')}</span><input className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <label className="field"><span>{t('profile.jobTitle')}</span><input className="input" maxLength={120} value={title} placeholder={t('profile.jobTitlePh')} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field"><span>{t('profile.area')}</span><input className="input" maxLength={120} value={area} placeholder={t('profile.areaPh')} onChange={(e) => setArea(e.target.value)} /></label>
      <label className="field"><span>{getLang() === 'en' ? 'Phone' : 'Teléfono'}</span><input className="input" type="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
      <label className="field"><span>{getLang() === 'en' ? 'Company' : 'Empresa'}</span><input className="input" maxLength={120} value={company} placeholder={org?.name} onChange={(e) => setCompany(e.target.value)} /></label>
      <label className="field"><span>{getLang() === 'en' ? 'About me' : 'Información personal'}</span><textarea className="input" rows={3} maxLength={1000} value={bio} onChange={(e) => setBio(e.target.value)} /></label>
      <p className="hint">{getLang() === 'en' ? 'These details can be viewed by people who share a team or chat with you.' : 'Las personas que comparten un equipo o chat contigo pueden ver estos datos.'}</p>
      <div className="hint">{d.me.email}{org ? ` · ${org.name}` : ''}</div>
      <button type="button" className="btn profile-signed" onClick={() => { onClose(); navigate('/firmas'); }}>✍️ {t('profile.signed')} <span className="muted">›</span></button>
      {error && <div className="error">{error}</div>}
      {cropFile && <PhotoCropDialog file={cropFile} title={t('photo.cropTitle')} onSave={upload} onClose={() => setCropFile(null)} />}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
        <button className="btn primary" disabled={!!busy || !changed || name.trim().length < 2} onClick={save}>{t('profile.save')}</button>
      </div>
    </Modal>
  );
}

export const openProfile = () => openDialog((close) => <ProfileDialog onClose={close} />);

export function PersonProfileDialog({ person, onClose }: { person: PersonDTO; onClose: () => void }) {
  const d = useClient((state) => state.data)!;
  const org = orgById(d, person.orgId);
  const tr = (es: string, en: string) => getLang() === 'en' ? en : es;
  const fields = [[tr('Cargo', 'Job title'), person.title], [tr('Área', 'Department'), person.area], [tr('Empresa', 'Company'), person.company || org?.name], [tr('Teléfono', 'Phone'), person.phone], [tr('Información personal', 'About'), person.bio]];
  return <Modal title={person.name} onClose={onClose}>
    <div className="row"><Avatar person={person} org={org} size={88} /><div><b>{person.name}</b><p className="muted">{org?.name}</p></div></div>
    <dl className="person-profile-details">{fields.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {!fields.some(([, value]) => value) && <p className="hint">{tr('Esta persona aún no ha completado su perfil.', 'This person has not completed their profile yet.')}</p>}
    <div className="modal-actions"><button className="btn" onClick={onClose}>{tr('Cerrar', 'Close')}</button></div>
  </Modal>;
}

export const openPersonProfile = (person: PersonDTO) => openDialog((close) => <PersonProfileDialog person={person} onClose={close} />);

/** Menú de la cuenta (clic en tu nombre, abajo a la izquierda). */
export function openAccountMenu(anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  const pref = langPreference();
  const langs: [Lang | null, string][] = [[null, t('settings.langAuto')], ['es', 'Español'], ['en', 'English']];
  const items: MenuItem[] = [
    { label: t('profile.edit'), icon: '✎', onSelect: openProfile },
    { label: t('profile.changePhoto'), icon: '📷', onSelect: openProfile },
    { divider: true },
    // «No molestar» (silenciar todo) y el sonido de mensajes (docs/GRUPOS.md, 28-sep-2026).
    dndMenu(client.getState().data?.me.dndUntil),
    { label: getLang() === 'en' ? 'Availability' : 'Disponibilidad', icon: '◉', items: [
      ...(['available', 'busy', 'focus', 'dnd', 'rest'] as const).map((mode) => ({
        label: (getLang() === 'en' ? { available: '🟢 Available', busy: '🔴 Busy', focus: '🎯 Focus', dnd: '🌙 Do not disturb', rest: '🛌 Rest' } : { available: '🟢 Disponible', busy: '🔴 Ocupado', focus: '🎯 Concentración', dnd: '🌙 No molestar', rest: '🛌 Descanso' })[mode],
        items: [30, 60, 120, 480].map((minutes) => ({ label: `${minutes < 60 ? minutes + ' min' : minutes / 60 + ' h'}`, onSelect: () => void client.request('/me/availability', { method: 'PUT', json: { mode, until: new Date(Date.now() + minutes * 60_000).toISOString() } }).then(() => client.loadBootstrap()).catch((e) => toast(errorText(e))) })),
      })),
      { label: getLang() === 'en' ? 'Clear status' : 'Quitar estado', onSelect: () => void client.request('/me/availability', { method: 'PUT', json: { mode: null, until: null } }).then(() => client.loadBootstrap()).catch((e) => toast(errorText(e))) },
    ] },
    { label: t('sound.title'), icon: soundEnabled() ? '🔊' : '🔈', hint: soundEnabled() ? '✓' : '—', onSelect: () => setSoundEnabled(!soundEnabled()) },
    { divider: true },
    { label: t('nav.signed'), icon: '✍️', onSelect: () => navigate('/firmas') },
    { label: t('nav.files'), icon: '▣', onSelect: () => navigate('/archivos') },
    ...(client.getState().data?.features?.mail ? [{ label: t('nav.mail'), icon: '✉', onSelect: () => navigate('/correo') }] : []),
    { label: t('nav.whatsapp'), icon: '✆', onSelect: () => navigate('/whatsapp') },
    { label: t('settings.language'), icon: '🌐', hint: pref ? (pref === 'es' ? 'ES' : 'EN') : getLang().toUpperCase(),
      items: langs.map(([v, label]) => ({ label, icon: pref === v ? '✓' : '', onSelect: () => setLang(v) })) },
    { label: t('theme.title'), icon: '◐', hint: t(`theme.${themePreference()}`),
      items: THEME_PREFS.map((v) => ({ label: t(`theme.${v}`), icon: themePreference() === v ? '✓' : '', onSelect: () => { void updatePersonalPreferences((current) => ({ ...current, appearance: { mode: v, accent: current.appearance?.accent ?? accentPreference() } })).catch(() => {}); } })) },
    { label: t('settings.title'), icon: '⚙', onSelect: () => navigate('/ajustes') },
    { divider: true },
    { label: t('settings.logout'), icon: '⎋', danger: true, onSelect: () => void client.logout().then(() => navigate('/login', true)) },
  ];
  openMenuAt(r.left + 12, r.top - 8, items);
}
