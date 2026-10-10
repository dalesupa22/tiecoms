/**
 * Visor y editor de archivos de texto y código (pedido de Danny, 5-oct-2026: «cuando uno abra un archivo de texto en
 * web, exe y dmg, abrir un editor o un visualizador de código»). CodeMirror 6 con el lenguaje según el nombre del
 * archivo (se descarga solo el que hace falta), números de línea, buscar (⌘F), ajuste de línea y copiar.
 * «Editar» quita el solo-lectura; lo editado se descarga o se manda al mismo chat como archivo nuevo (el original
 * no se toca). Se carga perezoso desde Attachments.tsx: nada de esto pesa hasta abrir un archivo.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AttachmentDTO } from '@tiecoms/contracts';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { LanguageDescription, bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { languages } from '@codemirror/language-data';
import { classHighlighter } from '@lezer/highlight';
import { client } from '../app-client.ts';
import { errorText, getLang } from '../i18n.ts';
import { copyText, toast } from '../menu.tsx';
import { MAX_TEXT_BYTES, looksBinary } from '../text-files.ts';
import { fileSize } from './Attachments.tsx';
import './CodeSheet.css';

type Loaded = { text: string; language: string | null } | { error: string } | null;

/** HTML que se puede ver renderizado («Vista», pedido de Danny 10-oct-2026: «poder visualizar html cuando manden un html»). */
export function isHtmlFile(a: { contentType: string; name: string }) {
  return /\.(html?|xhtml)$/i.test(a.name) || /^(text\/html|application\/xhtml\+xml)\b/i.test(a.contentType);
}
/**
 * Lo que va al iframe de la vista. El iframe va con sandbox vacío (sin scripts, formularios, popups ni navegación de la
 * página, y con origen opaco: no ve la sesión ni la API de Chaggu); además hereda el CSP de la app (imágenes externas
 * no cargan). El meta repite el bloqueo de scripts por si un navegador viejo ignora el sandbox.
 */
const htmlPreviewDoc = (html: string) => `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">${html}`;

/** Lenguaje por nombre de archivo; los que CodeMirror no conoce por extensión (.env, .log…) quedan como texto. */
function languageFor(name: string) {
  return LanguageDescription.matchFilename(languages, name) ?? null;
}

