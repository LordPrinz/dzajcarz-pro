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

  test("two forgets for one guild cannot leave the older read cached", async () => {
    let calls = 0;
    const cache = createGuildSettingCache({
      name: "prefix",
      async load() {
        // The first read is slow and sees the old value; the second sees the new one.
        if (++calls === 1) {
          await Bun.sleep(20);
          return "old";
        }
        return "new";
      },
      fallback: "!",
      cache: createMemoryStore(),
      logger: silentLogger,
    });
    await Promise.all([cache.forget(GUILD), cache.forget(GUILD)]);
    expect(await cache.resolve(GUILD)).toBe("new");
    expect(calls).toBe(2);
  });
});
