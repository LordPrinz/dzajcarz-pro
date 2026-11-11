import type { KeyValueStore } from "./store.ts";

const never = () => new Promise<never>(() => {});

/** Test double for a Redis that accepts calls and never answers; `ping` reports it as down. */
export function createStalledStore(): KeyValueStore {
  return {
    get: never,
    set: never,
    setIfAbsent: never,
    del: never,
    delIfEquals: never,
    increment: never,
    ping: async () => false,
  };
}
