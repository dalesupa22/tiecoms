import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AttachmentDTO } from '@tiecoms/contracts';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from '@tiecoms/contracts';
import { client } from '../app-client.ts';
import { errorText, getLang, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { VoiceNote } from './Voice.tsx';
import { formatBytes, formatDuration } from '../video.ts';
import { BlobCache } from '../blob-cache.ts';
import { onTrim } from '../memory-trim.ts';
import { shrinkImage } from '../image-shrink.ts';

// ---------- Descarga autenticada con caché en memoria (con tope y revocación: blob-cache.ts) ----------
export const blobs = new BlobCache({ fetch: (path) => client.fetchBlob(path) });
onTrim(() => blobs.prune(true));
/**
 * URL local (blob:) de una ruta del API que exige Bearer, sin soltarla nunca (queda fija en memoria). Para pintar
 * algo usa useBlobUrl o acquireBlobUrl, que la sueltan al terminar.
 */
export function blobUrl(path: string) { return blobs.acquire(path).promise; }
/** Adquiere la URL de `path`; release() la deja libre para que la caché la revoque cuando sobre. */
export const acquireBlobUrl = (path: string) => blobs.acquire(path);
/** Foto para la burbuja sin miniatura del servidor: la original achicada una vez (image-shrink.ts). */
const acquireTile = (path: string) => blobs.acquire(`${path}#tile`, async () => shrinkImage(await client.fetchBlob(path)));
export function useBlobUrl(path: string | null, tile = false) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl(null); setFailed(false);
    if (!path) return;
    let alive = true;
    const h = tile ? acquireTile(path) : blobs.acquire(path);
    h.promise.then((u) => alive && setUrl(u)).catch(() => alive && setFailed(true));
    return () => { alive = false; h.release(); };
  }, [path, tile]);
  return { url, failed };
}

export const isImage = (a: { contentType: string }) => a.contentType.startsWith('image/') && a.contentType !== 'image/heic' && a.contentType !== 'image/heif';
export const isVideo = (a: { contentType: string }) => a.contentType.startsWith('video/');
export const isPdf = (a: { contentType: string; name: string }) => a.contentType === 'application/pdf' || /\.pdf$/i.test(a.name);
/** Visor y firma de PDFs: pdf.js se descarga solo cuando alguien abre uno. */
const PdfSheet = lazy(() => import('./Sign.tsx'));
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
    // Sin caché: un archivo descargado no se queda en la RAM (antes quedaba entero hasta cerrar la app).
    const href = URL.createObjectURL(await client.fetchBlob(a.url));
    const link = document.createElement('a');
    link.href = href; link.download = a.name; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  } catch (e) { toast(errorText(e) || t('att.unavailable')); }
}

// ---------- En la burbuja ----------
function Tile({ a, more, onOpen }: { a: AttachmentDTO; more?: number; onOpen: () => void }) {
  // Se pide solo cerca de la pantalla; sin miniatura del servidor, la original achicada (no la foto entera).
  const box = useRef<HTMLButtonElement>(null);
  const seen = useSeen(box);
  const { url, failed } = useBlobUrl(!seen ? null : a.thumbUrl ?? (isImage(a) ? a.url : null), !a.thumbUrl && isImage(a));
  const ratio = a.width && a.height ? a.width / a.height : 4 / 3;
  return (
    <button ref={box} type="button" className="att-tile" onClick={onOpen} aria-label={a.name} style={{ aspectRatio: String(Math.min(2, Math.max(0.6, ratio))) }}>
      {url ? <img src={url} alt="" draggable={false} decoding="async" /> : <span className="att-tile-ph">{failed ? '⚠' : isVideo(a) ? '🎬' : ''}</span>}
      {isVideo(a) && <span className="att-play">▶</span>}
      {more ? <span className="att-more">{t('att.more', { n: more })}</span> : null}
    </button>
  );
}

export function FileChip({ a, onRemove, status }: { a: { name: string; contentType: string; sizeBytes: number; signing?: AttachmentDTO['signing'] }; onRemove?: () => void; status?: string }) {
  return (
    <span className="att-file">
      <span className="att-file-ico" aria-hidden>{fileIcon(a)}</span>
      <span className="grow" style={{ minWidth: 0 }}>
        <b className="ellipsis" style={{ display: 'block' }}>{a.name}</b>
        <span className="small muted">{status ?? (a.signing ? <><span className="att-signed">{t('att.signedBy', { name: a.signing.signerName })}</span> · {fileSize(a.sizeBytes)}</> : fileSize(a.sizeBytes))}</span>
      </span>
      {onRemove && <button type="button" className="icon-btn" aria-label={t('att.remove')} onClick={onRemove}>×</button>}
    </span>
  );
}

