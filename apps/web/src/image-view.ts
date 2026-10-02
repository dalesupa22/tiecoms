export interface ImageSize { width: number; height: number }
export interface ImagePoint { x: number; y: number }
export const IMAGE_ZOOM_MAX = 8;

/** Natural image pixels, measured against the actual space below the toolbar. */
export function imageFit(image: ImageSize, viewport: ImageSize): number {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(1, viewport.width / image.width, viewport.height / image.height);
}
export function imageZoom(value: number, fit: number): number {
  return Math.max(Math.min(.1, fit), Math.min(IMAGE_ZOOM_MAX, value));
}
export function imagePan(point: ImagePoint, image: ImageSize, viewport: ImageSize, scale: number): ImagePoint {
  const x = Math.max(0, (image.width * scale - viewport.width) / 2);
  const y = Math.max(0, (image.height * scale - viewport.height) / 2);
  return { x: x ? Math.max(-x, Math.min(x, point.x)) : 0, y: y ? Math.max(-y, Math.min(y, point.y)) : 0 };
}
/** Preserve the pixel under the cursor while zooming; clamp at the image edges. */
export function imageZoomAt(point: ImagePoint, anchor: ImagePoint, before: number, after: number): ImagePoint {
  return { x: anchor.x - (anchor.x - point.x) * after / before, y: anchor.y - (anchor.y - point.y) * after / before };
}
