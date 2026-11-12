import type { Logger } from "@dzajcarz/core";
import type { ArchiveSettingsRepository } from "@dzajcarz/db";
import type { KeyValueStore } from "@dzajcarz/kv";
import { createGuildSettingCache } from "./guild-setting-cache.ts";

/** Whether the archive stores a message, from the settings the panel edits. */
export interface ArchivePolicy {
  /**
   * True when the server is archived (or, for `guildId` null, the DM switch is on) and none of `channelIds`
   * is excluded. Pass the channel and, for a thread, its parent, so excluding a channel covers its threads.
   */
  archives(guildId: string | null, channelIds: readonly (string | null)[]): Promise<boolean>;
  /** After the server's settings changed: refreshes the cached copy. */
  forgetGuild(guildId: string): Promise<void>;
  /** After the DM switch changed: refreshes the cached copy. */
  forgetDm(): Promise<void>;
}

export interface ArchivePolicyDeps {
  settings: Pick<ArchiveSettingsRepository, "findGuild" | "dmEnabled">;
  cache: KeyValueStore;
  logger: Logger;
  ttlMs?: number;
}

interface Cached {
  enabled: boolean;
  excluded: string[];
}

const OFF = JSON.stringify({ enabled: false, excluded: [] } satisfies Cached);
/** The DM switch lives in the same cache under a key no server id can take. */
const DM_SCOPE = "dm";

/**
 * Every message the bot sees asks this, so the settings are cached in Redis like the guild prefix (see
 * `createGuildSettingCache`). When Postgres cannot be read the answer is "off": the archive misses messages
 * rather than storing ones it may not.
 */
export function createArchivePolicy({
  settings,
  cache,
  logger,
  ttlMs,
}: ArchivePolicyDeps): ArchivePolicy {
  const guilds = createGuildSettingCache({
    name: "archive",
    load: async (scope) => {
      if (scope === DM_SCOPE) {
        return JSON.stringify({ enabled: await settings.dmEnabled(), excluded: [] });
      }
      const found = await settings.findGuild(scope);
      return found
        ? JSON.stringify({ enabled: found.enabled, excluded: found.excludedChannelIds })
        : null;
    },
    fallback: OFF,
    cache,
    logger,
    ttlMs,
  });

  const read = async (scope: string): Promise<Cached> => {
    const raw = await guilds.resolve(scope);
    try {
      const parsed = JSON.parse(raw) as Partial<Cached>;
      return {
        enabled: parsed.enabled === true,
        excluded: Array.isArray(parsed.excluded) ? parsed.excluded : [],
      };
    } catch (error) {
      logger.warn("Cached archive settings are unreadable; treating the archive as off", {
        scope,
        error,
      });
      return { enabled: false, excluded: [] };
    }
  };

  return {
    async archives(guildId, channelIds) {
      const { enabled, excluded } = await read(guildId ?? DM_SCOPE);
      if (!enabled) return false;
      return !channelIds.some((id) => id !== null && excluded.includes(id));
    },
    forgetGuild: (guildId) => guilds.forget(guildId),
    forgetDm: () => guilds.forget(DM_SCOPE),
  };
}
