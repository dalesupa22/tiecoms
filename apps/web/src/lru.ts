/** Map con tope: al pasarse, sale la entrada usada hace más tiempo (get y set cuentan como uso). docs/MEMORIA.md */
export class LruMap<K, V> {
  private m = new Map<K, V>();
  constructor(private max: number) {}
  get size() { return this.m.size; }
  has(k: K) { return this.m.has(k); }
  get(k: K): V | undefined {
    if (!this.m.has(k)) return undefined;
    const v = this.m.get(k) as V;
    this.m.delete(k); this.m.set(k, v);
    return v;
  }
  set(k: K, v: V) {
    this.m.delete(k); this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K);
    return this;
  }
  delete(k: K) { return this.m.delete(k); }
  clear() { this.m.clear(); }
}
