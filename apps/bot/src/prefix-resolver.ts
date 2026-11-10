import type { Logger } from "@dzajcarz/core";
import type { GuildSettingsRepository } from "@dzajcarz/db";
import type { KeyValueStore } from "@dzajcarz/kv";
import { createGuildSettingCache } from "./guild-setting-cache.ts";

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

/**
 * Every message in every guild goes through this, so the guild's prefix is cached in Redis (see
 * `createGuildSettingCache` for what happens when Redis or Postgres is down).
 */
export function createPrefixResolver({
  settings,
  cache,
  defaultPrefix,
  logger,
  ttlMs,
}: PrefixResolverDeps): PrefixResolver {
  const prefixes = createGuildSettingCache({
    name: "prefix",
    load: async (guildId) => (await settings.find(guildId))?.prefix ?? null,
    fallback: defaultPrefix,
    cache,
    logger,
    ttlMs,
  });
  return { resolve: prefixes.resolve, forget: prefixes.forget };
}
