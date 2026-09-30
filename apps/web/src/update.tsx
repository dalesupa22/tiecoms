import { useEffect, useState } from 'react';
import { locale, t } from './i18n.ts';
import { client, isDesktop } from './app-client.ts';

/**
 * «Hay una versión nueva» (docs/ACTUALIZAR.md). Cada build publica /version.json con su id; si una pestaña que
 * lleva rato abierta encuentra otro id, muestra una franja fija con «Recargar» que no se puede cerrar.
 * Se revisa al volver a la pestaña y cada 5 minutos. En desarrollo no hace nada. En escritorio (Mac/Windows) se
 * compara la versión de la app con /app-version y el botón lleva a la descarga.
 */
declare const __BUILD_ID__: string;
const EVERY = 5 * 60_000;

/** Escritorio: la web va empaquetada, así que se compara la versión de la app con app_releases (mac/windows). */
const desktopCode = (v: string) => { const m = v.match(/^(\d+)\.(\d+)\.(\d+)/); return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0; };
function DesktopUpdateBanner() {
  const [next, setNext] = useState<{ version: string; url: string } | null>(null);
  useEffect(() => {
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const mine = desktopCode(await getVersion());
        const platform = navigator.userAgent.includes('Mac') ? 'mac' : 'windows';
        const r = await client.request<{ latestVersion: string; latestBuild: number; url: string }>(`/app-version?platform=${platform}&lang=${locale()}`);
        if (mine && r.latestBuild > mine) setNext({ version: r.latestVersion, url: r.url });
      } catch { /* sin red: se reintenta */ } finally { busy = false; }
    };
    const timer = setInterval(check, EVERY);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    void check();
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); };
  }, []);
  if (!next) return null;
  return (
    <div className="update-bar" role="status">
      <span aria-hidden>✨</span>
      <span className="grow">{t('update.desktop', { v: next.version })}</span>
      <a className="btn small primary" href={next.url} target="_blank" rel="noopener noreferrer">{t('update.download')}</a>
    </div>
  );
}

export function UpdateBanner() {
  return isDesktop ? <DesktopUpdateBanner /> : <WebUpdateBanner />;
}

function WebUpdateBanner() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD || typeof __BUILD_ID__ === 'undefined') return;
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (r.ok) { const v = await r.json(); if (v?.build && v.build !== __BUILD_ID__) setStale(true); }
      } catch { /* sin red: se reintenta en la próxima revisión */ } finally { busy = false; }
    };
    const timer = setInterval(check, EVERY);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    void check();
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); };
  }, []);
  if (!stale) return null;
  return (
    <div className="update-bar" role="status">
      <span aria-hidden>✨</span>
      <span className="grow">{t('update.web')}</span>
      <button className="btn small primary" onClick={() => location.reload()}>{t('update.reload')}</button>
    </div>
  );
}
