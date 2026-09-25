import { useEffect, useRef, useState } from 'react';
import type { AttachmentDTO } from '@tiecoms/contracts';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from '@tiecoms/contracts';
import { client } from '../app-client.ts';
import { errorText, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { VoiceNote } from './Voice.tsx';

// ---------- Descarga autenticada con caché en memoria ----------
const blobs = new Map<string, Promise<string>>();
/** URL local (blob:) de una ruta del API que exige Bearer. */
export function blobUrl(path: string) {
  let p = blobs.get(path);
  if (!p) {
    p = client.fetchBlob(path).then((b) => URL.createObjectURL(b));
    p.catch(() => blobs.delete(path));
    blobs.set(path, p);
  }
  return p;
}
function useBlobUrl(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setUrl(null); setFailed(false);
    if (path) blobUrl(path).then((u) => alive && setUrl(u)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [path]);
  return { url, failed };
}

export const isImage = (a: { contentType: string }) => a.contentType.startsWith('image/') && a.contentType !== 'image/heic' && a.contentType !== 'image/heif';
export const isVideo = (a: { contentType: string }) => a.contentType.startsWith('video/');
const isVisual = (a: AttachmentDTO) => isImage(a) || isVideo(a);

export function fileSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
function fileIcon(a: { contentType: string; name: string }) {
  const ext = a.name.split('.').pop()?.toLowerCase() ?? '';
  if (isVideo(a)) return '🎬';
  if (a.contentType.startsWith('image/')) return '🖼';
  if (a.contentType.startsWith('audio/')) return '🎵';
  if (a.contentType === 'application/pdf' || ext === 'pdf') return '📕';
  if (['xls', 'xlsx', 'csv', 'numbers'].includes(ext)) return '📊';
  if (['doc', 'docx', 'pages', 'txt', 'rtf', 'md'].includes(ext)) return '📄';
  if (['zip', 'rar', '7z', 'gz'].includes(ext)) return '🗜';
  return '📎';
}

export async function downloadAttachment(a: AttachmentDTO) {
  try {
    const href = await blobUrl(a.url);
    const link = document.createElement('a');
    link.href = href; link.download = a.name; document.body.appendChild(link); link.click(); link.remove();
  } catch (e) { toast(errorText(e) || t('att.unavailable')); }
}

// ---------- En la burbuja ----------
function Tile({ a, more, onOpen }: { a: AttachmentDTO; more?: number; onOpen: () => void }) {
  const { url, failed } = useBlobUrl(isImage(a) ? a.thumbUrl ?? a.url : a.thumbUrl);
  const ratio = a.width && a.height ? a.width / a.height : 4 / 3;
  return (
    <button type="button" className="att-tile" onClick={onOpen} aria-label={a.name} style={{ aspectRatio: String(Math.min(2, Math.max(0.6, ratio))) }}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="att-tile-ph">{failed ? '⚠' : isVideo(a) ? '🎬' : ''}</span>}
      {isVideo(a) && <span className="att-play">▶</span>}
      {more ? <span className="att-more">{t('att.more', { n: more })}</span> : null}
    </button>
  );
}

export function FileChip({ a, onRemove, status }: { a: { name: string; contentType: string; sizeBytes: number }; onRemove?: () => void; status?: string }) {
  return (
    <span className="att-file">
      <span className="att-file-ico" aria-hidden>{fileIcon(a)}</span>
      <span className="grow" style={{ minWidth: 0 }}>
        <b className="ellipsis" style={{ display: 'block' }}>{a.name}</b>
        <span className="small muted">{status ?? fileSize(a.sizeBytes)}</span>
      </span>
      {onRemove && <button type="button" className="icon-btn" aria-label={t('att.remove')} onClick={onRemove}>×</button>}
    </span>
  );
}

