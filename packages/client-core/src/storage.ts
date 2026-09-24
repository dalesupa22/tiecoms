/**
 * Almacenamiento local persistente. Cada plataforma aporta su adaptador:
 * IndexedDB en web/Tauri, SQLite o Preferences seguras en Android/iOS.
 * Las claves se separan por cuenta para limpiar todo al cerrar sesión.
 */
export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  clearPrefix(prefix: string): Promise<void>;
}

/** Guarda el refresh token en clientes nativos (Keychain/Keystore). La web usa cookie httpOnly. */
export interface SecretStore {
  get(): Promise<string | null>;
  set(token: string | null): Promise<void>;
}

export class MemoryStorage implements KeyValueStorage {
  private m = new Map<string, unknown>();
  async get<T>(k: string) { return this.m.get(k) as T | undefined; }
  async set<T>(k: string, v: T) { this.m.set(k, v); }
  async del(k: string) { this.m.delete(k); }
  async clearPrefix(p: string) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
}

export class IndexedDbStorage implements KeyValueStorage {
  private db: Promise<IDBDatabase>;
  constructor(name = 'tiecoms') {
    this.db = new Promise((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.db;
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req ? (req.result as T) : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  get<T>(k: string) { return this.run<T>('readonly', (s) => s.get(k) as IDBRequest<T>); }
  async set<T>(k: string, v: T) { await this.run('readwrite', (s) => { s.put(v, k); }); }
  async del(k: string) { await this.run('readwrite', (s) => { s.delete(k); }); }
  async clearPrefix(p: string) {
    await this.run('readwrite', (s) => { s.delete(IDBKeyRange.bound(p, p + '￿')); });
  }
}
