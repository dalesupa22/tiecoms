import { useEffect, useState } from 'react';
import type { AttachmentDTO } from '@tiecoms/contracts';
import { blobUrl, downloadAttachment, fileSize, isImage } from './Attachments.tsx';
import { taskText } from './TaskReports.tsx';
function TaskImage({ file }: { file: AttachmentDTO }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { let active = true; blobUrl(file.thumbUrl ?? file.url).then((u) => active && setSrc(u)).catch(() => {}); return () => { active = false; }; }, [file.url, file.thumbUrl]);
  return src ? <img src={src} alt={file.name} style={{ width: 96, maxHeight: 96, objectFit: 'cover', borderRadius: 8 }} /> : <span>🖼</span>;
}
export function TaskAttachments({ files, onRemove, disabled }: { files: AttachmentDTO[]; onRemove: (id: string) => void; disabled?: boolean }) {
  return <div className="list" style={{ gap: 6 }}>{files.map((a) => <div key={a.id} className="card row" style={{ padding: 10, gap: 10 }}>
    <button type="button" className="link-btn row grow" style={{ textAlign: 'left', gap: 10 }} onClick={() => void downloadAttachment(a)}>
      {isImage(a) ? <TaskImage file={a} /> : <span>📎</span>}<span className="grow" style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{a.name}</b><small className="muted">{fileSize(a.sizeBytes)} · {taskText('Descargar', 'Download')}</small></span>
    </button><button type="button" className="icon-btn" disabled={disabled} aria-label={`${taskText('Quitar', 'Remove')} ${a.name}`} onClick={() => onRemove(a.id)}>×</button>
  </div>)}</div>;
}
