import type { Logger } from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";

/** One per-guild setting read on hot paths (every message, every minute), cached in Redis. */
export interface GuildSettingCache {
  /** The guild's value, or the fallback for a guild without one and outside guilds (`null`). */
  resolve(guildId: string | null): Promise<string>;
  /** After the guild changes the setting: puts what Postgres now holds into the cache (drops it on failure). */
  forget(guildId: string): Promise<void>;
}

export interface GuildSettingCacheDeps {
  /** Names the setting in keys and logs, e.g. `prefix`. */
  name: string;
  /** The guild's own value from Postgres; null when it uses the fallback. */
  load(guildId: string): Promise<string | null>;
  fallback: string;
  cache: KeyValueStore;
  logger: Logger;
  ttlMs?: number;
}

/** Stored for guilds that use the fallback, so they are not looked up in Postgres every time. */
const FALLBACK_MARKER = "";

/**
 * If Redis is down it reads Postgres; if Postgres is down too it answers with the fallback. A lookup only
 * fills an empty slot (`setIfAbsent`) and a change writes the new value, so a read that raced a change
 * cannot bring the old value back for the TTL.
 */
export function createGuildSettingCache({
  name,
  load,
  fallback,
  cache,
  logger,
  ttlMs = 10 * 60_000,
}: GuildSettingCacheDeps): GuildSettingCache {
  const key = (guildId: string) => `guild:${guildId}:${name}`;
  return {
    async resolve(guildId) {
      if (guildId === null) return fallback;

      const cached = await cache.get(key(guildId)).catch((error: unknown) => {
        logger.warn("Guild setting cache read failed", { setting: name, guildId, error });
        return null;
      });
      if (cached !== null) return cached === FALLBACK_MARKER ? fallback : cached;

      let stored: string | null;
      try {
        stored = await load(guildId);
      } catch (error) {
        logger.error("Guild setting lookup failed; using the fallback", {
          setting: name,
          guildId,
          error,
        });
        return fallback;
      }
      await cache
        .setIfAbsent(key(guildId), stored ?? FALLBACK_MARKER, ttlMs)
        .catch((error: unknown) => {
          logger.warn("Guild setting cache write failed", { setting: name, guildId, error });
        });
      return stored ?? fallback;
    },

    async forget(guildId) {
      try {
        const stored = await load(guildId);
        await cache.set(key(guildId), stored ?? FALLBACK_MARKER, ttlMs);
      } catch (error) {
        logger.warn("Guild setting cache refresh failed; dropping the entry", {
          setting: name,
          guildId,
          error,
        });
        await cache.del(key(guildId)).catch((delError: unknown) => {
          logger.warn("Guild setting cache invalidation failed", {
            setting: name,
            guildId,
            error: delError,
          });
        });
      }
    },
  };
}
