/**
 * /archivo/:token — ver un archivo que alguien mandó desde chaggu (por WhatsApp), sin cuenta. API: file-links.ts.
 */
import { useEffect, useState } from 'react';
import { apiUrl } from '../app-client.ts';
import { fileLinkDate } from '../file-links.ts';
import { t } from '../i18n.ts';
import { asset } from '../router.ts';
import { formatBytes } from '../video.ts';
import { getLang } from '../i18n.ts';
import './FileLinks.css';

interface Preview { name: string; contentType: string; viewable: boolean; sizeBytes: number; sharedBy: string | null; expiresAt: string }

export default function FileLinkScreen({ token }: { token: string }) {
  const [p, setP] = useState<Preview | null | 'gone'>(null);
  useEffect(() => {
    fetch(apiUrl(`/api/v1/file-links/${encodeURIComponent(token)}`)).then(async (r) => setP(r.ok ? await r.json() : 'gone')).catch(() => setP('gone'));
  }, [token]);
  const file = (download: boolean) => apiUrl(`/api/v1/file-links/${encodeURIComponent(token)}/file${download ? '?download=1' : ''}`);
  const icon = p && p !== 'gone' ? (p.contentType === 'application/pdf' ? '📕' : p.contentType.startsWith('image/') ? '🖼' : p.contentType.startsWith('video/') ? '🎬' : '📄') : '📄';
  return (
    <div className="auth flink-page">
      <img src={asset('/chaggu-logo.svg')} alt="chaggu" width={112} height={49} />
      {p === null && <div className="hint">…</div>}
      {p === 'gone' && <div className="flink-card"><h1 className="serif">{t('flink.gone')}</h1><p className="muted">{t('flink.goneBody')}</p></div>}
      {p && p !== 'gone' && (
        <div className="flink-card">
          <div className="small muted">{p.sharedBy ? t('flink.by', { name: p.sharedBy }) : t('flink.title')}</div>
          <div className="flink-file"><span className="flink-ico" aria-hidden>{icon}</span><div className="grow" style={{ minWidth: 0 }}><b className="ellipsis" title={p.name}>{p.name}</b><div className="small muted">{formatBytes(p.sizeBytes, getLang())}</div></div></div>
          <div className="row flink-actions">
            {p.viewable && <a className="btn primary" href={file(false)} target="_blank" rel="noopener noreferrer">{t('flink.view')}</a>}
            <a className="btn" href={file(true)}>{t('flink.download')}</a>
          </div>
          <p className="small muted">{t('flink.until', { date: fileLinkDate(p.expiresAt) })}</p>
        </div>
      )}
      <a className="small muted" href="https://chaggu.com">{t('flink.what')}</a>
    </div>
  );
}
