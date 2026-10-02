import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { getLang, t } from '../i18n.ts';
import { menuProps, type MenuItem } from '../menu.tsx';
import { IMAGE_ZOOM_MAX, imageFit, imagePan, imageZoom, imageZoomAt, type ImagePoint, type ImageSize } from '../image-view.ts';
import './ImageViewer.css';

interface Props {
  name: string; url: string | null; failed: boolean; count: string;
  onClose: () => void; onDownload: () => void;
  onPrevious?: () => void; onNext?: () => void;
  imageMenu: () => MenuItem[];
}
const empty = { width: 0, height: 0 };
const center = { x: 0, y: 0 };

/** Uses the original img element at every scale, including animated GIFs. */
export function ImageViewer({ name, url, failed, count, onClose, onDownload, onPrevious, onNext, imageMenu }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<ImageSize>(empty);
  const [viewport, setViewport] = useState<ImageSize>(empty);
  const [manual, setManual] = useState<number | null>(null);
  const [offset, setOffset] = useState<ImagePoint>(center);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, ImagePoint>());
  const keyHandler = useRef<(event: globalThis.KeyboardEvent) => void>(() => {});
  const fit = imageFit(natural, viewport);
  const scale = manual === null ? fit : imageZoom(manual, fit);
  const pan = imagePan(offset, natural, viewport, scale);
  const ready = !!url && natural.width > 0 && !failed && !decodeFailed;
  const canPan = ready && (natural.width * scale > viewport.width + 1 || natural.height * scale > viewport.height + 1);
  const en = getLang() === 'en';
  // Gesture handlers always consume the latest position, even between pointer events and React renders.
  const current = useRef({ natural, viewport, fit, scale, pan, ready });
  current.current = { natural, viewport, fit, scale, pan, ready };
  const changeZoom = (value: number, anchor = center) => {
    const s = current.current;
    if (!s.ready) return;
    const next = imageZoom(value, s.fit);
    const position = imagePan(imageZoomAt(s.pan, anchor, s.scale, next), s.natural, s.viewport, next);
    current.current = { ...s, scale: next, pan: position };
    setManual(next); setOffset(position);
  };
  const resetFit = () => { setManual(null); setOffset(center); };
  const anchorAt = (x: number, y: number) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
  };

  useLayoutEffect(() => {
    const el = stage.current!;
    el.focus({ preventScroll: true });
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure); observer.observe(el);
    // A non-passive listener only on the image area also handles trackpad pinch.
    const wheel = (e: WheelEvent) => {
      if (!current.current.ready || !e.deltaY) return;
      e.preventDefault();
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
      changeZoom(current.current.scale * Math.exp(-Math.max(-100, Math.min(100, delta)) * .005), anchorAt(e.clientX, e.clientY));
    };
    // Context menus live in a sibling portal. After they close the browser can
    // leave focus on body; keep Escape/Tab usable without intercepting the menu.
    const outsideKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!dialog.current?.contains(target) && !target?.closest?.('.ctx-menu')) keyHandler.current(e);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', outsideKey);
    return () => { observer.disconnect(); el.removeEventListener('wheel', wheel); window.removeEventListener('keydown', outsideKey); pointers.current.clear(); };
  }, []);

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(e.pointerId);
    if (!previous) return;
    const point = { x: e.clientX, y: e.clientY };
    const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)?.[1];
    if (other) {
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(point.x - other.x, point.y - other.y);
      if (before > 0) changeZoom(current.current.scale * after / before, anchorAt((point.x + other.x) / 2, (point.y + other.y) / 2));
    } else {
      const s = current.current;
      const next = imagePan({ x: s.pan.x + point.x - previous.x, y: s.pan.y + point.y - previous.y }, s.natural, s.viewport, s.scale);
      current.current = { ...s, pan: next }; setOffset(next);
    }
    pointers.current.set(e.pointerId, point);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (!pointers.current.size) setDragging(false);
  };
  const keyboard = (e: KeyboardEvent<HTMLDivElement> | globalThis.KeyboardEvent) => {
    if (e.key === 'Tab') {
      const stops = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')];
      const index = stops.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && index <= 0) { e.preventDefault(); stops.at(-1)?.focus(); }
      else if (!e.shiftKey && (index === stops.length - 1 || index === -1)) { e.preventDefault(); stops[0]?.focus(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') onClose();
    else if (e.key === '+' || e.key === '=') changeZoom(scale * 1.25);
    else if (e.key === '-') changeZoom(scale / 1.25);
    else if (e.key === '0') resetFit();
    else if (e.key === '1') changeZoom(1);
    else if (e.key === 'ArrowLeft' && !e.shiftKey) onPrevious?.();
    else if (e.key === 'ArrowRight' && !e.shiftKey) onNext?.();
    else if (e.key.startsWith('Arrow')) setOffset(imagePan({ x: pan.x + (e.key === 'ArrowLeft' ? 60 : e.key === 'ArrowRight' ? -60 : 0), y: pan.y + (e.key === 'ArrowUp' ? 60 : e.key === 'ArrowDown' ? -60 : 0) }, natural, viewport, scale));
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  keyHandler.current = keyboard;
  return <div ref={dialog} className="image-viewer" role="dialog" aria-modal="true" aria-label={t('att.viewer')} onKeyDown={keyboard}>
    <div className="image-viewer-bar">
      <span className="image-viewer-name" title={name}>{name}{count && ` · ${count}`}</span>
      <div className="image-viewer-tools" role="group" aria-label={en ? 'Image zoom' : 'Zoom de imagen'}>
        <button type="button" aria-label={en ? 'Zoom out' : 'Alejar'} title={en ? 'Zoom out (−)' : 'Alejar (−)'} disabled={!ready || scale <= Math.min(.1, fit)} onClick={() => changeZoom(scale / 1.25)}>−</button>
        <output className="image-viewer-percent" aria-live="polite">{ready ? `${Math.round(scale * 100)}%` : '—'}</output>
        <button type="button" aria-label={en ? 'Zoom in' : 'Acercar'} title={en ? 'Zoom in (+)' : 'Acercar (+)'} disabled={!ready || scale >= IMAGE_ZOOM_MAX} onClick={() => changeZoom(scale * 1.25)}>+</button>
        <button type="button" className="image-viewer-fit" aria-pressed={manual === null} title={en ? 'Fit image (0)' : 'Ajustar imagen (0)'} disabled={!ready} onClick={resetFit}>{en ? 'Fit' : 'Ajustar'}</button>
        <button type="button" className="image-viewer-actual" aria-label={en ? 'Actual size, 100%' : 'Tamaño real, 100%'} title={en ? 'Actual size (1)' : 'Tamaño real (1)'} disabled={!ready} onClick={() => { changeZoom(1); setOffset(center); }}>100%</button>
      </div>
      <button type="button" aria-label={t('att.download')} title={t('att.download')} onClick={onDownload}>⤓</button>
      <button type="button" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>×</button>
    </div>
    <div className="image-viewer-body">
      <button type="button" className="image-viewer-nav" aria-label={t('att.prev')} disabled={!onPrevious} onClick={onPrevious}>‹</button>
      <div ref={stage} className={`image-viewer-stage${canPan ? ' can-pan' : ''}${dragging ? ' is-dragging' : ''}`} tabIndex={0}
        aria-label={en ? 'Image. Plus and minus to zoom; 0 to fit; 1 for actual size. Shift and arrow keys to pan.' : 'Imagen. Más y menos para zoom; 0 para ajustar; 1 para tamaño real. Mayúsculas y flechas para desplazar.'}
        onDoubleClick={(e) => { if (!ready) return; if (manual === null) changeZoom(fit < 1 ? 1 : 2, anchorAt(e.clientX, e.clientY)); else resetFit(); }}
        onPointerDown={(e) => { if (!ready || e.button !== 0) return; stage.current!.focus({ preventScroll: true }); pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); }}
        onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
        {(failed || decodeFailed) ? <div className="image-viewer-message" role="status">{t('att.unavailable')}</div>
          : !url ? <div className="image-viewer-message" role="status">{t('common.loading')}</div>
          : <img src={url} alt={name} draggable={false} {...menuProps(imageMenu)}
              onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
              onError={() => { setDecodeFailed(true); setNatural(empty); resetFit(); }}
              style={{ width: natural.width * scale, height: natural.height * scale, visibility: ready ? 'visible' : 'hidden', transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)` }} />}
      </div>
      <button type="button" className="image-viewer-nav" aria-label={t('att.next')} disabled={!onNext} onClick={onNext}>›</button>
    </div>
    <div className="image-viewer-hint">{en ? 'Double-click: fit / zoom · Scroll: zoom · Drag: move · Esc: close' : 'Doble clic: ajustar / ampliar · Rueda: zoom · Arrastrar: mover · Esc: cerrar'}</div>
  </div>;
}
