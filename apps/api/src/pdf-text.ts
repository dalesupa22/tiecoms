/** Texto de un PDF para gg: página por página, con un tope de caracteres y aviso explícito si se cortó. */
// pdfjs se carga solo cuando gg lee un PDF (no al arrancar el API).
async function load() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // En Node pdfjs usa un «worker falso» en el mismo hilo; dárselo evita que intente cargar un archivo aparte.
  // @ts-expect-error: el worker de pdfjs no trae tipos.
  (globalThis as any).pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  return pdfjs;
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
