/**
 * Archivos que llegan al chat desde fuera de la app: soltados (drag and drop del sistema) o pegados
 * (⌘V / Ctrl+V). Todo termina en el mismo `drafts.add` que el botón «+».
 *
 * Los arrastres internos (un chat de la lista hacia los paneles con DRAG_TYPE, reordenar temas con
 * text/plain, una imagen del propio chat) no cuentan: solo `dataTransfer.types` con «Files» y sin que el
 * arrastre haya empezado dentro de la página.
 */
/** El DRAG_TYPE de split.ts (arrastrar un chat de la lista a los paneles). Copiado aquí porque split.ts
 *  arrastra el router (window) y este módulo se prueba sin navegador; un test verifica que coincidan. */
export const CONV_DRAG_TYPE = 'application/x-chaggu-conversation';

/** true mientras dura un arrastre que empezó dentro de la página (dragstart en el documento). */
let internalDrag = false;

type TypesLike = { types: ArrayLike<string> | readonly string[] } | null | undefined;

/** ¿El arrastre trae archivos del sistema (y no es uno interno de la app)? */
export function isFileDrag(dt: TypesLike, internal = internalDrag): boolean {
  if (!dt || internal) return false;
  const types = Array.from(dt.types ?? []);
  return types.includes('Files') && !types.includes(CONV_DRAG_TYPE);
}

const two = (n: number) => String(n).padStart(2, '0');

/** «captura-AAAAMMDD-HHMMSS.png» con la hora local. */
export function captureName(now = new Date(), ext = 'png'): string {
  const d = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  const h = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `captura-${d}-${h}.${ext}`;
}

/** Nombres que ponen los navegadores a una imagen pegada sin archivo detrás (Chrome/Edge/WebView2/Safari). */
const GENERIC = /^(image|imagen|blob|untitled|pasted[ -_]?image|clipboard)?(\.[a-z0-9]+)?$/i;

const extFor = (type: string) => {
  const sub = type.split('/')[1]?.split(/[+;]/)[0]?.toLowerCase() ?? 'png';
  return sub === 'jpeg' ? 'jpg' : sub === 'svg' ? 'svg' : sub || 'png';
};

/** Una imagen pegada sin nombre propio pasa a «captura-…»; lo demás queda igual. */
export function nameClipboardFile(f: File, now = new Date()): File {
  if (!f.type.startsWith('image/') || !GENERIC.test(f.name ?? '')) return f;
  return new File([f], captureName(now, extFor(f.type)), { type: f.type, lastModified: f.lastModified || now.getTime() });
}

type ItemLike = { kind: string; type: string; getAsFile(): File | null };
type ClipLike = { files?: ArrayLike<File> | null; items?: ArrayLike<ItemLike> | null; types?: ArrayLike<string> | readonly string[]; getData?(type: string): string };

/**
 * Archivos del portapapeles, o [] si lo que se pega es texto.
 * - Usa `files` y, si viene vacío (WKWebView con capturas, imagen copiada del navegador), `items` de tipo file.
 *   No usa navigator.clipboard.read (pide permiso y no existe igual en WKWebView/WebView2).
 * - Office/Docs/páginas copian texto con una imagen de respaldo (text/plain + text/html + image/png):
 *   ahí gana el texto, para no convertir una tabla pegada en una captura.
 */
export function clipboardFiles(cd: ClipLike | null | undefined, now = new Date()): File[] {
  if (!cd) return [];
  let files = Array.from(cd.files ?? []);
  if (!files.length) {
    files = Array.from(cd.items ?? [])
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
  }
  if (!files.length) return [];
  const types = Array.from(cd.types ?? []);
  const plain = types.includes('text/plain') ? (cd.getData?.('text/plain') ?? '') : '';
  const richText = types.includes('text/html') && plain.trim().length > 0;
  if (richText && files.every((f) => f.type.startsWith('image/'))) return [];
  return files.map((f) => nameClipboardFile(f, now));
}

/**
 * Qué hacer con un arrastre de archivos sobre el panel: si otro panel más adentro (el sidechat) ya lo
 * tomó, no hacer nada; si no, tomarlo. Devuelve si este panel lo atiende.
 */
export function claimFileDrag(e: { dataTransfer: DataTransfer | null; preventDefault(): void; stopPropagation(): void }): boolean {
  if (!isFileDrag(e.dataTransfer)) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  return true;
}

let installed = false;
/**
 * Una vez por documento: marca los arrastres internos y evita que un archivo soltado fuera de un chat
 * abra el archivo en la ventana (en escritorio eso saca al WebView de la app).
 */
export function installFileDropGuard(doc: Document = document) {
  if (installed || typeof doc === 'undefined') return;
  installed = true;
  doc.addEventListener('dragstart', () => { internalDrag = true; }, true);
  const end = () => { internalDrag = false; };
  doc.addEventListener('dragend', end, true);
  doc.addEventListener('drop', () => setTimeout(end, 0), true);
  const view = doc.defaultView;
  if (!view) return;
  view.addEventListener('dragover', (e) => {
    if (e.defaultPrevented || !isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  });
  view.addEventListener('drop', (e) => { if (!e.defaultPrevented && Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault(); });
}
