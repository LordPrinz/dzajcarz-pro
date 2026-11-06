/**
 * Port for short-lived shared state (caches, cooldowns, rate limits). Values are strings; callers
 * serialise. Durable data belongs in Postgres, never here.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  /** Stores a value; with `ttlMs` it expires after that many milliseconds. */
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Stores the value only when the key is free (a lock). True when this call took it; it expires after `ttlMs`. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Atomically increments a counter. The first increment starts a window of `ttlMs`. */
  increment(key: string, ttlMs: number): Promise<Counter>;
  /** True when the backing store answers; never throws. */
  ping(): Promise<boolean>;
}

export interface Counter {
  count: number;
  /** Milliseconds until the counter resets. */
  ttlMs: number;
}

export function assertTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`TTL must be a positive integer of milliseconds, got ${ttlMs}`);
  }
}
