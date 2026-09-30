import { useEffect, useState } from 'react';
import { t } from './i18n.ts';

/**
 * «Hay una versión nueva» (docs/ACTUALIZAR.md). Cada build publica /version.json con su id; si una pestaña que
 * lleva rato abierta encuentra otro id, muestra una franja fija con «Recargar» que no se puede cerrar.
 * Se revisa al volver a la pestaña y cada 5 minutos. En desarrollo no hace nada.
 */
declare const __BUILD_ID__: string;
const EVERY = 5 * 60_000;

export function UpdateBanner() {
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
