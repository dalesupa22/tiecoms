import { useEffect, useRef, useState } from 'react';
import type { UserDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { openDialog } from '../actions.tsx';
import { errorText, getLang, langPreference, setLang, t, type Lang } from '../i18n.ts';
import { openMenuAt, toast, type MenuItem } from '../menu.tsx';
import { navigate } from '../router.ts';
import { Avatar, Modal, orgById, personById } from '../ui.tsx';

/** Recorta al centro en cuadrado y reduce a 512 px: la foto sube liviana (≈50–150 KB). */
async function squareImage(file: File, size = 512): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(size, side);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.86));
  // Safari antiguo no produce WebP: cae a JPEG.
  if (blob && blob.type === 'image/webp') return blob;
  return new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('No pude leer la imagen'))), 'image/jpeg', 0.88));
}

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

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!file.type.startsWith('image/')) { setError(t('profile.notImage')); return; }
    setBusy('photo');
    try {
      const blob = await squareImage(file);
      setPreview(URL.createObjectURL(blob));
      await client.request<UserDTO>('/me/avatar', { method: 'POST', body: blob, headers: { 'content-type': blob.type } });
      await client.loadBootstrap();
      toast(t('profile.photoSaved'));
    } catch (e) { setPreview(null); setError(errorText(e)); } finally { setBusy(null); if (input.current) input.current.value = ''; }
  }
  async function removePhoto() {
    setBusy('photo'); setError(null);
    try { await client.request('/me/avatar', { method: 'DELETE' }); setPreview(null); await client.loadBootstrap(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
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
        {preview ? <img className="avatar" src={preview} alt="" width={88} height={88} style={{ borderRadius: 99, objectFit: 'cover' }} />
          : <Avatar person={me} org={org} size={88} />}
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
    { label: t('nav.whatsapp'), icon: '✆', onSelect: () => navigate('/whatsapp') },
    { label: t('settings.language'), icon: '🌐', hint: pref ? (pref === 'es' ? 'ES' : 'EN') : getLang().toUpperCase(),
      items: langs.map(([v, label]) => ({ label, icon: pref === v ? '✓' : '', onSelect: () => setLang(v) })) },
    { label: t('settings.title'), icon: '⚙', onSelect: () => navigate('/ajustes') },
    { divider: true },
    { label: t('settings.logout'), icon: '⎋', danger: true, onSelect: () => void client.logout().then(() => navigate('/login', true)) },
  ];
  openMenuAt(r.left + 12, r.top - 8, items);
}
