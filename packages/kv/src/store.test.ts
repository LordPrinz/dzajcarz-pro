import { afterAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { createMemoryStore } from "./memory.ts";
import { createRedisStore } from "./redis.ts";
import type { KeyValueStore } from "./store.ts";

// Shared contract: every KeyValueStore adapter must pass the same suite.
// The Redis adapter runs only when a disposable Redis is available (CI provides one).
const redisUrl = Bun.env.TEST_REDIS_URL;
const redis = redisUrl ? new RedisClient(redisUrl) : undefined;
afterAll(() => redis?.close());

const adapters: [string, () => KeyValueStore][] = [["memory", () => createMemoryStore()]];
if (redis) {
  adapters.push([
    "redis",
    () => createRedisStore(redis, { prefix: `test:${crypto.randomUUID()}:` }),
  ]);
}

describe.each(adapters)("KeyValueStore (%s)", (_name, make) => {
  test("get returns null for a missing key", async () => {
    expect(await make().get("missing")).toBeNull();
  });

  test("set, get and del round-trip", async () => {
    const store = make();
    await store.set("a", "1");
    expect(await store.get("a")).toBe("1");
    await store.del("a");
    expect(await store.get("a")).toBeNull();
  });

  test("a value with a TTL expires", async () => {
    const store = make();
    await store.set("short", "x", 50);
    expect(await store.get("short")).toBe("x");
    await Bun.sleep(120);
    expect(await store.get("short")).toBeNull();
  });

  test("setIfAbsent takes a free key once and refuses it while held", async () => {
    const store = make();
    expect(await store.setIfAbsent("lock", "a", 10_000)).toBe(true);
    expect(await store.setIfAbsent("lock", "b", 10_000)).toBe(false);
    expect(await store.get("lock")).toBe("a");
    await store.del("lock");
    expect(await store.setIfAbsent("lock", "c", 10_000)).toBe(true);
  });

  test("setIfAbsent frees the key when its TTL ends", async () => {
    const store = make();
    expect(await store.setIfAbsent("lock", "a", 50)).toBe(true);
    await Bun.sleep(120);
    expect(await store.setIfAbsent("lock", "b", 50)).toBe(true);
  });

  test("setIfAbsent lets only one of many concurrent callers win", async () => {
    const store = make();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.setIfAbsent("race", "x", 10_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("increment counts up and keeps the first window", async () => {
    const store = make();
    const first = await store.increment("hits", 10_000);
    const second = await store.increment("hits", 10_000);
    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(second.ttlMs).toBeGreaterThan(0);
    expect(second.ttlMs).toBeLessThanOrEqual(first.ttlMs);
  });

  test("increment restarts after the window ends", async () => {
    const store = make();
    await store.increment("burst", 50);
    await Bun.sleep(120);
    expect((await store.increment("burst", 50)).count).toBe(1);
  });

  test("a counter without a TTL gets one on the next increment", async () => {
    const store = make();
    await store.set("stale", "5");
    const counter = await store.increment("stale", 10_000);
    expect(counter.count).toBe(6);
    expect(counter.ttlMs).toBeGreaterThan(0);
  });

  test("rejects a non-positive TTL", async () => {
    const store = make();
    await expect(store.set("k", "v", 0)).rejects.toThrow(RangeError);
    await expect(store.increment("k", -1)).rejects.toThrow(RangeError);
    await expect(store.setIfAbsent("k", "v", 0)).rejects.toThrow(RangeError);
  });

  test("ping reports the store as up", async () => {
    expect(await make().ping()).toBe(true);
  });
});

describe("redis store", () => {
  test("ping reports down instead of throwing when Redis is unreachable", async () => {
    const client = new RedisClient("redis://127.0.0.1:1", {
      autoReconnect: false,
      connectionTimeout: 200,
    });
    try {
      expect(await createRedisStore(client, { pingTimeoutMs: 300 }).ping()).toBe(false);
    } finally {
      client.close();
    }
  });
});
