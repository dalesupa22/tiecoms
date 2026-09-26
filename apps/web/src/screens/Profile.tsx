import { useEffect, useRef, useState } from 'react';
import type { UserDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { openDialog } from '../actions.tsx';
import { errorText, getLang, langPreference, setLang, t, type Lang } from '../i18n.ts';
import { openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { navigate } from '../router.ts';
import { Avatar, Modal, orgById, personById } from '../ui.tsx';
import { PhotoCropDialog } from './PhotoCrop.tsx';

export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const me = personById(d, d.me.id);
  const org = orgById(d, d.me.primaryOrgId);
  const [name, setName] = useState(d.me.name);
  const [title, setTitle] = useState(d.me.title ?? '');
  const [area, setArea] = useState(d.me.area ?? '');
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
      await client.request<UserDTO>('/me', { method: 'PATCH', json: { name: name.trim(), title: title.trim() || null, area: area.trim() || null } });
      await client.loadBootstrap();
      toast(t('profile.saved'));
      onClose();
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  const hasPhoto = !!(preview || me?.avatarUrl);
  const changed = name.trim() !== d.me.name || (title.trim() || null) !== (d.me.title ?? null) || (area.trim() || null) !== (d.me.area ?? null);

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
      <div className="hint">{d.me.email}{org ? ` · ${org.name}` : ''}</div>
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

/** Menú de la cuenta (clic en tu nombre, abajo a la izquierda). */
export function openAccountMenu(anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  const pref = langPreference();
  const langs: [Lang | null, string][] = [[null, t('settings.langAuto')], ['es', 'Español'], ['en', 'English']];
  const items: MenuItem[] = [
    { label: t('profile.edit'), icon: '✎', onSelect: openProfile },
    { label: t('profile.changePhoto'), icon: '📷', onSelect: openProfile },
    { divider: true },
    { label: t('nav.files'), icon: '▣', onSelect: () => navigate('/archivos') },
    { label: t('nav.whatsapp'), icon: '✆', onSelect: () => navigate('/whatsapp') },
    { label: t('settings.language'), icon: '🌐', hint: pref ? (pref === 'es' ? 'ES' : 'EN') : getLang().toUpperCase(),
      items: langs.map(([v, label]) => ({ label, icon: pref === v ? '✓' : '', onSelect: () => setLang(v) })) },
    { label: t('settings.title'), icon: '⚙', onSelect: () => navigate('/ajustes') },
    { divider: true },
    { label: t('settings.logout'), icon: '⎋', danger: true, onSelect: () => void client.logout().then(() => navigate('/login', true)) },
  ];
  openMenuAt(r.left + 12, r.top - 8, items);
}
