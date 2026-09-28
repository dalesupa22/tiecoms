import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTextSize } from './text-size.ts';
import { App } from './App.tsx';
import { client } from './app-client.ts';
import './styles.css';

void client.start();
applyTextSize();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {}); });
}
