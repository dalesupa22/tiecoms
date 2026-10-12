/**
 * Texto de un PDF para gg y el MCP: página por página, con un tope de caracteres y aviso explícito si se cortó.
 * Incidente 11/12-oct-2026: pdfjs abriendo un PDF pesado llenó el heap y tumbó el API entero (OOM). Ahora cada PDF
 * se lee en un hilo aparte con su propio tope de memoria y de tiempo: si revienta, falla solo esa lectura.
 */
import { Worker } from 'node:worker_threads';
import { extractPdfText, type PdfText } from './pdf-text-core.ts';

export type { PdfText };

const WORKER_HEAP_MB = Number(process.env.PDF_WORKER_HEAP_MB ?? 192);
const WORKER_TIMEOUT_MS = Number(process.env.PDF_WORKER_TIMEOUT_MS ?? 45_000);
const MAX_PARALLEL = 2;

let running = 0;
const queue: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => queue.push(r));
  running++;
  try { return await fn(); } finally { running--; queue.shift()?.(); }
}

function inWorker(data: Uint8Array, maxChars: number, maxPages: number): Promise<PdfText> {
  return new Promise((resolve, reject) => {
    const copy = new Uint8Array(data);
    const w = new Worker(new URL('./pdf-worker.js', import.meta.url), {
      workerData: { data: copy, maxChars, maxPages }, transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 32 },
      stdout: true, stderr: true,
    });
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); void w.terminate(); };
    const timer = setTimeout(() => finish(() => reject(new Error('El PDF tardó demasiado en leerse'))), WORKER_TIMEOUT_MS);
    w.once('message', (m: { ok: boolean; r?: PdfText; message?: string }) => finish(() => (m.ok ? resolve(m.r!) : reject(new Error(m.message)))));
    w.once('error', (e: any) => finish(() => {
      if (e?.code === 'ERR_WORKER_OUT_OF_MEMORY') console.error('[pdf] el PDF necesitó más memoria de la permitida; se descartó solo esa lectura');
      reject(e);
    }));
    w.once('exit', (code) => finish(() => reject(new Error(`lector de PDF terminó (${code})`))));
  });
}

export function pdfText(data: Uint8Array, maxChars: number, maxPages = 200): Promise<PdfText> {
  // Las pruebas corren sobre el TypeScript (no hay dist/pdf-worker.js): extracción directa.
  if (process.env.VITEST) return extractPdfText(data, maxChars, maxPages);
  return slot(() => inWorker(data, maxChars, maxPages));
}
