import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import type { DisabledModule } from "@dzajcarz/db";
import { createMemoryStore, type KeyValueStore } from "@dzajcarz/kv";
import { createModuleGate } from "./module-gate.ts";

const GUILD = "100000000000000001";
const CHANNEL = "300000000000000003";
const OTHER_CHANNEL = "300000000000000004";

function setup(entries: DisabledModule[] = []) {
  const state = { entries, lookups: 0, dbDown: false };
  const toggles = {
    async listDisabled() {
      state.lookups++;
      if (state.dbDown) throw new Error("postgres down");
      return state.entries;
    },
  };
  const cache = createMemoryStore();
  const gate = createModuleGate({ toggles, cache, logger: silentLogger });
  return { gate, state, cache };
}

/** A store whose every operation fails, like Redis being unreachable. */
function brokenStore(): KeyValueStore {
  const fail = async () => {
    throw new Error("redis down");
  };
  return {
    get: fail,
    set: fail,
    setIfAbsent: fail,
    del: fail,
    delIfEquals: fail,
    increment: fail,
    ping: async () => false,
  };
}

describe("module gate", () => {
  test("everything is enabled for a guild with no toggles", async () => {
    const { gate } = setup();
    expect(await gate.isEnabled(GUILD, CHANNEL, "music")).toBe(true);
  });

  test("a guild-wide entry disables the module in every channel and for guild-level events", async () => {
    const { gate } = setup([{ module: "music", channelId: null }]);
    expect(await gate.isEnabled(GUILD, CHANNEL, "music")).toBe(false);
    expect(await gate.isEnabled(GUILD, OTHER_CHANNEL, "music")).toBe(false);
    expect(await gate.isEnabled(GUILD, null, "music")).toBe(false);
    expect(await gate.isEnabled(GUILD, CHANNEL, "welcome")).toBe(true);
  });

  test("a channel entry disables the module in that channel only", async () => {
    const { gate } = setup([{ module: "music", channelId: CHANNEL }]);
    expect(await gate.isEnabled(GUILD, CHANNEL, "music")).toBe(false);
    expect(await gate.isEnabled(GUILD, OTHER_CHANNEL, "music")).toBe(true);
    // Guild-level events carry no channel, so a channel entry does not apply.
    expect(await gate.isEnabled(GUILD, null, "music")).toBe(true);
  });

  test("DMs and protected modules are always enabled", async () => {
    const { gate, state } = setup([
      { module: "general", channelId: null },
      { module: "settings", channelId: null },
    ]);
    expect(await gate.isEnabled(null, CHANNEL, "music")).toBe(true);
    expect(await gate.isEnabled(GUILD, CHANNEL, "general")).toBe(true);
    expect(await gate.isEnabled(GUILD, CHANNEL, "settings")).toBe(true);
    expect(state.lookups).toBe(0);
  });

  test("loads a guild once, then serves it from the cache until forget", async () => {
    const { gate, state } = setup([{ module: "music", channelId: null }]);
    await gate.isEnabled(GUILD, CHANNEL, "music");
    await gate.isEnabled(GUILD, CHANNEL, "welcome");
    expect(state.lookups).toBe(1);

    state.entries = [];
    expect(await gate.isEnabled(GUILD, CHANNEL, "music")).toBe(false);
    await gate.forget(GUILD);
    expect(await gate.isEnabled(GUILD, CHANNEL, "music")).toBe(true);
    expect(state.lookups).toBe(2);
  });

  test("an empty set is cached too", async () => {
    const { gate, state } = setup();
    await gate.isEnabled(GUILD, CHANNEL, "music");
    await gate.isEnabled(GUILD, CHANNEL, "music");
    expect(state.lookups).toBe(1);
  });

  test("reloads from Postgres when the cached value is garbage", async () => {
    const { gate, state, cache } = setup([{ module: "music", channelId: null }]);
    await cache.set(`guild:${GUILD}:modules-off`, "{not json");
    expect(await gate.isEnabled(GUILD, CHANNEL, "music")).toBe(false);
    expect(state.lookups).toBe(1);
  });

  test("falls back to Postgres when Redis is down", async () => {
    const state = { lookups: 0 };
    const gate = createModuleGate({
      toggles: {
        async listDisabled() {
          state.lookups++;
          return [{ module: "music", channelId: null }];
        },
      },
      cache: brokenStore(),
      logger: silentLogger,
    });
    expect(await gate.isEnabled(GUILD, CHANNEL, "music")).toBe(false);
    expect(await gate.isEnabled(GUILD, CHANNEL, "music")).toBe(false);
    expect(state.lookups).toBe(2);
  });

  test("fails open when Postgres is down, and recovers without a restart", async () => {
    const { gate, state } = setup([{ module: "music", channelId: null }]);
    state.dbDown = true;
    expect(await gate.isEnabled(GUILD, CHANNEL, "music")).toBe(true);
    state.dbDown = false;
    expect(await gate.isEnabled(GUILD, CHANNEL, "music")).toBe(false);
  });

  test("fails open when the lookup is slower than the timeout", async () => {
    const gate = createModuleGate({
      toggles: { listDisabled: () => new Promise(() => {}) },
      cache: createMemoryStore(),
      logger: silentLogger,
      timeoutMs: 20,
    });
    expect(await gate.isEnabled(GUILD, CHANNEL, "music")).toBe(true);
  });

  test("forget does not throw when Redis is down", async () => {
    const gate = createModuleGate({
      toggles: { listDisabled: async () => [] },
      cache: brokenStore(),
      logger: silentLogger,
    });
    await expect(gate.forget(GUILD)).resolves.toBeUndefined();
  });

  test("fails open when both Redis and Postgres are down", async () => {
    const gate = createModuleGate({
      toggles: {
        async listDisabled() {
          throw new Error("postgres down");
        },
      },
      cache: brokenStore(),
      logger: silentLogger,
    });
    expect(await gate.isEnabled(GUILD, CHANNEL, "music")).toBe(true);
  });
});
