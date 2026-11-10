import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import type { GuildSettingsRow } from "@dzajcarz/db";
import { createMemoryStore, type KeyValueStore } from "@dzajcarz/kv";
import { createPrefixResolver } from "./prefix-resolver.ts";

const GUILD = "123456789012345678";

function row(prefix: string | null): GuildSettingsRow {
  return {
    guild_id: GUILD,
    prefix,
    time_zone: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
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

  test("forget caches the prefix Postgres holds now", async () => {
    let prefix = "?";
    const resolver = createPrefixResolver({
      settings: { find: async () => row(prefix) },
      cache: createMemoryStore(),
      defaultPrefix: "!",
      logger: silentLogger,
    });
    expect(await resolver.resolve(GUILD)).toBe("?");
    prefix = "dz";
    await resolver.forget(GUILD);
    expect(await resolver.resolve(GUILD)).toBe("dz");
  });

  test("a lookup that read the old prefix before a change does not put it back into the cache", async () => {
    let prefix = "?";
    let releaseSlowRead: () => void = () => {};
    let slow = true;
    const resolver = createPrefixResolver({
      settings: {
        async find() {
          const seen = prefix;
          if (slow) {
            slow = false;
            await new Promise<void>((resolve) => {
              releaseSlowRead = resolve;
            });
          }
          return row(seen);
        },
      },
      cache: createMemoryStore(),
      defaultPrefix: "!",
      logger: silentLogger,
    });
    const staleRead = resolver.resolve(GUILD);
    await Bun.sleep(0);
    prefix = "dz";
    await resolver.forget(GUILD);
    releaseSlowRead();
    expect(await staleRead).toBe("?");
    expect(await resolver.resolve(GUILD)).toBe("dz");
  });

  test("forget drops the entry when Postgres cannot be read", async () => {
    const cache = createMemoryStore();
    let down = false;
    const resolver = createPrefixResolver({
      settings: {
        find: async () => {
          if (down) throw new Error("connection refused");
          return row("?");
        },
      },
      cache,
      defaultPrefix: "!",
      logger: silentLogger,
    });
    await resolver.resolve(GUILD);
    down = true;
    await resolver.forget(GUILD);
    expect(await cache.get(`guild:${GUILD}:prefix`)).toBeNull();
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

  test("forget does not throw when Redis is down", async () => {
    const broken: KeyValueStore = {
      ...createMemoryStore(),
      set: () => Promise.reject(new Error("ECONNREFUSED")),
      del: () => Promise.reject(new Error("ECONNREFUSED")),
    };
    const { resolver } = setup("?", broken);
    await expect(resolver.forget(GUILD)).resolves.toBeUndefined();
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
