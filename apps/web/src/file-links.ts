/**
 * Llevar un archivo de chaggu a WhatsApp (2-oct-2026): desde chaggu WhatsApp solo acepta texto, así que se manda un
 * enlace para verlo sin cuenta (https://app.chaggu.com/archivo/<token>, vence a los 7 días). API: file-links.ts.
 */
import { client } from './app-client.ts';
import { locale, t } from './i18n.ts';

/** Tipo del arrastre: un adjunto de chaggu (solo lo recibe un chat de WhatsApp). */
export const DRAG_FILE = 'application/x-chaggu-file';
export interface FileDrag { attachmentId: string; name: string }

export function setFileDrag(e: { dataTransfer: DataTransfer | null }, f: FileDrag) {
  const dt = e.dataTransfer; if (!dt) return;
  dt.setData(DRAG_FILE, JSON.stringify(f));
  dt.setData('text/plain', f.name);
  dt.effectAllowed = 'copy';
}
export const isFileDrag = (types: readonly string[] | DOMStringList) => Array.from(types as ArrayLike<string>).includes(DRAG_FILE);
export function readFileDrag(dt: DataTransfer): FileDrag | null {
  try {
    const p = JSON.parse(dt.getData(DRAG_FILE) || 'null');
    return p && typeof p.attachmentId === 'string' && /^[\w-]{1,64}$/.test(p.attachmentId) && typeof p.name === 'string' ? { attachmentId: p.attachmentId, name: p.name.slice(0, 255) } : null;
  } catch { return null; }
}

export interface FileLink { url: string; name: string; expiresAt: string }
export const createFileLink = (attachmentId: string) => client.request<FileLink>(`/attachments/${attachmentId}/link`, { method: 'POST', json: {} });
export const tokenOf = (url: string) => url.split('/archivo/')[1] ?? '';
export const revokeFileLink = (url: string) => client.request(`/file-links/${encodeURIComponent(tokenOf(url))}`, { method: 'DELETE' });

/** El texto que queda en la caja de WhatsApp. */
export const fileLinkText = (l: FileLink) => t('flink.text', { name: l.name, url: l.url });
export const fileLinkDate = (iso: string) => new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
