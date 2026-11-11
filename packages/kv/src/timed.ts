import { STORE_TIMEOUT_MS, withTimeout } from "@dzajcarz/core";
import type { KeyValueStore } from "./store.ts";

/**
 * Wraps the store handed to modules so a stalled Redis rejects after `timeoutMs` like a failed one. Every
 * caller already picks fail open or fail closed for a Redis error (rate limits and cooldowns carry on, the
 * special invite limits refuse with a Polish message), so one limit here keeps each of them inside the 3 s
 * Discord gives an interaction. `ping` has its own timeout and never throws.
 */
export function createTimedStore(
  store: KeyValueStore,
  timeoutMs: number = STORE_TIMEOUT_MS,
): KeyValueStore {
  return {
    get: (key) => withTimeout(store.get(key), timeoutMs),
    set: (key, value, ttlMs) => withTimeout(store.set(key, value, ttlMs), timeoutMs),
    setIfAbsent: (key, value, ttlMs) =>
      withTimeout(store.setIfAbsent(key, value, ttlMs), timeoutMs),
    del: (key) => withTimeout(store.del(key), timeoutMs),
    delIfEquals: (key, value) => withTimeout(store.delIfEquals(key, value), timeoutMs),
    increment: (key, ttlMs) => withTimeout(store.increment(key, ttlMs), timeoutMs),
    ping: () => store.ping(),
  };
}
