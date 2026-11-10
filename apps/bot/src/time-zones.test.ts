import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import type { GuildSettingsRow } from "@dzajcarz/db";
import { createMemoryStore } from "@dzajcarz/kv";
import { createTimeZones } from "./time-zones.ts";

const GUILD = "100000000000000001";

function setup() {
  const stored = new Map<string, string | null>();
  let lookups = 0;
  const row = (guildId: string): GuildSettingsRow => ({
    guild_id: guildId,
    prefix: null,
    time_zone: stored.get(guildId) ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  const zones = createTimeZones({
    settings: {
      find: async (guildId) => {
        lookups++;
        return stored.has(guildId) ? row(guildId) : null;
      },
      setTimeZone: async (guildId, zone) => {
        stored.set(guildId, zone);
        return row(guildId);
      },
    },
    cache: createMemoryStore(),
    defaultTimeZone: "Europe/Warsaw",
    logger: silentLogger,
  });
  return { zones, lookups: () => lookups };
}

describe("server time zones", () => {
  test("a server without a zone and DMs use the default; the lookup is cached", async () => {
    const { zones, lookups } = setup();
    expect(await zones.of(GUILD)).toBe("Europe/Warsaw");
    expect(await zones.of(GUILD)).toBe("Europe/Warsaw");
    expect(await zones.of(null)).toBe("Europe/Warsaw");
    expect(lookups()).toBe(1);
  });

  test("set and reset apply at once despite the cache", async () => {
    const { zones } = setup();
    await zones.of(GUILD);
    await zones.settings.set(GUILD, "Asia/Tokyo");
    expect(await zones.of(GUILD)).toBe("Asia/Tokyo");
    expect(await zones.settings.get(GUILD)).toBe("Asia/Tokyo");
    await zones.settings.reset(GUILD);
    expect(await zones.of(GUILD)).toBe("Europe/Warsaw");
    expect(await zones.settings.get(GUILD)).toBeNull();
  });
});