/** Fotos y videos en cuadrícula (1–4 visibles + «+N») y archivos como fichas con descarga. */
export function AttachmentsView({ list, onCreateIssue }: { list: AttachmentDTO[]; onCreateIssue?: (title: string) => void }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const [pdf, setPdf] = useState<{ a: AttachmentDTO; sign: boolean } | null>(null);
  const voices = list.filter((a) => a.kind === 'voice');
  // Los videos van aparte, cada uno con su reproductor en la burbuja (no en la cuadrícula ni en el visor).
  const videos = list.filter((a) => a.kind !== 'voice' && isVideo(a));
  const visual = list.filter((a) => a.kind !== 'voice' && isImage(a));
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
      {videos.map((a) => <VideoCard key={a.id} a={a} />)}
      {files.map((a) => isPdf(a) ? (
        <div key={a.id} className="att-file-btn is-pdf">
          <button type="button" className="grow" style={{ border: 0, background: 'transparent', padding: 0, textAlign: 'left', minWidth: 0 }} title={t('att.preview')} onClick={() => setPdf({ a, sign: false })}>
            <FileChip a={a} />
          </button>
          <button type="button" className="att-sign" onClick={() => setPdf({ a, sign: true })}>✍️ {t('att.signBtn')}</button>
          <button type="button" className="icon-btn" aria-label={t('att.download')} onClick={() => void downloadAttachment(a)}>⤓</button>
        </div>
      ) : (
        <button key={a.id} type="button" className="att-file-btn" title={t('att.download')} onClick={() => void downloadAttachment(a)}>
          <FileChip a={a} />
          <span className="att-dl" aria-hidden>⤓</span>
        </button>
      ))}
      {viewing !== null && <Viewer list={visual} start={viewing} onClose={() => setViewing(null)} />}
      {pdf && (
        <Suspense fallback={<div className="pdf-sheet"><div className="pdf-msg"><span className="pdf-spin" /> {t('common.loading')}</div></div>}>
          <PdfSheet a={pdf.a} startSigning={pdf.sign} onClose={() => setPdf(null)} />
        </Suspense>
      )}
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
          : <img src={url} alt={a.name} />}
      </div>
      {i < list.length - 1 && <button className="viewer-nav next" aria-label={t('att.next')} onClick={() => setI(i + 1)}>›</button>}
    </div>
  );
}

// ---------- Videos en la burbuja (docs/VIDEO.md) ----------
/** URL prefirmada por adjunto, en caché mientras no venza (con 5 min de margen). */
const playCache = new Map<string, { url: string; until: number }>();
const playInflight = new Map<string, Promise<string>>();
export function videoPlayUrl(id: string, force = false): Promise<string> {
  const hit = playCache.get(id);
  if (!force && hit && hit.until > Date.now()) return Promise.resolve(hit.url);
  let p = playInflight.get(id);
  if (!p || force) {
    p = client.videoPlayUrl(id).then((r) => {
      playCache.set(id, { url: r.url, until: Date.now() + r.expiresIn * 1000 - 5 * 60_000 });
      return r.url;
    }).finally(() => playInflight.delete(id));
    playInflight.set(id, p);
  }
  return p;
}

/** Solo un video suena a la vez: al arrancar uno se pausa el anterior. */
let playingNow: HTMLVideoElement | null = null;
function claimPlayback(v: HTMLVideoElement) {
  if (playingNow && playingNow !== v && !playingNow.paused) playingNow.pause();
  playingNow = v;
}

/** true cuando el elemento entró (o está a 300 px de entrar) en pantalla; no vuelve a false. */
function useSeen(ref: React.RefObject<HTMLElement | null>) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

async function downloadVideo(a: AttachmentDTO) {
  try {
    const r = await client.videoPlayUrl(a.id, true);
    const link = document.createElement('a');
    link.href = r.url; link.rel = 'noopener'; link.download = a.name;
    document.body.appendChild(link); link.click(); link.remove();
  } catch (e) { toast(errorText(e) || t('att.unavailable')); }
}

/**
 * Tarjeta de video: póster (perezoso), ▶, duración y tamaño; sin descargar nada del video hasta tocar ▶.
 * Al tocar se monta el <video> ahí mismo con la URL prefirmada: el navegador pide rangos directo a S3 y arranca
 * sin bajarlo entero. Se pausa al salir de la vista y al cambiar de chat (se desmonta). Uno a la vez.
 */
