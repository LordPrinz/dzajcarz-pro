import type { RedisClient } from "bun";
import { assertTtl, type Counter, type KeyValueStore } from "./store.ts";

// One script, so a counter never lives without a TTL (also repairs one that lost it).
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { count, redis.call('PTTL', KEYS[1]) }
`;

export interface RedisStoreOptions {
  /** Namespace for every key. */
  prefix?: string;
  /** How long `ping` waits before reporting the store as down. */
  pingTimeoutMs?: number;
}

/** `KeyValueStore` on Bun's built-in Redis client (ADR 3). */
export function createRedisStore(
  client: RedisClient,
  { prefix = "dzajcarz:", pingTimeoutMs = 1_000 }: RedisStoreOptions = {},
): KeyValueStore {
  const k = (key: string) => `${prefix}${key}`;

  return {
    get: (key) => client.get(k(key)),
    async set(key, value, ttlMs) {
      if (ttlMs === undefined) {
        await client.set(k(key), value);
        return;
      }
      assertTtl(ttlMs);
      await client.set(k(key), value, "PX", ttlMs);
    },
    async del(key) {
      await client.del(k(key));
    },
    async increment(key, ttlMs): Promise<Counter> {
      assertTtl(ttlMs);
      const [count, ttl] = (await client.send("EVAL", [
        INCREMENT_SCRIPT,
        "1",
        k(key),
        String(ttlMs),
      ])) as [number, number];
      return { count, ttlMs: ttl };
    },
    async ping() {
      let timer: Timer | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(resolve, pingTimeoutMs, false);
      });
      const pong = client.ping().then(
        (reply) => reply === "PONG",
        () => false,
      );
      try {
        return await Promise.race([pong, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Connects and reconnects forever. Pair it with `enableOfflineQueue: false`, so commands fail fast
 * while Redis is down instead of hanging requests. Bun calls `onclose` after a failed connect too.
 */
export function keepConnected(client: RedisClient, retryMs = 5_000): void {
  client.onclose = (error) => {
    console.error(`Redis connection closed (${error.message}); retrying in ${retryMs} ms`);
    setTimeout(() => client.connect().catch(() => {}), retryMs);
  };
  client.connect().catch(() => {});
}
