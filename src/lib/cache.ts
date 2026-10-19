/** Small in-memory TTL cache with a size cap. Only ever used for PUBLIC data (never tokens or user links). */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expires: number }>();
  private inflight = new Map<string, Promise<V>>();
  constructor(private readonly maxEntries = 500, private readonly now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: this.now() + ttlMs });
  }

  /** Return the cached value or compute it once (concurrent callers share the same promise). Failures are not cached. */
  async wrap(key: string, ttlMs: number, load: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = load()
      .then((v) => {
        this.set(key, v, ttlMs);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  clear(): void {
    this.store.clear();
  }
}
