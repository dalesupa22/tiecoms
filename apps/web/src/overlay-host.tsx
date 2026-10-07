/**
 * Dónde se pintan los diálogos, menús y avisos. Normalmente al final de la app; con la llamada en pantalla completa
 * (pedido de Lorena, 7-oct-2026) dentro del panel de la llamada: con la Fullscreen API solo se ve el elemento en
 * pantalla completa, y sin ella el panel (z-index alto) tapaba el «＋ Agregar» y no se podía elegir a nadie.
 */
import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

let host: HTMLElement | null = null;
const listeners = new Set<() => void>();
/** El panel de la llamada se registra al entrar en pantalla completa y se quita al salir. */
export function setOverlayHost(el: HTMLElement | null) {
  if (host === el) return;
  host = el;
  listeners.forEach((l) => l());
}
export const overlayHost = () => host;

export function useOverlayHost() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => host);
}

/** Pinta `node` en su sitio o, si hay un panel en pantalla completa, dentro de él (con los colores de la app). */
export function InOverlayHost({ children }: { children: ReactNode }) {
  const el = useOverlayHost();
  if (!el) return <>{children}</>;
  return createPortal(<div className="on-paper overlay-in-host">{children}</div>, el);
}
