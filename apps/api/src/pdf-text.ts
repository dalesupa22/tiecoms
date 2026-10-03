/** Texto de un PDF para gg: página por página, con un tope de caracteres y aviso explícito si se cortó. */
// pdfjs se carga solo cuando gg lee un PDF y vive fuera del bundle principal (dist/pdfjs.js).
// La ruta va en una variable para que esbuild no lo meta dentro de server.js / worker.js.
async function load() {
  const path = process.env.VITEST ? './pdfjs-entry.ts' : './pdfjs.js';
  const m = await import(/* @vite-ignore */ path);
  // En Node pdfjs usa un «worker falso» en el mismo hilo; dárselo evita que intente cargar un archivo aparte.
  (globalThis as any).pdfjsWorker ??= m.worker;
  return m.pdfjs as typeof import('pdfjs-dist/legacy/build/pdf.mjs');
}

export interface PdfText { text: string; pages: number; readPages: number; truncated: boolean }

export async function pdfText(data: Uint8Array, maxChars: number, maxPages = 200): Promise<PdfText> {
  const pdfjs = await load();
  const task = pdfjs.getDocument({ data: new Uint8Array(data), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const out: string[] = [];
    let used = 0, readPages = 0, truncated = false;
    for (let n = 1; n <= doc.numPages; n++) {
      if (n > maxPages) { truncated = true; break; }
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items as any[]) {
        if (typeof item.str !== 'string') continue;
        line += item.str;
        if (item.hasEOL) { lines.push(line); line = ''; } else if (item.str && !item.str.endsWith(' ')) line += ' ';
      }
      if (line.trim()) lines.push(line);
      const pageText = `[Página ${n}]\n` + lines.map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
      if (used + pageText.length > maxChars) {
        const room = maxChars - used;
        if (room > 200) { out.push(pageText.slice(0, room)); readPages = n; }
        truncated = true; break;
      }
      out.push(pageText); used += pageText.length + 1; readPages = n;
      page.cleanup();
    }
    return { text: out.join('\n'), pages: doc.numPages, readPages, truncated };
  } finally { await task.destroy(); }
}
