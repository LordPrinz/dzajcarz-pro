import { describe, expect, test } from "bun:test";
import { TimeoutError } from "@dzajcarz/core";
import { createMemoryStore } from "./memory.ts";
import { createStalledStore } from "./stalled.ts";
import { createTimedStore } from "./timed.ts";

describe("createTimedStore", () => {
  test("passes calls through while the store answers", async () => {
    const store = createTimedStore(createMemoryStore(), 50);
    await store.set("a", "1");
    expect(await store.get("a")).toBe("1");
    expect(await store.setIfAbsent("b", "x", 1000)).toBe(true);
    expect((await store.increment("c", 1000)).count).toBe(1);
    expect(await store.delIfEquals("b", "x")).toBe(true);
    await store.del("a");
    expect(await store.get("a")).toBeNull();
  });

  test("a store that never answers rejects every call after the limit", async () => {
    const store = createTimedStore(createStalledStore(), 20);
    const results = await Promise.allSettled([
      store.get("a"),
      store.set("a", "1"),
      store.setIfAbsent("a", "1", 1000),
      store.del("a"),
      store.delIfEquals("a", "1"),
      store.increment("a", 1000),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(TimeoutError);
    }
  });

  test("ping is passed through untouched", async () => {
    expect(await createTimedStore(createStalledStore(), 20).ping()).toBe(false);
  });
});
