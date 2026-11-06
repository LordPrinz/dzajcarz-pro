import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import type { GuildSettingsRow } from "@dzajcarz/db";
import { createMemoryStore, type KeyValueStore } from "@dzajcarz/kv";
import { createPrefixResolver } from "./prefix-resolver.ts";

const GUILD = "123456789012345678";

function row(prefix: string | null): GuildSettingsRow {
  return { guild_id: GUILD, prefix, created_at: new Date(), updated_at: new Date() };
}

function setup(prefix: string | null, cache: KeyValueStore = createMemoryStore()) {
  let lookups = 0;
  const resolver = createPrefixResolver({
    settings: {
      async find() {
        lookups++;
        return prefix === null ? null : row(prefix);
      },
    },
    cache,
    defaultPrefix: "!",
    logger: silentLogger,
  });
  return { resolver, lookups: () => lookups };
}

describe("prefix resolver", () => {
  test("uses the default in direct messages without a lookup", async () => {
    const { resolver, lookups } = setup("?");
    expect(await resolver.resolve(null)).toBe("!");
    expect(lookups()).toBe(0);
  });

  test("reads the guild prefix once, then serves it from the cache", async () => {
    const { resolver, lookups } = setup("?");
    expect(await resolver.resolve(GUILD)).toBe("?");
    expect(await resolver.resolve(GUILD)).toBe("?");
    expect(lookups()).toBe(1);
  });

  test("caches guilds without settings as well", async () => {
    const { resolver, lookups } = setup(null);
    expect(await resolver.resolve(GUILD)).toBe("!");
    expect(await resolver.resolve(GUILD)).toBe("!");
    expect(lookups()).toBe(1);
  });

  test("forget makes the next call read Postgres again", async () => {
    const { resolver, lookups } = setup("?");
    await resolver.resolve(GUILD);
    await resolver.forget(GUILD);
    await resolver.resolve(GUILD);
    expect(lookups()).toBe(2);
  });

  test("keeps working when Redis is down", async () => {
    const broken: KeyValueStore = {
      ...createMemoryStore(),
      get: () => Promise.reject(new Error("ECONNREFUSED")),
      set: () => Promise.reject(new Error("ECONNREFUSED")),
    };
    const { resolver } = setup("?", broken);
    expect(await resolver.resolve(GUILD)).toBe("?");
  });

  test("falls back to the default when Postgres is down", async () => {
    const resolver = createPrefixResolver({
      settings: { find: () => Promise.reject(new Error("connection refused")) },
      cache: createMemoryStore(),
      defaultPrefix: "!",
      logger: silentLogger,
    });
    expect(await resolver.resolve(GUILD)).toBe("!");
  });
});
