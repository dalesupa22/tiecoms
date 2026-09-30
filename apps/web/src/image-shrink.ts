/**
 * Foto sin miniatura en el servidor (subida desde un cliente viejo o reenviada): para la burbuja se achica aquí una
 * sola vez y se guarda la versión chica (≈40 KB en vez de 1–5 MB, y un mapa de bits de 0,7 MB en vez de 17 MB).
 * La original solo se descarga entera al abrir el visor. Si algo falla, se usa la original tal cual.
 */
export const TILE_MAX_SIDE = 640;
/** Por debajo de esto no vale la pena (ya es chica). */
const MIN_BYTES = 250 * 1024;
const SHRINKABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function shrinkTarget(w: number, h: number, max = TILE_MAX_SIDE) {
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)), scaled: s < 1 };
}

export async function shrinkImage(blob: Blob, max = TILE_MAX_SIDE): Promise<Blob> {
  if (blob.size < MIN_BYTES || !SHRINKABLE.has(blob.type) || typeof createImageBitmap !== 'function') return blob;
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(blob);
    const t = shrinkTarget(bmp.width, bmp.height, max);
    if (!t.scaled) return blob;
    const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(t.width, t.height)
      : Object.assign(document.createElement('canvas'), { width: t.width, height: t.height });
    const g = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!g) return blob;
    g.drawImage(bmp, 0, 0, t.width, t.height);
    // PNG sigue en PNG (puede tener transparencia); lo demás, JPEG.
    const type = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const out = 'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type, quality: 0.82 })
      : await new Promise<Blob | null>((r) => (canvas as HTMLCanvasElement).toBlob(r, type, 0.82));
    // El lienzo se libera ya (Safari retiene su memoria hasta que el tamaño vuelve a 0).
    canvas.width = 0; canvas.height = 0;
    return out && out.size < blob.size ? out : blob;
  } catch { return blob; } finally { bmp?.close(); }
}
