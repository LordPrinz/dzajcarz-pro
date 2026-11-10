import type { GuildTimeZones, Logger } from "@dzajcarz/core";
import type { GuildSettingsRepository } from "@dzajcarz/db";
import type { KeyValueStore } from "@dzajcarz/kv";
import type { TimeZoneSettings } from "@dzajcarz/module-settings";
import { createGuildSettingCache } from "./guild-setting-cache.ts";

export interface TimeZones extends GuildTimeZones {
  /** `/timezone` reads and writes through this; a write refreshes the cache. */
  settings: TimeZoneSettings;
}

/**
 * Each server's time zone. Scheduled songs ask for every server once a minute, so the zone is cached in
 * Redis like the prefix.
 */
export function createTimeZones({
  settings,
  cache,
  defaultTimeZone,
  logger,
}: {
  settings: Pick<GuildSettingsRepository, "find" | "setTimeZone">;
  cache: KeyValueStore;
  defaultTimeZone: string;
  logger: Logger;
}): TimeZones {
  const zones = createGuildSettingCache({
    name: "time-zone",
    load: async (guildId) => (await settings.find(guildId))?.time_zone ?? null,
    fallback: defaultTimeZone,
    cache,
    logger,
  });
  return {
    of: zones.resolve,
    settings: {
      async get(guildId) {
        return (await settings.find(guildId))?.time_zone ?? null;
      },
      async set(guildId, timeZone) {
        await settings.setTimeZone(guildId, timeZone);
        await zones.forget(guildId);
      },
      async reset(guildId) {
        await settings.setTimeZone(guildId, null);
        await zones.forget(guildId);
      },
    },
  };
}
