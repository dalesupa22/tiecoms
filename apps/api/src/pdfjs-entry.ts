/** pdfjs va en su propio archivo (dist/pdfjs.js): solo se carga cuando gg lee un PDF, para no inflar la memoria del API. */
export * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-expect-error: el worker de pdfjs no trae tipos.
export * as worker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
