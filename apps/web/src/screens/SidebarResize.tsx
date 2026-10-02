import { useEffect, useRef, useState, type RefObject } from 'react';
import { locale } from '../i18n.ts';
import { clampSidebarWidth, readSidebarWidth, saveSidebarWidth, sidebarBounds, sidebarWidthGesture, type SidebarBounds, type SidebarProvider } from '../sidebar-resize.ts';
import './SidebarResize.css';

type Gesture = ReturnType<typeof sidebarWidthGesture>;
interface ActiveGesture { gesture: Gesture; pointerId?: number; startX?: number; startWidth?: number; target?: HTMLDivElement }

/** Only this separator rerenders while dragging; mounted mail/WhatsApp panes stay untouched. */
export function SidebarResize({ shellRef, provider }: { shellRef: RefObject<HTMLDivElement | null>; provider: SidebarProvider }) {
  const logicalWidth = useRef(readSidebarWidth(localStorage, provider));
  const active = useRef<ActiveGesture | null>(null);
  const [value, setValue] = useState({ min: 240, max: 720, now: 272 });
  const english = locale().startsWith('en');
  const name = provider === 'mail' ? (english ? 'Mail' : 'Correo') : 'WhatsApp';
  const getBounds = (): SidebarBounds => {
    const shell = shellRef.current;
    const rail = shell?.querySelector('.rail');
    const zoom = shell ? parseFloat(getComputedStyle(shell).getPropertyValue('--ui-zoom')) : 1;
    return sidebarBounds(shell?.clientWidth ?? 0, rail?.getBoundingClientRect().width ?? 0, zoom);
  };
  const paint = (width: number) => {
    logicalWidth.current = width;
    const bounds = getBounds(), physical = clampSidebarWidth(width * bounds.zoom, bounds);
    shellRef.current?.style.setProperty('--provider-sidebar-width', `${physical}px`);
    setValue({ min: Math.round(bounds.min), max: Math.round(bounds.max), now: Math.round(physical) });
  };
  const end = (cancel: boolean) => {
    const current = active.current;
    if (!current) return;
    active.current = null; // lostpointercapture must not cancel a completed gesture.
    if (cancel) current.gesture.cancel(); else current.gesture.finish();
    document.documentElement.classList.remove('provider-sidebar-is-resizing');
    if (current.pointerId !== undefined && current.target?.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  };
  const begin = (): Gesture => sidebarWidthGesture(logicalWidth.current, paint, (width) => saveSidebarWidth(localStorage, provider, width));
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const resize = () => paint(logicalWidth.current);
    const cancel = () => end(true);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && active.current) { event.preventDefault(); cancel(); } };
    const visibility = () => { if (document.hidden) cancel(); };
    const observer = new ResizeObserver(resize);
    observer.observe(shell);
    const rail = shell.querySelector('.rail');
    if (rail) observer.observe(rail);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape);
    document.addEventListener('visibilitychange', visibility);
    resize();
    return () => {
      cancel(); observer.disconnect(); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape); document.removeEventListener('visibilitychange', visibility);
      shell.style.removeProperty('--provider-sidebar-width');
    };
  }, [provider, shellRef]);
  return <div className="provider-sidebar-resize" role="separator" aria-orientation="vertical" tabIndex={0}
    aria-label={english ? `Resize ${name} sidebar` : `Cambiar ancho lateral de ${name}`}
    aria-controls={`provider-sidebar-${provider}`} aria-valuemin={value.min} aria-valuemax={value.max} aria-valuenow={value.now}
    aria-valuetext={`${value.now} ${english ? 'pixels' : 'píxeles'}`} title={english ? 'Drag to resize · ← → arrows · Escape to cancel' : 'Arrastra para cambiar ancho · flechas ← → · Escape cancela'}
    onPointerDown={(event) => {
      if (event.button !== 0 || !event.isPrimary || active.current) return;
      event.preventDefault();
      const bounds = getBounds();
      event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      active.current = { gesture: begin(), pointerId: event.pointerId, target: event.currentTarget, startX: event.clientX, startWidth: clampSidebarWidth(logicalWidth.current * bounds.zoom, bounds) };
      document.documentElement.classList.add('provider-sidebar-is-resizing');
    }}
    onPointerMove={(event) => {
      const current = active.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const bounds = getBounds();
      current.gesture.update(clampSidebarWidth(current.startWidth! + event.clientX - current.startX!, bounds) / bounds.zoom);
    }}
    onPointerUp={(event) => { if (active.current?.pointerId === event.pointerId) end(false); }}
    onPointerCancel={(event) => { if (active.current?.pointerId === event.pointerId) end(true); }}
    onLostPointerCapture={(event) => { if (active.current?.pointerId === event.pointerId) end(true); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { if (active.current) { event.preventDefault(); end(true); } return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || active.current?.pointerId !== undefined) return;
      event.preventDefault();
      if (!active.current) active.current = { gesture: begin() };
      const bounds = getBounds(), current = clampSidebarWidth(logicalWidth.current * bounds.zoom, bounds), step = (event.shiftKey ? 48 : 16) * bounds.zoom;
      const next = event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : current + (event.key === 'ArrowRight' ? step : -step);
      active.current.gesture.update(clampSidebarWidth(next, bounds) / bounds.zoom);
    }}
    onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && active.current?.pointerId === undefined) end(false); }}
    onBlur={() => { if (active.current?.pointerId === undefined) end(false); }} />;
}
