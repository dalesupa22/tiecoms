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

function go(path: string) {
  if (path.startsWith('/') && !path.startsWith('//')) navigate(path);
}

export async function initDesktop() {
  await listen<string>('chaggu:navigate', (e) => { void invoke('take_pending_path'); go(e.payload); });
  // Enlace con el que se abrió la app antes de que la interfaz escuchara.
  const pending = await invoke<string | null>('take_pending_path');
  if (pending) go(pending);

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
}
