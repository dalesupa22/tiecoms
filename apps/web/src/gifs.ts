/**
 * GIFs y memes (docs/GIFS.md): lógica pura del selector (comando /gif, mampostería, teclado) y del editor de
 * memes (partir y ajustar el texto). Sin DOM, para probarla en vitest.
 */

/** «/gif gato» → «gato»; «/gif» → «» (tendencias); cualquier otro texto → null. */
export function parseGifCommand(text: string): string | null {
  const m = /^\/gifs?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  return (m[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

export interface Tile { index: number; col: number; top: number; height: number }
/**
 * Mampostería: cada ítem va a la columna más baja. Devuelve la posición de cada uno (en px de ancho `colWidth`)
 * y la altura total. `gap` entre ítems.
 */
export function masonry(sizes: { width: number; height: number }[], cols: number, colWidth: number, gap = 6): { tiles: Tile[]; height: number } {
  const heights = new Array<number>(Math.max(1, cols)).fill(0);
  const tiles: Tile[] = sizes.map((s, index) => {
    let col = 0;
    for (let c = 1; c < heights.length; c++) if (heights[c]! < heights[col]! - 0.5) col = c;
    const h = Math.max(40, Math.min(colWidth * 2.2, Math.round((colWidth * (s.height || 1)) / (s.width || 1))));
    const top = heights[col]!;
    heights[col] = top + h + gap;
    return { index, col, top, height: h };
  });
  return { tiles, height: Math.max(0, ...heights) - gap };
}

/**
 * Flechas en la mampostería: ↑↓ dentro de la columna; ←→ a la columna vecina, al ítem cuyo centro queda más cerca
 * en vertical. Devuelve el índice nuevo (o el mismo si no hay a dónde ir).
 */
export function gridMove(tiles: Tile[], current: number, key: string): number {
  const cur = tiles[current];
  if (!cur) return tiles.length ? 0 : -1;
  const inCol = (c: number) => tiles.filter((t) => t.col === c).sort((a, b) => a.top - b.top);
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const col = inCol(cur.col);
    const i = col.findIndex((t) => t.index === current);
    const next = col[i + (key === 'ArrowDown' ? 1 : -1)];
    return next ? next.index : current;
  }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const cols = Math.max(...tiles.map((t) => t.col)) + 1;
    const target = cur.col + (key === 'ArrowRight' ? 1 : -1);
    if (target < 0 || target >= cols) return current;
    const mid = cur.top + cur.height / 2;
    let best: Tile | null = null;
    for (const t of inCol(target)) if (!best || Math.abs(t.top + t.height / 2 - mid) < Math.abs(best.top + best.height / 2 - mid)) best = t;
    return best ? best.index : current;
  }
  if (key === 'Home') return 0;
  if (key === 'End') return tiles.length - 1;
  return current;
}

// ---------- Editor de memes ----------
export const MEME_FONT = "Impact, Haettenschweiler, 'Arial Narrow Bold', 'Anton', 'Oswald', 'Arial Black', sans-serif";
export interface MemeText { top: string; bottom: string; /** 0.6 – 1.6 */ scale: number }

/** Parte el texto en renglones que caben en maxWidth (con measure en px). Una palabra más larga se deja sola. */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.toUpperCase().split(/\n/)) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (line && measure(next) > maxWidth) { out.push(line); line = w; } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Tamaño de letra para un bloque: parte de ancho/9 × escala y baja hasta que el texto quepa en 3 renglones
 * (y cada renglón en el ancho). measureAt(texto, px) mide con la fuente de meme.
 */
export function fitMemeText(text: string, width: number, height: number, scale: number, measureAt: (s: string, px: number) => number): { size: number; lines: string[] } {
  const maxW = width * 0.92;
  let size = Math.round(Math.max(14, Math.min(width / 9, height / 6)) * Math.max(0.6, Math.min(1.6, scale)));
  for (; size > 12; size -= 2) {
    const lines = wrapLines(text, maxW, (s) => measureAt(s, size));
    if (lines.length <= 3 && lines.every((l) => measureAt(l, size) <= maxW) && lines.length * size * 1.1 <= height * 0.45) return { size, lines };
  }
  return { size: 12, lines: wrapLines(text, maxW, (s) => measureAt(s, 12)) };
}

/** Lienzo del meme: como mucho 800 px de ancho (lo bastante nítido para un chat, liviano para enviar). */
export function memeCanvasSize(w: number, h: number, max = 800) {
  if (!w || !h) return { width: max, height: max };
  const k = Math.min(1, max / w);
  return { width: Math.round(w * k), height: Math.round(h * k) };
}
