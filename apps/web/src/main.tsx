import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTextSize } from './text-size.ts';
import { initTheme } from './theme.ts';
import { App } from './App.tsx';
import { client, isDesktop } from './app-client.ts';
import { installMemoryTrim } from './memory-trim.ts';
import './styles.css';

void client.start();
// Oculta más de 5 min (pestaña de fondo, escritorio en la bandeja): se podan las cachés (docs/MEMORIA.md).
installMemoryTrim();
applyTextSize();
initTheme();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// Escritorio: enlaces chaggu://, contador en el Dock y avisos (la interfaz ya viene empaquetada, sin service worker).
if (isDesktop) void import('./desktop.ts').then((m) => m.initDesktop());
else if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {}); });
}
