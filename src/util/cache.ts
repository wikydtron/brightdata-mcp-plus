interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * LRU cache with per-entry TTL and single-flight loading: concurrent misses for
 * the same key share one upstream call, so a burst of identical requests is
 * billed once.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    if (ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Returns [value, fromCache]. Failed loads are never cached. */
  async getOrLoad(key: string, load: () => Promise<V>, opts: { bypass?: boolean } = {}): Promise<[V, boolean]> {
    if (!opts.bypass) {
      const cached = this.get(key);
      if (cached !== undefined) {
        this.hits++;
        return [cached, true];
      }
      const pending = this.inflight.get(key);
      if (pending) {
        this.hits++;
        return [await pending, true];
      }
    }
    this.misses++;
    const promise = load();
    this.inflight.set(key, promise);
    try {
      const value = await promise;
      this.set(key, value);
      return [value, false];
    } finally {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    }
  }
}
