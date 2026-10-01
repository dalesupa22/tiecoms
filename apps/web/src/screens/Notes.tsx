import { useEffect, useRef, useState } from 'react';
import type { DriveFileDTO, NoteDTO, NoteInput, NoteTagDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, getLang, locale } from '../i18n.ts';
import { Modal, conversationTitle } from '../ui.tsx';
import { fileIcon, size } from './Files.tsx';
import '../personal.css';

const tr = (es: string, en: string) => getLang() === 'en' ? en : es;
export const notesApi = {
  list: () => client.request<NoteDTO[]>('/notes'),
  save: (note: NoteInput, id?: string) => client.request<NoteDTO>(id ? `/notes/${id}` : '/notes', { method: id ? 'PUT' : 'POST', json: note }),
  remove: (id: string) => client.request(`/notes/${id}`, { method: 'DELETE' }),
};

export function NotesScreen() {
  const [notes, setNotes] = useState<NoteDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [view, setView] = useState<'cards' | 'list'>('cards');
  const [editing, setEditing] = useState<NoteDTO | 'new' | null>(null);
  async function load() {
    try { setNotes(await notesApi.list()); setError(null); } catch (e) { setError(errorText(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); const refresh = () => { void load(); }; window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, []);
  const search = q.toLocaleLowerCase();
  const visible = notes.filter((note) => [note.title, note.body, ...note.tags.map((tag) => tag.label)].some((text) => text.toLocaleLowerCase().includes(search)));
  return <div className="page"><div className="page-head"><div className="row"><h1 className="grow">{tr('Mis notas', 'My notes')}</h1><button className="btn primary" onClick={() => setEditing('new')}>＋ {tr('Nueva nota', 'New note')}</button></div><p className="muted">🔒 {tr('Solo tú puedes verlas. Etiquetar un grupo, chat o tarea no publica mensajes allí.', 'Only you can see them. Tagging a group, chat or task does not post messages there.')}</p></div>
    <div className="row"><input className="input grow" type="search" placeholder={tr('Buscar notas o etiquetas', 'Search notes or tags')} value={q} onChange={(event) => setQ(event.target.value)} /><div className="row" role="group" aria-label={tr('Vista', 'View')}><button className={`btn small ${view === 'cards' ? 'primary' : 'ghost'}`} aria-pressed={view === 'cards'} onClick={() => setView('cards')}>▦ {tr('Tarjetas', 'Cards')}</button><button className={`btn small ${view === 'list' ? 'primary' : 'ghost'}`} aria-pressed={view === 'list'} onClick={() => setView('list')}>☷ {tr('Lista', 'List')}</button></div></div>
    {error && <div className="error" role="alert">{error} <button className="link-btn" onClick={() => void load()}>{tr('Reintentar', 'Retry')}</button></div>}
    <div className={`personal-notes ${view}`}>{visible.map((note) => <button key={note.id} className="card personal-note" onClick={() => setEditing(note)}><b>{note.title}</b><span className="personal-note-body">{note.body || tr('Sin texto', 'No text')}</span><span className="row" style={{ flexWrap: 'wrap' }}>{note.tags.map((tag, index) => <span key={`${tag.kind}:${tag.id ?? tag.label}:${index}`} className="tag">{tag.kind === 'issue' ? '◆ ' : tag.kind === 'conversation' ? '💬 ' : '# '}{tag.label}</span>)}</span><span className="small muted">{note.files.length ? `📎 ${note.files.length} · ` : ''}{note.links.length ? `🔗 ${note.links.length} · ` : ''}{new Date(note.updatedAt).toLocaleDateString(locale())}</span></button>)}</div>
    {!visible.length && <div className="empty">{loading ? tr('Cargando notas…', 'Loading notes…') : tr('Crea una nota para guardar ideas, documentos y enlaces privados.', 'Create a note to save private ideas, documents and links.')}</div>}
    {editing && <NoteDialog note={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={(note) => { setNotes((current) => [note, ...current.filter((item) => item.id !== note.id)]); setEditing(null); }} onDeleted={(id) => { setNotes((current) => current.filter((note) => note.id !== id)); setEditing(null); }} />}
  </div>;
}

function NoteDialog({ note, onClose, onSaved, onDeleted }: { note?: NoteDTO; onClose: () => void; onSaved: (note: NoteDTO) => void; onDeleted: (id: string) => void }) {
  const d = useClient((state) => state.data)!;
  const issues = useClient((state) => state.issues);
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [tags, setTags] = useState<NoteTagDTO[]>(note?.tags ?? []);
  const [files, setFiles] = useState<DriveFileDTO[]>(note?.files ?? []);
  const [links, setLinks] = useState<string[]>(note?.links ?? []);
  const [link, setLink] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ file: DriveFileDTO; url: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { void client.loadIssues({}).catch(() => {}); }, []);
  function addTag(tag: NoteTagDTO) {
    if (!tags.some((existing) => existing.kind === tag.kind && (tag.id ? existing.id === tag.id : existing.label === tag.label))) setTags((current) => [...current, tag]);
  }
  function addLink() {
    try { const url = new URL(link.trim()); if (!['https:', 'http:'].includes(url.protocol)) throw new Error(); setLinks((current) => [...new Set([...current, url.href])]); setLink(''); setError(null); } catch { setError(tr('Escribe un enlace http o https válido.', 'Enter a valid http or https link.')); }
  }
  async function upload(selected: File[]) {
    setBusy(true); setError(null);
    try {
      for (const file of selected) {
        if (!file.size || file.size > 25 * 1024 * 1024) throw new Error(tr('Cada archivo debe pesar entre 1 byte y 25 MB.', 'Each file must be between 1 byte and 25 MB.'));
        if (files.length + selected.length > 50) throw new Error(tr('Una nota admite hasta 50 archivos.', 'A note supports up to 50 files.'));
        const saved = await client.request<DriveFileDTO>(`/drive/files?${new URLSearchParams({ name: file.name })}`, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream', 'x-file-type': file.type || 'application/octet-stream' } });
        setFiles((current) => [...current, saved]);
      }
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function openFile(file: DriveFileDTO) {
    try { const data = await client.request<{ url: string }>(`/drive/files/${file.id}/link`); setPreview({ file, url: data.url }); } catch (e) { setError(errorText(e)); }
  }
  async function save() {
    setBusy(true); setError(null);
    try { onSaved(await notesApi.save({ title: title.trim(), body, tags, fileIds: files.map((file) => file.id), links }, note?.id)); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!note || !confirm(tr('Eliminar esta nota? Los archivos siguen en Mis archivos.', 'Delete this note? Attachments remain in My files.'))) return;
    setBusy(true); setError(null);
    try { await notesApi.remove(note.id); onDeleted(note.id); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Modal title={tr(note ? 'Editar nota privada' : 'Nueva nota privada', note ? 'Edit private note' : 'New private note')} onClose={onClose}>
    <input className="input" aria-label={tr('Título', 'Title')} placeholder={tr('Título de la nota', 'Note title')} maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
    <textarea className="input" aria-label={tr('Texto de la nota', 'Note text')} rows={8} maxLength={50000} placeholder={tr('Escribe aquí…', 'Write here…')} value={body} onChange={(event) => setBody(event.target.value)} />
    <div className="row" style={{ flexWrap: 'wrap' }}>{tags.map((tag, index) => <button className="tag" key={index} onClick={() => setTags((current) => current.filter((_, at) => at !== index))} title={tr('Quitar etiqueta', 'Remove tag')}>{tag.label} ×</button>)}</div>
    <div className="row"><input className="input grow" maxLength={120} placeholder={tr('Etiqueta personal', 'Personal tag')} value={label} onChange={(event) => setLabel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && label.trim()) { addTag({ kind: 'label', label: label.trim() }); setLabel(''); } }} /><button className="btn small" disabled={!label.trim() || tags.length >= 50} onClick={() => { addTag({ kind: 'label', label: label.trim() }); setLabel(''); }}>＋</button></div>
    <div className="row"><select className="input grow" aria-label={tr('Etiquetar grupo o chat', 'Tag a group or chat')} value="" onChange={(event) => { const conv = d.conversations.find((c) => c.id === event.target.value); if (conv) addTag({ kind: 'conversation', id: conv.id, label: conversationTitle(d, conv).slice(0, 120) }); }}><option value="">{tr('Etiquetar grupo o chat…', 'Tag a group or chat…')}</option>{d.conversations.map((conv) => <option key={conv.id} value={conv.id}>{conversationTitle(d, conv)}</option>)}</select><select className="input grow" aria-label={tr('Etiquetar tarea', 'Tag a task')} value="" onChange={(event) => { const issue = issues[event.target.value]; if (issue) addTag({ kind: 'issue', id: issue.id, label: issue.title.slice(0, 120) }); }}><option value="">{tr('Etiquetar tarea…', 'Tag a task…')}</option>{Object.values(issues).map((issue) => <option key={issue.id} value={issue.id}>{issue.title}</option>)}</select></div>
    <p className="hint">🔒 {tr('Las etiquetas solo organizan tu nota. No se envía ningún mensaje al grupo, chat o tarea.', 'Tags only organize your note. No message is sent to the group, chat or task.')}</p>
    <div className="row"><input className="input grow" type="url" value={link} placeholder="https://…" onChange={(event) => setLink(event.target.value)} /><button className="btn small" disabled={!link.trim() || links.length >= 50} onClick={addLink}>🔗 {tr('Añadir enlace', 'Add link')}</button></div>
    {links.map((url) => <div key={url} className="row"><a className="ellipsis grow" href={url} target="_blank" rel="noopener noreferrer">{url}</a><button className="icon-btn" aria-label={tr('Quitar enlace', 'Remove link')} onClick={() => setLinks((current) => current.filter((item) => item !== url))}>×</button></div>)}
    <button className="btn" disabled={busy || files.length >= 50} onClick={() => input.current?.click()}>📎 {tr('Añadir imágenes, documentos o videos', 'Add images, documents or videos')}</button><input ref={input} hidden type="file" multiple onChange={(event) => void upload([...event.target.files ?? []])} />
    {files.map((file) => <div key={file.id} className="row"><button className="btn ghost small grow" onClick={() => void openFile(file)}>{fileIcon(file.contentType, file.name)} {file.name} · {size(file.size)}</button><button className="icon-btn" aria-label={tr('Quitar adjunto', 'Remove attachment')} onClick={() => setFiles((current) => current.filter((item) => item.id !== file.id))}>×</button></div>)}
    {error && <div className="error" role="alert">{error}</div>}
    <div className="modal-actions">{note && <button className="btn danger" disabled={busy} onClick={() => void remove()}>{tr('Eliminar', 'Delete')}</button>}<button className="btn ghost" disabled={busy} onClick={onClose}>{tr('Cancelar', 'Cancel')}</button><button className="btn primary" disabled={busy || !title.trim()} onClick={() => void save()}>{busy ? tr('Guardando…', 'Saving…') : tr('Guardar nota', 'Save note')}</button></div>
    {preview && <Modal title={preview.file.name} onClose={() => setPreview(null)}>{preview.file.contentType.startsWith('image/') ? <img className="note-media-preview" src={preview.url} alt={preview.file.name} /> : preview.file.contentType.startsWith('video/') ? <video className="note-media-preview" controls src={preview.url} /> : <p>{tr('Abre el documento para verlo o descargarlo.', 'Open the document to view or download it.')}</p>}<a className="btn" href={preview.url} target="_blank" rel="noopener noreferrer">{tr('Abrir archivo', 'Open file')}</a></Modal>}
  </Modal>;
}
