import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import type { GuildSettingsRow } from "@dzajcarz/db";
import { createMemoryStore } from "@dzajcarz/kv";
import { createPrefixResolver } from "./prefix-resolver.ts";
import { createPrefixSettings } from "./prefix-settings.ts";

const GUILD = "123456789012345678";

function setup() {
  let prefix: string | null = null;
  const settings = {
    async find(): Promise<GuildSettingsRow | null> {
      return prefix === null
        ? null
        : {
            guild_id: GUILD,
            prefix,
            time_zone: null,
            locale: null,
            created_at: new Date(),
            updated_at: new Date(),
          };
    },
    async setPrefix(_guildId: string, next: string | null): Promise<GuildSettingsRow> {
      prefix = next;
      return {
        guild_id: GUILD,
        prefix,
        time_zone: null,
        locale: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
    },
  };
  const resolver = createPrefixResolver({
    settings,
    cache: createMemoryStore(),
    defaultPrefix: "!",
    logger: silentLogger,
  });
  return { resolver, prefixes: createPrefixSettings(settings, resolver) };
}

describe("prefix settings adapter", () => {
  test("a new prefix applies at once, even after the old one was cached", async () => {
    const { resolver, prefixes } = setup();
    expect(await resolver.resolve(GUILD)).toBe("!");
    await prefixes.set(GUILD, "?");
    expect(await resolver.resolve(GUILD)).toBe("?");
    expect(await prefixes.get(GUILD)).toBe("?");
  });

  test("reset goes back to the default at once", async () => {
    const { resolver, prefixes } = setup();
    await prefixes.set(GUILD, "?");
    expect(await resolver.resolve(GUILD)).toBe("?");
    await prefixes.reset(GUILD);
    expect(await resolver.resolve(GUILD)).toBe("!");
    expect(await prefixes.get(GUILD)).toBeNull();
  });
});
