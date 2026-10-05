import type { AttachmentDTO } from '@tiecoms/contracts';
import { useBlobUrl, downloadAttachment, fileSize, isImage } from './Attachments.tsx';
import { MAX_TEXT_BYTES, isTextFile } from '../text-files.ts';
import { openCodeViewer } from '../code-viewer.tsx';
import { taskText } from './TaskReports.tsx';
function TaskImage({ file }: { file: AttachmentDTO }) {
  const { url: src } = useBlobUrl(file.thumbUrl ?? file.url);
  return src ? <img src={src} alt={file.name} style={{ width: 96, maxHeight: 96, objectFit: 'cover', borderRadius: 8 }} /> : <span>🖼</span>;
}
export function TaskAttachments({ files, onRemove, disabled }: { files: AttachmentDTO[]; onRemove: (id: string) => void; disabled?: boolean }) {
  return <div className="list" style={{ gap: 6 }}>{files.map((a) => <div key={a.id} className="card row" style={{ padding: 10, gap: 10 }}>
    <button type="button" className="link-btn row grow" style={{ textAlign: 'left', gap: 10 }} onClick={() => isTextFile(a) && a.sizeBytes <= MAX_TEXT_BYTES ? openCodeViewer(a) : void downloadAttachment(a)}>
      {isImage(a) ? <TaskImage file={a} /> : <span>{isTextFile(a) ? '🧾' : '📎'}</span>}<span className="grow" style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{a.name}</b><small className="muted">{fileSize(a.sizeBytes)} · {isTextFile(a) && a.sizeBytes <= MAX_TEXT_BYTES ? taskText('Abrir', 'Open') : taskText('Descargar', 'Download')}</small></span>
    </button><button type="button" className="icon-btn" disabled={disabled} aria-label={`${taskText('Quitar', 'Remove')} ${a.name}`} onClick={() => onRemove(a.id)}>×</button>
  </div>)}</div>;
}
