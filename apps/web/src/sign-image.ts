/**
 * Firmas como PNG transparentes: recortar al trazo, quitar el fondo de una foto
 * (umbral de Otsu) y escribir el nombre en letra cursiva. Las funciones puras trabajan
 * sobre RGBA para poder probarlas sin navegador.
 */

export type Rgba = Uint8ClampedArray;
export const INK_COLORS = { blue: [23, 42, 138], black: [20, 20, 24] } as const;
export type InkColor = keyof typeof INK_COLORS;

/** Caja mínima con píxeles visibles (alpha > umbral). null si está vacía. */
export function inkBounds(data: Rgba, w: number, h: number, minAlpha = 12) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3]! > minAlpha) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const luma = (d: Rgba, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;

/** Umbral de Otsu sobre la luminancia: separa tinta de papel en una foto. */
export function otsuThreshold(data: Rgba) {
  const hist = new Array<number>(256).fill(0);
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) hist[Math.round(luma(data, i))]!++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t]!;
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    // Con dos tonos bien separados muchos cortes empatan: se usa el punto medio entre las dos medias.
    if (between > best) { best = between; threshold = Math.round((mB + mF) / 2); }
  }
  return threshold;
}

/**
 * Foto → tinta: lo más claro que el umbral queda transparente; lo oscuro toma el color
 * de la tinta con opacidad según qué tan oscuro es (bordes suaves).
 */
export function inkify(src: Rgba, threshold: number, color: readonly [number, number, number] | readonly number[] | null) {
  const out = new Uint8ClampedArray(src.length);
  const soft = Math.max(8, threshold * 0.25);
  for (let i = 0; i < src.length; i += 4) {
    const l = luma(src, i);
    const a = l >= threshold ? 0 : Math.min(1, (threshold - l) / soft);
    if (color) { out[i] = color[0]!; out[i + 1] = color[1]!; out[i + 2] = color[2]!; }
    else { out[i] = src[i]!; out[i + 1] = src[i + 1]!; out[i + 2] = src[i + 2]!; }
    out[i + 3] = Math.round(a * 255 * (src[i + 3]! / 255));
  }
  return out;
}

// ---------- En el navegador ----------
/** Recorta un canvas a su trazo (con margen) y lo reduce a ≤ maxW × maxH. null si no hay trazo. */
export async function trimmedPng(canvas: HTMLCanvasElement, maxW = 1200, maxH = 600, pad = 8): Promise<{ blob: Blob; width: number; height: number } | null> {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const b = inkBounds(img.data, canvas.width, canvas.height);
  if (!b || b.w < 4 || b.h < 4) return null;
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
  const w = Math.min(canvas.width - x, b.w + pad * 2), h = Math.min(canvas.height - y, b.h + pad * 2);
  const k = Math.min(1, maxW / w, maxH / h);
  const out = document.createElement('canvas');
  out.width = Math.max(8, Math.round(w * k)); out.height = Math.max(8, Math.round(h * k));
  const o = out.getContext('2d')!;
  o.imageSmoothingQuality = 'high';
  o.drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
  return blob ? { blob, width: out.width, height: out.height } : null;
}

/** Letras cursivas de Google Fonts (licencia OFL) para la firma escrita. */
export const SCRIPT_FONTS = ['Dancing Script', 'Great Vibes', 'Caveat'] as const;
let fontsLoading: Promise<void> | null = null;
export function loadScriptFonts() {
  fontsLoading ??= (async () => {
    const href = 'https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Dancing+Script:wght@600&family=Great+Vibes&display=swap';
    if (!document.querySelector(`link[href="${href}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = href;
      document.head.appendChild(link);
      await new Promise((r) => { link.onload = r; link.onerror = r; setTimeout(r, 4000); });
    }
    await Promise.all(SCRIPT_FONTS.map((f) => document.fonts.load(`600 64px "${f}"`).catch(() => [])));
  })();
  return fontsLoading;
}

/** Texto en cursiva → canvas listo para recortar. */
export function typedCanvas(text: string, font: string, color: InkColor) {
  const size = 140;
  const c = document.createElement('canvas');
  const probe = c.getContext('2d')!;
  probe.font = `600 ${size}px "${font}", cursive`;
  const width = Math.min(2000, Math.ceil(probe.measureText(text).width) + 80);
  c.width = width; c.height = Math.round(size * 1.8);
  const ctx = c.getContext('2d')!;
  ctx.font = `600 ${size}px "${font}", cursive`;
  ctx.fillStyle = `rgb(${INK_COLORS[color].join(',')})`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 40, c.height / 2);
  return c;
}

/** Foto de una firma en papel → canvas con la tinta sobre transparente. threshold null = automático. */
export async function photoCanvas(file: Blob, color: InkColor | null, threshold: number | null) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const auto = otsuThreshold(img.data);
  const t = threshold ?? Math.min(235, auto + 10);
  ctx.putImageData(new ImageData(inkify(img.data, t, color ? INK_COLORS[color] : null), c.width, c.height), 0, 0);
  return { canvas: c, threshold: t, auto };
}