/** Fotos y videos en cuadrícula (1–4 visibles + «+N») y archivos como fichas con descarga. */
export function AttachmentsView({ list, onCreateIssue }: { list: AttachmentDTO[]; onCreateIssue?: (title: string) => void }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const voices = list.filter((a) => a.kind === 'voice');
  const visual = list.filter((a) => a.kind !== 'voice' && isVisual(a));
  const files = list.filter((a) => a.kind !== 'voice' && !isVisual(a));
  const shown = visual.slice(0, 4);
  return (
    <div className="att-wrap">
      {voices.map((a) => <VoiceNote key={a.id} a={a} onCreateIssue={onCreateIssue} />)}
      {shown.length > 0 && (
        <div className={`att-grid n${shown.length}`}>
          {shown.map((a, i) => <Tile key={a.id} a={a} more={i === 3 && visual.length > 4 ? visual.length - 4 : undefined} onOpen={() => setViewing(i)} />)}
        </div>
      )}
      {files.map((a) => (
        <button key={a.id} type="button" className="att-file-btn" title={t('att.download')} onClick={() => void downloadAttachment(a)}>
          <FileChip a={a} />
          <span className="att-dl" aria-hidden>⤓</span>
        </button>
      ))}
      {viewing !== null && <Viewer list={visual} start={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** Visor a pantalla completa con flechas, teclado y descarga. */
function Viewer({ list, start, onClose }: { list: AttachmentDTO[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const a = list[i]!;
  const { url, failed } = useBlobUrl(a.url);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((x) => Math.min(list.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [list.length, onClose]);
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={t('att.viewer')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="viewer-bar">
        <span className="grow ellipsis">{a.name}{list.length > 1 ? ` · ${t('att.count', { i: i + 1, n: list.length })}` : ''}</span>
        <button className="icon-btn" aria-label={t('att.download')} onClick={() => void downloadAttachment(a)}>⤓</button>
        <button className="icon-btn" aria-label={t('common.close')} onClick={onClose}>×</button>
      </div>
      {i > 0 && <button className="viewer-nav prev" aria-label={t('att.prev')} onClick={() => setI(i - 1)}>‹</button>}
      <div className="viewer-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {failed ? <div className="viewer-msg">{t('att.unavailable')}</div>
          : !url ? <div className="viewer-msg">{t('common.loading')}</div>
          : isVideo(a) ? <video src={url} controls autoPlay playsInline />
          : <img src={url} alt={a.name} />}
      </div>
      {i < list.length - 1 && <button className="viewer-nav next" aria-label={t('att.next')} onClick={() => setI(i + 1)}>›</button>}
    </div>
  );
}

// ---------- En el compositor ----------
export interface Draft { key: string; file: File; preview: string | null; status: 'uploading' | 'done' | 'error'; dto?: AttachmentDTO; error?: string }

/** Miniatura JPEG de ≤ 480 px (se sube aparte para que las listas carguen rápido). */
async function makeThumb(file: File): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < 200_000) { bmp.close(); return null; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  } catch { return null; }
}

/** Sube en cuanto se eligen; al enviar se usan los ids. */
export function useDrafts(conversationId: string) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const patch = (key: string, p: Partial<Draft>) => { if (alive.current) setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...p } : d))); };

  async function uploadOne(d: Draft) {
    patch(d.key, { status: 'uploading', error: undefined });
    try {
      const dto = await client.uploadAttachment(conversationId, d.file, d.file.name || 'archivo');
      if (d.file.type.startsWith('image/')) {
        const th = await makeThumb(d.file);
        if (th) { try { Object.assign(dto, await client.uploadAttachmentThumb(dto.id, th)); } catch { /* sin miniatura, se usa la original */ } }
      }
      patch(d.key, { status: 'done', dto });
    } catch (e) { patch(d.key, { status: 'error', error: errorText(e) }); }
  }

  function add(files: File[] | FileList) {
    const list = [...files];
    const room = MAX_ATTACHMENTS_PER_MESSAGE - drafts.length;
    if (list.length > room) toast(t('att.max'));
    const next: Draft[] = [];
    for (const file of list.slice(0, Math.max(0, room))) {
      if (file.size > MAX_ATTACHMENT_BYTES) { toast(t('att.tooBig', { name: file.name })); continue; }
      next.push({ key: `${Date.now()}-${Math.random()}`, file, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null, status: 'uploading' });
    }
    setDrafts((ds) => [...ds, ...next]);
    for (const d of next) void uploadOne(d);
  }
  const remove = (key: string) => setDrafts((ds) => { const d = ds.find((x) => x.key === key); if (d?.preview) URL.revokeObjectURL(d.preview); return ds.filter((x) => x.key !== key); });
  const clear = () => setDrafts([]);
  const retry = (key: string) => { const d = drafts.find((x) => x.key === key); if (d) void uploadOne(d); };
  return {
    drafts, add, remove, clear, retry,
    busy: drafts.some((d) => d.status === 'uploading'),
    ready: drafts.filter((d) => d.status === 'done').map((d) => d.dto!),
    failed: drafts.some((d) => d.status === 'error'),
  };
}

export function DraftTray({ drafts, onRemove, onRetry }: { drafts: Draft[]; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  if (!drafts.length) return null;
  return (
    <div className="att-tray">
      {drafts.map((d) => d.preview ? (
        <div key={d.key} className={`att-draft img is-${d.status}`} title={d.error ?? d.file.name}>
          <img src={d.preview} alt="" />
          {d.status === 'uploading' && <span className="att-spin" aria-label={t('att.uploading')} />}
          {d.status === 'error' && <button type="button" className="att-retry" onClick={() => onRetry(d.key)}>{t('att.retry')}</button>}
          <button type="button" className="att-x" aria-label={t('att.remove')} onClick={() => onRemove(d.key)}>×</button>
        </div>
      ) : (
        <div key={d.key} className={`att-draft file is-${d.status}`} title={d.error ?? d.file.name}>
          <FileChip a={{ name: d.file.name, contentType: d.file.type, sizeBytes: d.file.size }} onRemove={() => onRemove(d.key)}
            status={d.status === 'uploading' ? t('att.uploading') : d.status === 'error' ? t('att.failed', { name: d.file.name }) : undefined} />
          {d.status === 'error' && <button type="button" className="btn ghost small" onClick={() => onRetry(d.key)}>{t('att.retry')}</button>}
        </div>
      ))}
    </div>
  );
}

/** Abre el selector del sistema. accept: 'media' (fotos y videos) o 'any'. */
export function pickFiles(kind: 'media' | 'any', onPick: (files: File[]) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (kind === 'media') input.accept = 'image/*,video/*';
  input.onchange = () => { if (input.files?.length) onPick([...input.files]); };
  input.click();
}
