import { useSyncExternalStore } from 'react';
import type { Platform } from '@tiecoms/contracts';
import { browserLang } from './i18n.ts';
import { IndexedDbStorage, MemoryStorage, TieComsClient, type ClientNotice, type ClientState, type SecretStore } from '@tiecoms/client-core';

function makeStorage() {
  try { return typeof indexedDB !== 'undefined' ? new IndexedDbStorage('tiecoms') : new MemoryStorage(); } catch { return new MemoryStorage(); }
}

/** El mismo build corre en navegador, Tauri (macOS/Windows) y Capacitor (Android/iOS). */
function detectPlatform(): Platform {
  const w = window as any;
  if (w.Capacitor?.isNativePlatform?.()) return w.Capacitor.getPlatform() === 'ios' ? 'ios' : 'android';
  if (w.__TAURI_INTERNALS__) return navigator.userAgent.includes('Windows') ? 'windows' : 'macos';
  return 'web';
}

export const platform = detectPlatform();

/**
 * En apps nativas no hay cookie httpOnly de mismo origen: el refresh token se
 * guarda en el dispositivo. Provisional: localStorage de la WebView. Antes de
 * publicar en tiendas se sustituye por Keychain (iOS/macOS) y Keystore/Credential
 * Manager (Android/Windows) mediante un plugin nativo.
 */
const nativeSecrets: SecretStore = {
  async get() { try { return localStorage.getItem('tiecoms:rt'); } catch { return null; } },
  async set(t) { try { if (t) localStorage.setItem('tiecoms:rt', t); else localStorage.removeItem('tiecoms:rt'); } catch {} },
};

const en = browserLang() === 'en';
const mobile = navigator.userAgent.includes('Mobile');
const DEVICE_NAMES: Record<Platform, string> = {
  web: en ? (mobile ? 'Mobile browser' : 'Browser') : (mobile ? 'Navegador móvil' : 'Navegador'),
  macos: en ? 'Chaggu for Mac' : 'Chaggu para Mac', windows: en ? 'Chaggu for Windows' : 'Chaggu para Windows',
  android: 'Chaggu Android', ios: 'Chaggu iPhone', agent: en ? 'Agent' : 'Agente',
};

// En web, API en el mismo origen. En apps, la variable de build apunta a https://app.chaggu.com.
const baseUrl = (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? '';
/** Rutas del API usadas directamente por la interfaz (p. ej. fotos en <img>). */
export const apiUrl = (path: string) => `${baseUrl}${path}`;

/** La interfaz registra aquí cómo mostrar avisos (notificación del sistema y toast). */
export const notices: { handler: ((n: ClientNotice) => void) | null } = { handler: null };

export const client = new TieComsClient({
  onNotice: (n) => notices.handler?.(n),
  baseUrl,
  platform,
  deviceName: DEVICE_NAMES[platform],
  storage: makeStorage(),
  secrets: platform === 'web' ? undefined : nativeSecrets,
});

export function useClient<T>(select: (s: ClientState) => T): T {
  return useSyncExternalStore(client.subscribe, () => select(client.getState()));
}
