import { useSyncExternalStore } from 'react';
import type { Platform } from '@tiecoms/contracts';
import { IndexedDbStorage, MemoryStorage, TieComsClient, type ClientState, type SecretStore } from '@tiecoms/client-core';

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

const platform = detectPlatform();

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

const DEVICE_NAMES: Record<Platform, string> = {
  web: navigator.userAgent.includes('Mobile') ? 'Navegador móvil' : 'Navegador',
  macos: 'TieComs para Mac', windows: 'TieComs para Windows', android: 'TieComs Android', ios: 'TieComs iPhone', agent: 'Agente',
};

// En web, API en el mismo origen. En apps, la variable de build apunta a https://app.tiecoms.com.
const baseUrl = (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? '';

export const client = new TieComsClient({
  baseUrl,
  platform,
  deviceName: DEVICE_NAMES[platform],
  storage: makeStorage(),
  secrets: platform === 'web' ? undefined : nativeSecrets,
});

export function useClient<T>(select: (s: ClientState) => T): T {
  return useSyncExternalStore(client.subscribe, () => select(client.getState()));
}
