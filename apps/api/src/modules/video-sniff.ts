// Sin dependencias (lo usan attachments.ts y la validación de archivos del MCP).
const IMAGE_BRANDS = /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/;
const AUDIO_BRANDS = /^(M4A |M4B |M4P )$/;
/** Video por los primeros bytes: MP4/MOV (caja ftyp) o WebM (EBML con DocType webm). null si no lo es. */
export function sniffVideo(b: Buffer): 'video/mp4' | 'video/quicktime' | 'video/webm' | null {
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (IMAGE_BRANDS.test(brand) || AUDIO_BRANDS.test(brand)) return null;
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) {
    const head = b.subarray(0, Math.min(b.length, 64));
    return head.includes(Buffer.from('webm', 'ascii')) ? 'video/webm' : null;
  }
  return null;
}
