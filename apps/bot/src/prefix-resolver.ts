import type { Logger } from "@dzajcarz/core";
import type { GuildSettingsRepository } from "@dzajcarz/db";
import type { KeyValueStore } from "@dzajcarz/kv";

export interface PrefixResolver {
  /** The prefix that starts a text command in this guild (the default in DMs). */
  resolve(guildId: string | null): Promise<string>;
  /** After the guild changes its prefix: puts what Postgres now holds into the cache (drops it on failure). */
  forget(guildId: string): Promise<void>;
}

export interface PrefixResolverDeps {
  settings: Pick<GuildSettingsRepository, "find">;
  cache: KeyValueStore;
  defaultPrefix: string;
  logger: Logger;
  ttlMs?: number;
}

/** Stored for guilds that use the default, so they are not looked up in Postgres on every message. */
const DEFAULT_MARKER = "";
const key = (guildId: string) => `guild:${guildId}:prefix`;

/**
 * Every message in every guild goes through this, so the guild's prefix is cached in Redis. If Redis
 * is down it reads Postgres; if Postgres is down too it falls back to the default prefix.
 */
export function createPrefixResolver({
  settings,
  cache,
  defaultPrefix,
  logger,
  ttlMs = 10 * 60_000,
}: PrefixResolverDeps): PrefixResolver {
  return {
    async resolve(guildId) {
      if (guildId === null) return defaultPrefix;

      const cached = await cache.get(key(guildId)).catch((error: unknown) => {
        logger.warn("Prefix cache read failed", { guildId, error });
        return null;
      });
      if (cached !== null) return cached === DEFAULT_MARKER ? defaultPrefix : cached;

      let stored: string | null;
      try {
        stored = (await settings.find(guildId))?.prefix ?? null;
      } catch (error) {
        logger.error("Prefix lookup failed; using the default prefix", { guildId, error });
        return defaultPrefix;
      }
      // Only into an empty slot: a change made while this read was in flight has already written the newer
      // value, and an unconditional set would put the old prefix back for the whole TTL.
      await cache
        .setIfAbsent(key(guildId), stored ?? DEFAULT_MARKER, ttlMs)
        .catch((error: unknown) => {
          logger.warn("Prefix cache write failed", { guildId, error });
        });
      return stored ?? defaultPrefix;
    },

    async forget(guildId) {
      try {
        const stored = (await settings.find(guildId))?.prefix ?? null;
        await cache.set(key(guildId), stored ?? DEFAULT_MARKER, ttlMs);
      } catch (error) {
        logger.warn("Prefix cache refresh failed; dropping the entry", { guildId, error });
        await cache.del(key(guildId)).catch((delError: unknown) => {
          logger.warn("Prefix cache invalidation failed", { guildId, error: delError });
        });
      }
    },
  };
}
