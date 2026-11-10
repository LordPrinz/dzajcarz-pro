import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import { createMemoryStore, type KeyValueStore } from "@dzajcarz/kv";
import { createGuildSettingCache } from "./guild-setting-cache.ts";

const GUILD = "123456789012345678";

/** A Redis that is connected but never answers. */
function stalledStore(): KeyValueStore {
  const never = () => new Promise<never>(() => {});
  return {
    get: never,
    set: never,
    setIfAbsent: never,
    del: never,
    delIfEquals: never,
    increment: never,
    ping: never,
  };
}

describe("guild setting cache with a stalled Redis", () => {
  test("reads Postgres when the cache read does not answer in time", async () => {
    let loads = 0;
    const cache = createGuildSettingCache({
      name: "prefix",
      async load() {
        loads++;
        return "?";
      },
      fallback: "!",
      cache: stalledStore(),
      logger: silentLogger,
      timeoutMs: 20,
    });
    expect(await cache.resolve(GUILD)).toBe("?");
    expect(loads).toBe(1);
  });

  test("a lookup waits for the stalled read once, not for the backfill", async () => {
    const cache = createGuildSettingCache({
      name: "prefix",
      load: async () => "?",
      fallback: "!",
      cache: { ...stalledStore(), get: async () => null },
      logger: silentLogger,
      timeoutMs: 1_000,
    });
    const started = Date.now();
    expect(await cache.resolve(GUILD)).toBe("?");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("forget returns after the timeout when Redis never answers", async () => {
    const cache = createGuildSettingCache({
      name: "prefix",
      load: async () => "?",
      fallback: "!",
      cache: stalledStore(),
      logger: silentLogger,
      timeoutMs: 20,
    });
    await cache.forget(GUILD);
  });

  test("answers from the cache when Redis is healthy", async () => {
    let loads = 0;
    const cache = createGuildSettingCache({
      name: "prefix",
      async load() {
        loads++;
        return "?";
      },
      fallback: "!",
      cache: createMemoryStore(),
      logger: silentLogger,
      timeoutMs: 20,
    });
    await cache.resolve(GUILD);
    expect(await cache.resolve(GUILD)).toBe("?");
    expect(loads).toBe(1);
  });
});
