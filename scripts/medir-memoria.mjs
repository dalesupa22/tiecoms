#!/usr/bin/env node
/**
 * Medición de memoria de la web (docs/MEMORIA.md) con Chromium por CDP, sobre el arnés con carga pesada
 * (/harness.html?carga=50: 50 chats × 100 mensajes, fotos, correos y un «servidor» en memoria).
 *
 *   CHAGGU_HARNESS=1 npm -w @tiecoms/web exec vite build
 *   npm -w @tiecoms/web exec -- vite preview --port 5301 --strictPort --outDir dist-harness &
 *   node scripts/medir-memoria.mjs --url http://localhost:5301 --out /tmp/memoria.json [--snapshot /tmp/heap]
 *
 * Playwright no es dependencia del repo: se usa el que haya (npm i -g playwright-core, o PLAYWRIGHT_DIR=<carpeta
 * con node_modules/playwright-core>). El navegador: CHROMIUM=<ruta> o el Chromium que Playwright ya descargó.
 *
 * Fases: arranque → 20 chats recorridos → 10 min simulados en vivo (600 mensajes, 1.200 «escribiendo…», 300 leídos)
 * → pantallas de correo, WhatsApp, agenda, asuntos y archivos → oculta mucho tiempo (poda). Antes de cada medida se
 * fuerza la recolección de basura (HeapProfiler.collectGarbage). Se mide también el tiempo de abrir un chat.
 */
import { createRequire } from 'node:module';
import { writeFileSync, createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []));
const BASE = args.url ?? 'http://localhost:5301';
const CHATS = Number(args.chats ?? 50);

async function loadPlaywright() {
  const dirs = [process.env.PLAYWRIGHT_DIR, process.cwd()].filter(Boolean);
  for (const d of dirs) {
    for (const name of ['playwright-core', 'playwright']) {
      try { return createRequire(join(d, 'noop.js'))(name); } catch {}
    }
  }
  for (const name of ['playwright-core', 'playwright']) { try { return await import(name); } catch {} }
  throw new Error('No encuentro playwright-core (PLAYWRIGHT_DIR=<carpeta con node_modules/playwright-core>).');
}