export default function CodeSheet({ a, conversationId, onClose }: { a: AttachmentDTO; conversationId?: string; onClose: () => void }) {
  const en = getLang() === 'en';
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const readOnly = useRef(new Compartment()), wrap = useRef(new Compartment()), lang = useRef(new Compartment());
  const original = useRef('');
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [editing, setEditing] = useState(false);
  const [wrapped, setWrapped] = useState(() => /\.(md|markdown|txt|text|log|csv|tsv|rst)$/i.test(a.name));
  const [dirty, setDirty] = useState(false);
  const [sending, setSending] = useState(false);
  const html = isHtmlFile(a);
  // En HTML se abre en «Vista»; preview guarda el texto que se está mostrando (el editado, si lo hay).
  const [preview, setPreview] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(html);
  const trigger = useRef(document.activeElement as HTMLElement | null);

  // Descarga autenticada y decodificación; si parece binario se ofrece solo descargar.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (a.sizeBytes > MAX_TEXT_BYTES) throw new Error(en ? `Too big to preview (${fileSize(a.sizeBytes)}). Download it instead.` : `Es muy grande para verlo aquí (${fileSize(a.sizeBytes)}). Descárgalo.`);
        const blob = await client.fetchBlob(a.url);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (looksBinary(bytes)) throw new Error(en ? 'This file does not look like text. Download it to open it.' : 'Este archivo no parece de texto. Descárgalo para abrirlo.');
        const text = new TextDecoder('utf-8').decode(bytes);
        const desc = languageFor(a.name);
        if (alive) setLoaded({ text, language: desc?.name ?? null });
      } catch (e) { if (alive) setLoaded({ error: errorText(e) || (en ? 'Could not open the file' : 'No se pudo abrir el archivo') }); }
    })();
    return () => { alive = false; };
  }, [a.url]);

  // El editor se arma una vez con el texto; los botones cambian sus compartimentos.
  useEffect(() => {
    if (!loaded || 'error' in loaded || !host.current) return;
    original.current = loaded.text;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: loaded.text,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(),
          indentOnInput(), bracketMatching(), highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
          syntaxHighlighting(classHighlighter),
          keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          readOnly.current.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
          wrap.current.of(wrapped ? EditorView.lineWrapping : []),
          lang.current.of([]),
          EditorView.updateListener.of((u) => { if (u.docChanged) setDirty(u.state.doc.toString() !== original.current); }),
          EditorView.contentAttributes.of({ 'aria-label': a.name }),
        ],
      }),
    });
    view.current = v;
    // El lenguaje llega después (su paquete se descarga aparte) y se enchufa sin rehacer el editor.
    const desc = languageFor(a.name);
    desc?.load().then((support) => { if (view.current === v) v.dispatch({ effects: lang.current.reconfigure(support) }); }).catch(() => {});
    return () => { v.destroy(); if (view.current === v) view.current = null; };
  }, [loaded]);

  useEffect(() => {
    view.current?.dispatch({ effects: readOnly.current.reconfigure(editing ? [] : [EditorState.readOnly.of(true), EditorView.editable.of(false)]) });
    if (editing) view.current?.focus();
  }, [editing]);
  useEffect(() => { view.current?.dispatch({ effects: wrap.current.reconfigure(wrapped ? EditorView.lineWrapping : []) }); }, [wrapped]);

  const close = () => {
    if (dirty && !confirm(en ? 'Discard your changes?' : '¿Descartar los cambios?')) return;
    onClose();
  };
  useEffect(() => () => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape cierra, salvo que esté abierto el buscador de CodeMirror (ahí Escape cierra el buscador).
      if (e.key === 'Escape' && !(e.target as Element | null)?.closest?.('.cm-search')) { e.preventDefault(); close(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const text = () => view.current?.state.doc.toString() ?? ('text' in (loaded ?? {}) ? (loaded as { text: string }).text : '');
  const mime = a.contentType && a.contentType !== 'application/octet-stream' ? a.contentType : 'text/plain;charset=utf-8';
  const download = () => {
    const url = URL.createObjectURL(new Blob([text()], { type: mime }));
    const link = document.createElement('a'); link.href = url; link.download = a.name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  const copy = async () => { if (await copyText(text())) toast(en ? 'Copied' : 'Copiado'); };
  const sendToChat = async () => {
    if (!conversationId || sending) return;
    setSending(true);
    try {
      const att = await client.uploadAttachment(conversationId, new Blob([text()], { type: mime }), a.name);
      await client.send(conversationId, '', null, null, { attachments: [att] });
      original.current = text(); setDirty(false);
      toast(en ? 'Edited version sent to the chat' : 'Versión editada enviada al chat');
    } catch (e) { toast(errorText(e) || (en ? 'Could not send it' : 'No se pudo enviar')); }
    finally { setSending(false); }
  };

  const ok = loaded && !('error' in loaded);
  const previewing = !!ok && html && showPreview;
  useEffect(() => { if (previewing) setPreview(text()); }, [previewing, loaded]);
  const lines = ok ? (view.current?.state.doc.lines ?? (loaded as { text: string }).text.split('\n').length) : 0;
  return createPortal(
    <div className="code-sheet" role="dialog" aria-modal="true" aria-label={a.name}>
      <div className="code-sheet-bar">
        <span className="code-sheet-name">
          <b className="ellipsis">{a.name}{dirty && <span className="code-sheet-dirty" title={en ? 'Edited' : 'Editado'}> ●</span>}</b>
          <span className="small muted">{[ok ? (loaded as { language: string | null }).language ?? (en ? 'Plain text' : 'Texto') : null, ok ? `${lines} ${en ? 'lines' : 'líneas'}` : null, fileSize(a.sizeBytes)].filter(Boolean).join(' · ')}</span>
        </span>
        {ok && html && <button type="button" className={`btn small ${showPreview ? 'primary' : 'ghost'}`} aria-pressed={showPreview} onClick={() => setShowPreview((x) => !x)}
          title={showPreview ? (en ? 'Show the HTML code' : 'Ver el código HTML') : (en ? 'Show the page as it looks' : 'Ver la página como se ve')}>
          {showPreview ? (en ? '</> Code' : '</> Código') : (en ? '👁 Preview' : '👁 Vista')}</button>}
        {ok && !previewing && <>
          <button type="button" className="btn small ghost" aria-pressed={wrapped} onClick={() => setWrapped((w) => !w)} title={en ? 'Wrap long lines' : 'Ajustar líneas largas'}>↩ {en ? 'Wrap' : 'Ajustar'}</button>
          <button type="button" className="btn small ghost" onClick={() => view.current && openSearchPanel(view.current)} title={en ? 'Find (⌘F)' : 'Buscar (⌘F)'}>⌕ {en ? 'Find' : 'Buscar'}</button>
          <button type="button" className={`btn small ${editing ? 'primary' : 'ghost'}`} aria-pressed={editing} onClick={() => setEditing((x) => !x)}>✎ {editing ? (en ? 'Editing' : 'Editando') : (en ? 'Edit' : 'Editar')}</button>
          <button type="button" className="btn small ghost" onClick={() => void copy()}>⧉ {en ? 'Copy' : 'Copiar'}</button>
        </>}
        {ok && dirty && conversationId && <button type="button" className="btn small primary" disabled={sending} onClick={() => void sendToChat()}>{sending ? '…' : '↑'} {en ? 'Send to chat' : 'Enviar al chat'}</button>}
        <button type="button" className="btn small ghost" onClick={ok ? download : () => void import('./Attachments.tsx').then((m) => m.downloadAttachment(a))} title={dirty ? (en ? 'Download with your changes' : 'Descargar con tus cambios') : (en ? 'Download' : 'Descargar')}>⤓ {en ? 'Download' : 'Descargar'}</button>
        <button type="button" className="icon-btn code-sheet-close" aria-label={en ? 'Close' : 'Cerrar'} onClick={close}>×</button>
      </div>
      {!loaded && <div className="code-sheet-msg"><span className="pdf-spin" /> {en ? 'Opening…' : 'Abriendo…'}</div>}
      {loaded && 'error' in loaded && <div className="code-sheet-msg">{loaded.error}</div>}
      {previewing && preview !== null && <iframe className="code-sheet-preview" title={a.name} sandbox="" referrerPolicy="no-referrer" srcDoc={htmlPreviewDoc(preview)} />}
      <div ref={host} className="code-sheet-editor" hidden={!ok || previewing} />
    </div>,
    document.body,
  );
}
