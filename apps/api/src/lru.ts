/**
 * Caché LRU en memoria para archivos pequeños e inmutables (fotos de perfil y miniaturas de enlaces): el id cambia
 * en cada subida, así que no hace falta invalidar; el TTL solo evita servir por mucho tiempo algo ya borrado.
 * Tope por cantidad y por bytes (lo que se pase de un tercio del total no se guarda).
 */
export class ByteLru<V extends { body: Buffer }> {
  private map = new Map<string, { v: V; at: number }>();
  private bytes = 0;
  hits = 0;
  misses = 0;
  constructor(private maxEntries = 200, private maxBytes = 20 * 1024 * 1024, private ttlMs = 60 * 60_000) {}
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e || Date.now() - e.at > this.ttlMs) { if (e) this.drop(key); this.misses++; return undefined; }
    this.map.delete(key); this.map.set(key, e); // más reciente al final
    this.hits++;
    return e.v;
  }
  set(key: string, v: V) {
    if (v.body.length > this.maxBytes / 3) return;
    if (this.map.has(key)) this.drop(key);
    this.map.set(key, { v, at: Date.now() });
    this.bytes += v.body.length;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) this.drop(this.map.keys().next().value!);
  }
  private drop(key: string) { const e = this.map.get(key); if (!e) return; this.bytes -= e.v.body.length; this.map.delete(key); }
  get size() { return this.map.size; }
  get totalBytes() { return this.bytes; }
  /** Lee de la caché o, si no está, de `load` (una sola carga a la vez por clave). */
  private inflight = new Map<string, Promise<V>>();
  async through(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit) return hit;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = load().then((v) => { this.set(key, v); return v; }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
