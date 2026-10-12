/** Hilo desechable que extrae el texto de un PDF (lo arranca pdf-text.ts con su propio tope de memoria). */
import { parentPort, workerData } from 'node:worker_threads';
import { extractPdfText } from './pdf-text-core.ts';

const { data, maxChars, maxPages } = workerData as { data: Uint8Array; maxChars: number; maxPages: number };
extractPdfText(data, maxChars, maxPages).then(
  (r) => parentPort!.postMessage({ ok: true, r }),
  (e) => parentPort!.postMessage({ ok: false, message: String(e?.message ?? e).slice(0, 300) }),
);
