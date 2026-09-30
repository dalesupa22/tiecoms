import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONV_DRAG_TYPE as DRAG_TYPE, captureName, clipboardFiles, isFileDrag, nameClipboardFile } from '../src/file-drop.ts';

// Soltar y pegar archivos en el chat (web y escritorio): qué cuenta como archivo del sistema y cómo se nombra.
const at = new Date(2026, 8, 30, 7, 5, 9);
const png = (name = 'image.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
const item = (f: File) => ({ kind: 'file', type: f.type, getAsFile: () => f });
const str = (type: string) => ({ kind: 'string', type, getAsFile: () => null });
const clip = (o: { files?: File[]; items?: any[]; types?: string[]; text?: string }) => ({
  files: o.files ?? [], items: o.items ?? [], types: o.types ?? [], getData: (t: string) => (t === 'text/plain' ? o.text ?? '' : ''),
});

describe('isFileDrag', () => {
  it('usa el mismo tipo que split.ts', () => {
    expect(readFileSync(new URL('../src/split.ts', import.meta.url), 'utf8')).toContain(`DRAG_TYPE = '${DRAG_TYPE}'`);
  });
  it('archivos del sistema sí', () => {
    expect(isFileDrag({ types: ['Files'] }, false)).toBe(true);
    expect(isFileDrag({ types: ['text/uri-list', 'Files'] }, false)).toBe(true);
  });
  it('arrastrar un chat a los paneles no', () => {
    expect(isFileDrag({ types: [DRAG_TYPE, 'text/uri-list'] }, false)).toBe(false);
    expect(isFileDrag({ types: [DRAG_TYPE, 'Files'] }, false)).toBe(false);
  });
  it('reordenar temas (text/plain) no', () => { expect(isFileDrag({ types: ['text/plain'] }, false)).toBe(false); });
  it('una imagen arrastrada desde la propia página no, aunque el navegador diga Files', () => {
    expect(isFileDrag({ types: ['text/uri-list', 'text/html', 'Files'] }, true)).toBe(false);
  });
  it('sin dataTransfer no', () => { expect(isFileDrag(null, false)).toBe(false); });
});

describe('nombre de captura', () => {
  it('captura-AAAAMMDD-HHMMSS.png', () => { expect(captureName(at)).toBe('captura-20260930-070509.png'); });
  it('imagen pegada sin nombre propio se renombra', () => {
    for (const n of ['image.png', 'Image.png', '', 'blob', 'imagen.png', 'Pasted Image.png']) expect(nameClipboardFile(png(n), at).name).toBe('captura-20260930-070509.png');
    expect(nameClipboardFile(new File([''], 'image.jpeg', { type: 'image/jpeg' }), at).name).toBe('captura-20260930-070509.jpg');
  });
  it('conserva el nombre de un archivo real', () => {
    expect(nameClipboardFile(png('plano-obra.png'), at).name).toBe('plano-obra.png');
    const pdf = new File(['%PDF'], 'Contrato.pdf', { type: 'application/pdf' });
    expect(nameClipboardFile(pdf, at)).toBe(pdf);
  });
  it('el archivo renombrado mantiene tipo y contenido', () => {
    const f = nameClipboardFile(png(), at);
    expect(f.type).toBe('image/png');
    expect(f.size).toBe(4);
  });
});

describe('clipboardFiles: archivos o texto', () => {
  it('texto solo → [] (se pega como texto)', () => {
    expect(clipboardFiles(clip({ types: ['text/plain'], text: 'hola @Ana', items: [str('text/plain')] }), at)).toEqual([]);
  });
  it('captura de pantalla en files', () => {
    const r = clipboardFiles(clip({ types: ['Files'], files: [png()] }), at);
    expect(r.map((f) => f.name)).toEqual(['captura-20260930-070509.png']);
  });
  it('WKWebView: files vacío pero items trae la imagen', () => {
    const r = clipboardFiles(clip({ types: ['image/png'], items: [item(png())] }), at);
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe('captura-20260930-070509.png');
  });
  it('imagen copiada del navegador (html + imagen, sin texto plano)', () => {
    expect(clipboardFiles(clip({ types: ['text/html', 'Files'], files: [png()] }), at)).toHaveLength(1);
  });
  it('varios archivos de Finder/Explorador (nombre como texto + Files) se reparten todos', () => {
    const a = new File(['a'], 'informe.pdf', { type: 'application/pdf' });
    const b = new File(['b'], 'foto.jpg', { type: 'image/jpeg' });
    const r = clipboardFiles(clip({ types: ['text/plain', 'Files'], text: 'informe.pdf\rfoto.jpg', files: [a, b] }), at);
    expect(r.map((f) => f.name)).toEqual(['informe.pdf', 'foto.jpg']);
  });
  it('celdas de Excel/Word (texto + html + imagen de respaldo) → texto', () => {
    expect(clipboardFiles(clip({ types: ['text/plain', 'text/html', 'Files'], text: 'A\tB\n1\t2', files: [png()] }), at)).toEqual([]);
  });
  it('sin portapapeles → []', () => { expect(clipboardFiles(null)).toEqual([]); });
});
