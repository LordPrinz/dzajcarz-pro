import { assertTtl, type Counter, type KeyValueStore } from "./store.ts";

interface Entry {
  value: string;
  expiresAt: number;
}

/** In-process store for tests and local tools. Not shared between processes. */
export function createMemoryStore(now: () => number = Date.now): KeyValueStore {
  const entries = new Map<string, Entry>();

  function live(key: string): Entry | undefined {
    const entry = entries.get(key);
    if (entry && entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ttlMs) {
      if (ttlMs !== undefined) assertTtl(ttlMs);
      entries.set(key, { value, expiresAt: ttlMs === undefined ? Infinity : now() + ttlMs });
    },
    async setIfAbsent(key, value, ttlMs) {
      assertTtl(ttlMs);
      if (live(key)) return false;
      entries.set(key, { value, expiresAt: now() + ttlMs });
      return true;
    },
    async del(key) {
      entries.delete(key);
    },
    async delIfEquals(key, value) {
      if (live(key)?.value !== value) return false;
      entries.delete(key);
      return true;
    },
    async increment(key, ttlMs): Promise<Counter> {
      assertTtl(ttlMs);
      const entry = live(key);
      const count = (entry ? Number(entry.value) : 0) + 1;
      const expiresAt = entry && entry.expiresAt !== Infinity ? entry.expiresAt : now() + ttlMs;
      entries.set(key, { value: String(count), expiresAt });
      return { count, ttlMs: expiresAt - now() };
    },
    async ping() {
      return true;
    },
  };
}
