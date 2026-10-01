/**
 * Solo en la app de escritorio (Tauri, macOS y Windows). La envoltura en Rust se encarga de
 * abrir enlaces externos en el navegador, las descargas y el Llavero; aquí va lo que depende
 * del estado de la interfaz: navegar con los enlaces chaggu:// y el contador de no leídos.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { client } from './app-client.ts';
import { navigate } from './router.ts';
import { pendingOf } from './screens/Shell.tsx';
import { currentTheme, subscribeTheme, themePreference } from './theme.ts';

function go(path: string) {
  if (path.startsWith('/') && !path.startsWith('//')) navigate(path);
}

export async function initDesktop() {
  await listen<string>('chaggu:navigate', (e) => { void invoke('take_pending_path'); go(e.payload); });
  // Enlace con el que se abrió la app antes de que la interfaz escuchara.
  const pending = await invoke<string | null>('take_pending_path');
  if (pending) go(pending);

  // Tema: la barra de título nativa y el fondo de la ventana acompañan a la web; Rust lo guarda para el próximo arranque.
  let sentTheme = '';
  const syncTheme = () => {
    const pref = themePreference(), dark = currentTheme() === 'dark', key = `${pref}:${dark}`;
    if (key === sentTheme) return;
    sentTheme = key;
    void invoke('set_theme', { pref, dark }).catch(() => {});
  };
  subscribeTheme(syncTheme);
  syncTheme();

  const win = getCurrentWindow();
  const mac = navigator.userAgent.includes('Mac');
  let shown = -1;
  let lastUnread = 0;
  const update = () => {
    const d = client.getState().data;
    const unread = d ? d.conversations.reduce((n, c) => n + pendingOf(c), 0) : 0;
    // Windows no tiene globo en el ícono: la barra de tareas parpadea cuando llega algo nuevo con la ventana en segundo plano.
    if (!mac && unread > lastUnread && !document.hasFocus()) void win.requestUserAttention(2).catch(() => {});
    lastUnread = unread;
    if (unread === shown || !mac) return;
    shown = unread;
    void win.setBadgeCount(unread > 0 ? unread : undefined).catch(() => {});
  };
  client.subscribe(update);
  update();

  // Sin el menú nativo del WebView («Atrás / Recargar»): donde la app no pone el suyo, no sale nada. Se deja en
  // campos de texto y con texto seleccionado (copiar, pegar, revisar ortografía).
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest('input, textarea, [contenteditable="true"], [contenteditable=""]') || (getSelection()?.toString() ?? '') !== '') return;
    e.preventDefault();
  });

  // Cerrar la ventana durante una llamada no la esconde: pasa al modo mini, siempre encima.
  await listen('chaggu:closed', () => {
    void import('./call.ts').then((m) => {
      const v = m.currentCall();
      if (v && v.phase !== 'ended') window.dispatchEvent(new CustomEvent('chaggu:call-mini'));
    });
  });
}

// ---------- Modo mini de la llamada (como la ventana flotante de Meet) ----------
/**
 * El WebView de Mac no tiene Document Picture-in-Picture: la ventana de chaggu se achica a la llamada y queda
 * siempre encima de las demás apps. Al salir vuelve a su tamaño y lugar. `html.call-mini` hace que se vea solo
 * la llamada (styles.css).
 */
let saved: { w: number; h: number; x: number; y: number; minW: number; minH: number } | null = null;
export async function setCallMini(on: boolean) {
  const { LogicalSize, LogicalPosition } = await import('@tauri-apps/api/dpi');
  const win = getCurrentWindow();
  const scale = await win.scaleFactor();
  if (on && !saved) {
    const size = (await win.innerSize()).toLogical(scale);
    const pos = (await win.outerPosition()).toLogical(scale);
    saved = { w: size.width, h: size.height, x: pos.x, y: pos.y, minW: 380, minH: 560 };
    document.documentElement.classList.add('call-mini');
    await win.setMinSize(new LogicalSize(300, 220));
    await win.setSize(new LogicalSize(400, 340));
    // Abajo a la derecha de la pantalla, como Meet.
    const sw = screen.availWidth, sh = screen.availHeight;
    await win.setPosition(new LogicalPosition(Math.max(0, sw - 420), Math.max(0, sh - 380)));
    await win.setAlwaysOnTop(true);
    await win.show(); await win.unminimize();
  } else if (!on && saved) {
    const s = saved;
    saved = null;
    document.documentElement.classList.remove('call-mini');
    await win.setAlwaysOnTop(false);
    await win.setMinSize(new LogicalSize(s.minW, s.minH));
    await win.setSize(new LogicalSize(s.w, s.h));
    await win.setPosition(new LogicalPosition(s.x, s.y));
    await win.setFocus();
  }
}
export const isCallMini = () => !!saved;

// Solo en compilaciones de prueba (VITE_CHAGGU_PROBE=1): deja probar el modo mini desde afuera.
if (import.meta.env.VITE_CHAGGU_PROBE) (window as any).__chagguMini = setCallMini;