export function VideoCard({ a }: { a: AttachmentDTO }) {
  const box = useRef<HTMLDivElement>(null);
  const vref = useRef<HTMLVideoElement>(null);
  const seen = useSeen(box);
  const { url: poster } = useBlobUrl(seen ? a.thumbUrl : null);
  const [active, setActive] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);
  const ratio = a.width && a.height ? a.width / a.height : 16 / 9;
  const portrait = ratio < 1;

  const start = async () => {
    setFailed(false);
    // El <video> se monta dentro del toque (así Safari deja reproducir con sonido cuando llegue la URL).
    flushSync(() => setActive(true));
    vref.current?.play().catch(() => {});
    try {
      const url = await videoPlayUrl(a.id);
      setSrc(url);
    } catch (e) { setActive(false); toast(errorText(e) || t('att.unavailable')); }
  };
  // Con la URL puesta: reproducir. Si el navegador no lo permite, quedan los controles para tocar ▶.
  useEffect(() => {
    const v = vref.current;
    if (!v || !src) return;
    v.play().catch(() => {});
  }, [src]);
  // Pausa al salir de la vista; al desmontar (otro chat) suelta la conexión.
  useEffect(() => {
    const v = vref.current, el = box.current;
    if (!active || !v || !el) return;
    const io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((es) => { if (es.every((e) => !e.isIntersecting) && !v.paused) v.pause(); }, { threshold: 0.15 })
      : null;
    io?.observe(el);
    return () => {
      io?.disconnect();
      v.pause();
      if (playingNow === v) playingNow = null;
      v.removeAttribute('src'); v.load();
    };
  }, [active]);
  // URL vencida o rechazada: se pide otra una vez y se sigue donde iba.
  const onError = () => {
    const v = vref.current;
    if (!v || !src) return;
    if (retried.current) { setFailed(true); return; }
    retried.current = true;
    const at = v.currentTime;
    videoPlayUrl(a.id, true).then((url) => {
      const el = vref.current;
      if (!el) return;
      el.src = url; // directo al elemento: React no lo toca si el estado ya tenía esa URL
      setSrc(url);
      el.addEventListener('loadedmetadata', () => { el.currentTime = at; void el.play().catch(() => {}); }, { once: true });
    }).catch(() => setFailed(true));
  };
  const dur = formatDuration(a.durationMs);
  return (
    <div ref={box} className={`vid-card${portrait ? ' portrait' : ''}${active ? ' is-active' : ''}`} style={{ aspectRatio: String(Math.min(16 / 9, Math.max(9 / 16, ratio))) }}>
      {active ? (
        <video
          ref={vref} src={src ?? undefined} poster={poster ?? undefined} preload="metadata" playsInline controls
          controlsList="nodownload" onPlay={(e) => claimPlayback(e.currentTarget)} onError={onError}
          onLoadedData={() => { retried.current = false; }}
        />
      ) : (
        <button type="button" className="vid-start" onClick={() => void start()} aria-label={`${t('att.play')}: ${a.name}${dur ? ` (${dur})` : ''}`}>
          {poster ? <img src={poster} alt="" draggable={false} loading="lazy" decoding="async" /> : <span className="att-tile-ph" aria-hidden>🎬</span>}
          <span className="vid-play" aria-hidden>▶</span>
          <span className="vid-meta">{dur && <span>{dur}</span>}<span>{formatBytes(a.sizeBytes, getLang())}</span></span>
        </button>
      )}
      {failed && <span className="vid-failed">{t('att.unavailable')}</span>}
      {!active && <button type="button" className="vid-dl" aria-label={t('att.download')} title={t('att.download')} onClick={() => void downloadVideo(a)}>⤓</button>}
    </div>
  );
}