const pw = await loadPlaywright();
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM || undefined, args: ['--disable-gpu'] });
const browserCdp = await browser.newBrowserCDPSession();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-CO' });
// Object URLs vivos (blob:) y lo que pesan: no cuentan en el heap de JS, pero sí en la RAM del proceso.
await context.addInitScript(() => {
  const live = new Map();
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (o) => { const u = create(o); live.set(u, o?.size ?? 0); return u; };
  URL.revokeObjectURL = (u) => { live.delete(u); revoke(u); };
  window.__blobStats = () => { let bytes = 0; for (const b of live.values()) bytes += b; return { count: live.size, bytes }; };
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
await cdp.send('HeapProfiler.enable');

/** RAM residente (RSS) de los procesos del navegador (navegador, GPU, renderers…), en MB, según SystemInfo + ps. */
async function processRssMB() {
  try {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const pids = new Set(processInfo.map((p) => p.id));
    const out = execFileSync('ps', ['-axo', 'pid=,rss='], { encoding: 'utf8' });
    let kb = 0;
    for (const l of out.trim().split('\n')) { const [pid, rss] = l.trim().split(/\s+/).map(Number); if (pids.has(pid)) kb += rss; }
    return +(kb / 1024).toFixed(0);
  } catch { return null; }
}

async function measure(label) {
  await page.waitForTimeout(600);
  for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const app = await page.evaluate(() => {
    const s = window.__client.getState();
    const convs = Object.values(s.conversations);
    return {
      domNodes: document.getElementsByTagName('*').length,
      loadedChats: convs.filter((c) => c.loaded || c.messages.length).length,
      messagesInMemory: convs.reduce((n, c) => n + c.messages.length, 0),
      typingKeys: Object.keys(s.typing).length,
      mails: Object.keys(s.mails).length,
      blobs: window.__blobStats(),
    };
  });
  const row = { label, rssMB: await processRssMB(), heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), heapTotalMB: +(m.JSHeapTotalSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, ...app, blobMB: +(app.blobs.bytes / 1048576).toFixed(1), blobCount: app.blobs.count };
  delete row.blobs;
  console.log(JSON.stringify(row));
  return row;
}

/** Abre un chat como lo hace la app (pushState + popstate) y espera su último mensaje pintado. */
async function openChat(id) {
  return page.evaluate(async (cid) => {
    const s = window.__client.getState();
    const last = s.data.conversations.find((c) => c.id === cid).lastMessageSeq;
    const t0 = performance.now();
    history.pushState(null, '', `/c/${cid}`);
    dispatchEvent(new PopStateEvent('popstate'));
    for (;;) {
      if (document.getElementById(`msg-${cid}-${last}`)) return performance.now() - t0;
      if (performance.now() - t0 > 10_000) return -1;
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, id);
}
async function go(path) {
  await page.evaluate((p) => { history.pushState(null, '', p); dispatchEvent(new PopStateEvent('popstate')); }, path);
  await page.waitForTimeout(700);
}

await page.goto(`${BASE}/harness.html?carga=${CHATS}&to=/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__loadChats && document.querySelectorAll('#root *').length > 50, null, { timeout: 30_000 });
await page.waitForTimeout(2500);
const ids = await page.evaluate(() => window.__loadChats);
const rows = [];
rows.push(await measure('arranque'));

const openTimes = [];
for (const [i, id] of ids.slice(0, 20).entries()) {
  openTimes.push(await openChat(id));
  // En uno de cada cuatro se sube a leer historial (como al hacer scroll hasta arriba): 3 páginas más.
  if (i % 4 === 0) for (let k = 0; k < 3; k++) await page.evaluate((cid) => window.__client.loadOlder(cid), id);
  await page.waitForTimeout(250); // fotos y tarjetas de correo
}
rows.push(await measure('tras 20 chats'));
if (args.snapshot) {
  const file = `${args.snapshot}-20chats.heapsnapshot`;
  const out = createWriteStream(file);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => out.write(e.chunk));
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  out.end();
  console.log('snapshot', file);
}
// Reabrir: chats recientes (en memoria) y uno de los primeros (quizá ya podado: se vuelve a pedir o sale de la caché local).
const reopenRecent = [], reopenOld = [];
for (const k of [19, 18, 17, 16, 15]) { reopenRecent.push(await openChat(ids[k])); await page.waitForTimeout(150); }
for (const k of [0, 1, 2, 3, 4]) { reopenOld.push(await openChat(ids[k])); await page.waitForTimeout(150); }

// 10 minutos simulados: 600 mensajes, 1.200 «escribiendo…» y 300 leídos, en 60 tandas.
for (let i = 0; i < 60; i++) {
  await page.evaluate(() => window.__live({ messages: 10, typing: 20, reads: 5 }));
  await page.waitForTimeout(40);
}
rows.push(await measure('tras 10 min en vivo'));

for (const p of ['/correo', '/whatsapp', '/agenda', '/asuntos', '/archivos', '/llamadas', '/']) await go(p);
await openChat(ids[1]);
rows.push(await measure('tras correo/pantallas'));

// Oculta mucho tiempo (escritorio en la bandeja, pestaña en segundo plano): la app poda lo que no está a la vista.
const pruned = await page.evaluate(async () => {
  if (typeof window.__trimMemory !== 'function') return false;
  await window.__trimMemory();
  return true;
});
if (pruned) rows.push(await measure('oculta (poda)'));
const afterTrim = [];
if (pruned) for (const k of [5, 6, 7]) { afterTrim.push(await openChat(ids[k])); await page.waitForTimeout(150); }

const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); return +v[Math.floor(v.length / 2)].toFixed(0); };
const p90 = (xs) => { const v = [...xs].sort((a, b) => a - b); return +v[Math.min(v.length - 1, Math.floor(v.length * 0.9))].toFixed(0); };
const result = {
  when: new Date().toISOString(), base: BASE, chats: CHATS, rows,
  // Mediana (y p90) en ms desde navegar hasta ver el último mensaje. «old» = de los primeros chats (ya fuera de los 15 calientes).
  openMs: { first: median(openTimes), firstP90: p90(openTimes), reopenRecent: median(reopenRecent), reopenOld: median(reopenOld), afterTrim: median(afterTrim) },
  errors,
};
console.log(JSON.stringify(result.openMs));
if (errors.length) console.log('errores de página:', errors.slice(0, 5));
if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
await browser.close();
