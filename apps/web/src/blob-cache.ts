/**
 * Caché de URLs locales (blob:) para las rutas del API que exigen Bearer (fotos, miniaturas, notas de voz, PDFs).
 * Antes era un Map que nunca soltaba nada: cada foto vista quedaba en la RAM hasta cerrar la app (docs/MEMORIA.md).
 *
 * Ahora cuenta referencias: quien pinta la URL la «adquiere» y la suelta al desmontar. Las que nadie usa quedan un
 * rato (volver a un chat reciente no las pide otra vez) y se revocan con URL.revokeObjectURL por LRU al pasar de
 * maxIdle entradas o de maxBytes en total. Las que están en uso nunca se revocan.
 */
export interface BlobCacheOptions {
  fetch: (path: string) => Promise<Blob>;
  create?: (b: Blob) => string;
  revoke?: (url: string) => void;
  /** Entradas sin uso que se conservan (las más recientes). */
  maxIdle?: number;
  /** Bytes en total (en uso + sin uso) a partir de los cuales se revocan las sin uso más viejas. */
  maxBytes?: number;
}
interface Entry { promise: Promise<string>; url: string | null; size: number; refs: number; used: number }
export interface BlobHandle { promise: Promise<string>; release: () => void }

export const BLOB_MAX_IDLE = 60;
export const BLOB_MAX_BYTES = 32 * 1024 * 1024;

export class BlobCache {
  private entries = new Map<string, Entry>();
  private tick = 0;
  private fetchBlob: (path: string) => Promise<Blob>;
  private create: (b: Blob) => string;
  private revoke: (url: string) => void;
  private maxIdle: number;
  private maxBytes: number;

  constructor(o: BlobCacheOptions) {
    this.fetchBlob = o.fetch;
    this.create = o.create ?? ((b) => URL.createObjectURL(b));
    this.revoke = o.revoke ?? ((u) => URL.revokeObjectURL(u));
    this.maxIdle = o.maxIdle ?? BLOB_MAX_IDLE;
    this.maxBytes = o.maxBytes ?? BLOB_MAX_BYTES;
  }

  /**
   * URL de `key` (por defecto la ruta). `load` permite transformar lo descargado (p. ej. achicar una foto para la
   * burbuja) y guardarlo con su propia clave. release() la deja sin uso; se puede llamar más de una vez.
   */
  acquire(key: string, load?: () => Promise<Blob>): BlobHandle {
    let e = this.entries.get(key);
    if (!e) {
      const entry: Entry = { promise: Promise.resolve(''), url: null, size: 0, refs: 0, used: 0 };
      entry.promise = (load ?? (() => this.fetchBlob(key)))().then((b) => {
        // Si la soltaron y la revocaron mientras llegaba, no se crea nada.
        if (this.entries.get(key) !== entry) throw new DOMException('Aborted', 'AbortError');
        entry.url = this.create(b);
        entry.size = b.size;
        this.prune();
        return entry.url;
      });
      entry.promise.catch(() => { if (this.entries.get(key) === entry && !entry.url) this.entries.delete(key); });
      this.entries.set(key, entry);
      e = entry;
    }
    const entry = e;
    entry.refs++;
    entry.used = ++this.tick;
    let released = false;
    return {
      promise: entry.promise,
      release: () => {
        if (released) return;
        released = true;
        entry.refs = Math.max(0, entry.refs - 1);
        entry.used = ++this.tick;
        if (!entry.refs) this.prune();
      },
    };
  }

  /** Revoca las sin uso que sobran (o todas las sin uso con all=true: app oculta mucho tiempo). */
  prune(all = false) {
    const idle = [...this.entries].filter(([, e]) => !e.refs && e.url).sort((a, b) => a[1].used - b[1].used);
    let bytes = 0;
    for (const e of this.entries.values()) bytes += e.size;
    let idleCount = idle.length;
    for (const [key, e] of idle) {
      if (!all && idleCount <= this.maxIdle && bytes <= this.maxBytes) break;
      this.entries.delete(key);
      this.revoke(e.url!);
      bytes -= e.size; idleCount--;
    }
  }

  stats() {
    let bytes = 0, inUse = 0;
    for (const e of this.entries.values()) { bytes += e.size; if (e.refs) inUse++; }
    return { entries: this.entries.size, inUse, bytes };
  }
}
