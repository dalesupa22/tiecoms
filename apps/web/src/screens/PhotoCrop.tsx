import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { errorText, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { Modal } from '../ui.tsx';

const MAX_BYTES = 3 * 1024 * 1024;
const OUT = 512;
const VIEW = 280;

/**
 * Editor de recorte circular (mover y zoom) con vista previa, Cancelar y Guardar.
 * Mismo patrón que las apps: el resultado es un JPEG/WebP cuadrado de 512 px (siempre < 3 MB).
 */
export function PhotoCropDialog({ file, title, onSave, onClose }: { file: File; title: string; onSave: (image: Blob) => Promise<void>; onClose: () => void }) {
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    let alive = true;
    createImageBitmap(file).then((b) => { if (alive) setBmp(b); else b.close(); }).catch(() => setError(t('photo.invalid')));
    return () => { alive = false; };
  }, [file]);
  useEffect(() => () => bmp?.close(), [bmp]);

  // Escala base: el lado corto de la imagen llena el círculo.
  const base = bmp ? VIEW / Math.min(bmp.width, bmp.height) : 1;
  const clamp = (o: { x: number; y: number }, z = zoom) => {
    if (!bmp) return o;
    const w = bmp.width * base * z, h = bmp.height * base * z;
    const mx = Math.max(0, (w - VIEW) / 2), my = Math.max(0, (h - VIEW) / 2);
    return { x: Math.max(-mx, Math.min(mx, o.x)), y: Math.max(-my, Math.min(my, o.y)) };
  };

  const draw = (ctx: CanvasRenderingContext2D, size: number) => {
    if (!bmp) return;
    const k = size / VIEW;
    const w = bmp.width * base * zoom * k, h = bmp.height * base * zoom * k;
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, (size - w) / 2 + off.x * k, (size - h) / 2 + off.y * k, w, h);
  };
  useEffect(() => {
    const c = canvas.current?.getContext('2d');
    if (c) draw(c, VIEW);
    const p = preview.current?.getContext('2d');
    if (p) draw(p, 72);
  });

  const onDown = (e: RPointerEvent) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }; };
  const onMove = (e: RPointerEvent) => { const d = drag.current; if (d) setOff(clamp({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y })); };
  const onUp = () => { drag.current = null; };
  const setZ = (z: number) => { setZoom(z); setOff((o) => clamp(o, z)); };

  async function save() {
    if (!bmp) return;
    setBusy(true); setError(null);
    try {
      const out = document.createElement('canvas');
      out.width = out.height = OUT;
      draw(out.getContext('2d')!, OUT);
      let blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/webp', 0.86));
      if (!blob || blob.type !== 'image/webp') blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/jpeg', 0.88));
      if (!blob) throw new Error(t('photo.failed'));
      if (blob.size > MAX_BYTES) blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/jpeg', 0.7)) ?? blob;
      await onSave(blob);
      toast(t('photo.saved'));
      onClose();
    } catch (e) { setError(errorText(e) || t('photo.failed')); } finally { setBusy(false); }
  }

  return (
    <Modal title={title} onClose={() => !busy && onClose()}>
      {!bmp && !error && <div className="muted">{t('common.loading')}</div>}
      {bmp && (
        <>
          <div className="crop-stage" style={{ width: VIEW, height: VIEW }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            onWheel={(e) => setZ(Math.max(1, Math.min(4, zoom - e.deltaY / 400)))}>
            <canvas ref={canvas} width={VIEW} height={VIEW} />
            <div className="crop-mask" aria-hidden />
          </div>
          <div className="hint" style={{ textAlign: 'center' }}>{t('photo.cropHint')}</div>
          <label className="row small" style={{ gap: 10 }}>
            <span>{t('photo.zoom')}</span>
            <input className="grow" type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZ(Number(e.target.value))} aria-label={t('photo.zoom')} />
          </label>
          <div className="row" style={{ gap: 12 }}>
            <canvas ref={preview} width={72} height={72} className="crop-preview" aria-label={t('photo.preview')} />
            <span className="small muted grow">{t('photo.preview')}{file.size > MAX_BYTES ? ` · ${t('photo.compressed')}` : ''}</span>
          </div>
        </>
      )}
      {busy && <div className="progress" role="progressbar" aria-label={t('photo.saving')}><span /></div>}
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" disabled={busy} onClick={onClose}>{t('photo.cancel')}</button>
        <button className="btn primary" disabled={busy || !bmp} onClick={save}>{busy ? t('photo.saving') : t('photo.save')}</button>
      </div>
    </Modal>
  );
}

/** Abre el selector de archivos y devuelve la imagen elegida (o null). */
export function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/heic,image/*';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
