import type { GuildSettingsRepository } from "@dzajcarz/db";
import type { PrefixSettings } from "@dzajcarz/module-settings";
import type { PrefixResolver } from "./prefix-resolver.ts";

/** Writes to Postgres, then drops the cached prefix so the change applies on the next message. */
export function createPrefixSettings(
  settings: Pick<GuildSettingsRepository, "find" | "setPrefix">,
  resolver: Pick<PrefixResolver, "forget">,
): PrefixSettings {
  return {
    async get(guildId) {
      return (await settings.find(guildId))?.prefix ?? null;
    },
    async set(guildId, prefix) {
      await settings.setPrefix(guildId, prefix);
      await resolver.forget(guildId);
    },
    async reset(guildId) {
      await settings.setPrefix(guildId, null);
      await resolver.forget(guildId);
    },
  };
}