// ---------- En el compositor ----------
export interface Draft {
  key: string; file: File; preview: string | null; status: 'compressing' | 'uploading' | 'done' | 'error'; dto?: AttachmentDTO; error?: string;
  /** Videos: se comprimen en el navegador y suben por la ruta de stream, con progreso 0–1 de cada fase. */
  video?: boolean; progress?: number;
}
export const isVideoFile = (f: File) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|3gp)$/i.test(f.name);

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
  const controllers = useRef(new Map<string, AbortController>());
  useEffect(() => () => { for (const c of controllers.current.values()) c.abort(); }, []);
  const draftsNow = useRef(drafts);
  draftsNow.current = drafts;
  useEffect(() => () => { for (const d of draftsNow.current) if (d.preview) URL.revokeObjectURL(d.preview); }, []);
  /** Progreso en pasos de 1 % (no re-renderiza el compositor en cada evento). */
  const lastPct = useRef(new Map<string, number>());
  const progress = (key: string, p: number) => {
    const pct = Math.floor(Math.max(0, Math.min(1, p)) * 100);
    if (lastPct.current.get(key) === pct) return;
    lastPct.current.set(key, pct);
    patch(key, { progress: pct / 100 });
  };

  async function uploadVideoDraft(d: Draft) {
    controllers.current.get(d.key)?.abort();
    const ctrl = new AbortController();
    controllers.current.set(d.key, ctrl);
    lastPct.current.delete(d.key);
    patch(d.key, { status: 'compressing', progress: 0, error: undefined });
    try {
      const { prepareVideo } = await import('../video-prep.ts');
      let shown = false;
      const showPoster = (b: Blob) => { if (shown || ctrl.signal.aborted) return; shown = true; patch(d.key, { preview: URL.createObjectURL(b) }); };
      const prep = await prepareVideo(d.file, (p) => progress(d.key, p), ctrl.signal, showPoster);
      if (prep.poster) showPoster(prep.poster);
      lastPct.current.delete(d.key);
      patch(d.key, { status: 'uploading', progress: 0 });
      const dto = await client.uploadVideo(conversationId, prep.blob, { name: prep.name, durationMs: prep.durationMs, width: prep.width, height: prep.height },
        { onProgress: (p) => progress(d.key, p), signal: ctrl.signal });
      if (prep.poster) { try { Object.assign(dto, await client.uploadAttachmentThumb(dto.id, prep.poster)); } catch { /* sin póster */ } }
      patch(d.key, { status: 'done', dto, progress: 1 });
    } catch (e: any) {
      if (ctrl.signal.aborted || e?.code === 'canceled') return;
      patch(d.key, { status: 'error', error: e?.code === 'too_big' ? t('att.videoTooBig', { name: d.file.name }) : errorText(e) });
    } finally { if (controllers.current.get(d.key) === ctrl) controllers.current.delete(d.key); }
  }

  async function uploadOne(d: Draft) {
    if (d.video) return uploadVideoDraft(d);
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
      // Los videos se comprimen antes de subir: el límite (150 MB) se revisa después de comprimir.
      if (isVideoFile(file)) { next.push({ key: `${Date.now()}-${Math.random()}`, file, preview: null, status: 'compressing', video: true, progress: 0 }); continue; }
      if (file.size > MAX_ATTACHMENT_BYTES) { toast(t('att.tooBig', { name: file.name })); continue; }
      next.push({ key: `${Date.now()}-${Math.random()}`, file, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null, status: 'uploading' });
    }
    setDrafts((ds) => [...ds, ...next]);
    for (const d of next) void uploadOne(d);
  }
  const remove = (key: string) => {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setDrafts((ds) => { const d = ds.find((x) => x.key === key); if (d?.preview) URL.revokeObjectURL(d.preview); return ds.filter((x) => x.key !== key); });
  };
  // Las vistas previas locales (blob:) se revocan al enviar o descartar; si no, cada foto adjunta quedaba en la RAM.
  const clear = () => setDrafts((ds) => { for (const d of ds) if (d.preview) URL.revokeObjectURL(d.preview); return []; });
  const retry = (key: string) => { const d = drafts.find((x) => x.key === key); if (d) void uploadOne(d); };
  return {
    drafts, add, remove, clear, retry,
    busy: drafts.some((d) => d.status === 'uploading' || d.status === 'compressing'),
    ready: drafts.filter((d) => d.status === 'done').map((d) => d.dto!),
    failed: drafts.some((d) => d.status === 'error'),
  };
}

export function DraftTray({ drafts, onRemove, onRetry }: { drafts: Draft[]; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  if (!drafts.length) return null;
  return (
    <div className="att-tray">
      {drafts.map((d) => d.video ? (
        <div key={d.key} className={`att-draft vid is-${d.status}`} title={d.error ?? d.file.name}>
          {d.preview ? <img src={d.preview} alt="" /> : <span className="att-tile-ph" aria-hidden>🎬</span>}
          {(d.status === 'compressing' || d.status === 'uploading') && (
            <span className="att-vstate" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((d.progress ?? 0) * 100)}
              aria-label={d.status === 'compressing' ? t('att.compressing', { p: Math.round((d.progress ?? 0) * 100) }) : t('att.uploadingPct', { p: Math.round((d.progress ?? 0) * 100) })}>
              <span className="att-vlabel">{d.status === 'compressing' ? t('att.compressing', { p: Math.round((d.progress ?? 0) * 100) }) : t('att.uploadingPct', { p: Math.round((d.progress ?? 0) * 100) })}</span>
              <span className="att-vbar"><span style={{ width: `${Math.round((d.progress ?? 0) * 100)}%` }} /></span>
            </span>
          )}
          {d.status === 'done' && d.dto && <span className="att-vstate done"><span className="att-vlabel">🎬 {[formatDuration(d.dto.durationMs), formatBytes(d.dto.sizeBytes, getLang())].filter(Boolean).join(' · ')}</span></span>}
          {d.status === 'error' && <button type="button" className="att-retry" onClick={() => onRetry(d.key)}>{t('att.retry')}</button>}
          <button type="button" className="att-x" aria-label={d.status === 'done' || d.status === 'error' ? t('att.remove') : t('att.cancel')} onClick={() => onRemove(d.key)}>×</button>
        </div>
      ) : d.preview ? (
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
