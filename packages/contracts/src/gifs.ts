/**
 * GIFs y memes (docs/GIFS.md). Todo pasa por el API de chaggu: los clientes nunca llaman al proveedor ni ven sus
 * claves, y las imágenes se sirven desde nuestro dominio (/api/v1/gifs/media?t=…), así cumplen la CSP img-src 'self'.
 */
import { z } from 'zod';

/** klipy: catálogo grande con clave gratuita (KLIPY_API_KEY). openverse: GIFs animados CC de Wikimedia Commons, sin clave. imgflip: plantillas de memes, sin clave. */
export type GifProvider = 'klipy' | 'openverse' | 'imgflip';

/** Un GIF o una plantilla de meme, igual para todos los proveedores. URLs relativas a nuestro dominio. */
export interface GifItemDTO {
  id: string;
  provider: GifProvider;
  title: string;
  /** Versión liviana para la cuadrícula del selector. */
  previewUrl: string;
  /** Versión para enviar (o la plantilla completa, en memes). Es la que se manda a POST /conversations/:id/gifs. */
  url: string;
  width: number;
  height: number;
  /** Atribución que exige la licencia o el proveedor («vía KLIPY», ««Gato» · Ana · CC BY-SA 4.0 · Wikimedia Commons»). */
  attribution?: string | null;
  /** Página original (licencias CC). */
  sourceUrl?: string | null;
  /** Memes: cuántas cajas de texto usa la plantilla. */
  boxCount?: number;
}

/** GET /api/v1/gifs/search | /gifs/trending | /memes/templates. */
export interface GifListDTO {
  provider: GifProvider;
  items: GifItemDTO[];
  /** Cursor para la página siguiente (?cursor=); null si no hay más. */
  next: string | null;
  /** Marca que el proveedor pide mostrar en el selector (p. ej. «Powered by KLIPY»). */
  poweredBy: { label: string; url: string } | null;
}

export const GifSearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  lang: z.enum(['es', 'en']).optional(),
  cursor: z.string().max(200).optional(),
});
export const GifTrendingQuery = z.object({
  lang: z.enum(['es', 'en']).optional(),
  cursor: z.string().max(200).optional(),
});

/** POST /api/v1/conversations/:id/gifs: guarda el GIF elegido como adjunto de imagen pendiente (como una foto). */
export const SendGifInput = z.object({ url: z.string().min(10).max(4096) });
export interface SendGifResult {
  attachment: import('./index.ts').AttachmentDTO;
  /** Texto de atribución para el cuerpo del mensaje (null si no hace falta). */
  attribution: string | null;
}
