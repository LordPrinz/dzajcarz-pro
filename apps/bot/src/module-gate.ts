import { type Logger, TimeoutError, withTimeout } from "@dzajcarz/core";
import type { ModuleToggleRepository } from "@dzajcarz/db";
import type { KeyValueStore } from "@dzajcarz/kv";
import { PROTECTED_MODULES } from "@dzajcarz/module-settings";

export interface ModuleGate {
  /**
   * Whether `module` may act in this guild and channel. Always true in DMs (guildId null) and for
   * protected modules. `channelId` is null for events that belong to the guild as a whole.
   */
  isEnabled(guildId: string | null, channelId: string | null, module: string): Promise<boolean>;
  /** Drops the cached set after the guild changes its toggles. */
  forget(guildId: string): Promise<void>;
}

export interface ModuleGateDeps {
  toggles: Pick<ModuleToggleRepository, "listDisabled">;
  cache: KeyValueStore;
  logger: Logger;
  ttlMs?: number;
  /** How long a lookup may take before the module counts as enabled. */
  timeoutMs?: number;
  /**
   * The category a channel sits in, so a toggle set on a category covers its channels. Callers pass a
   * thread's parent channel, never the thread. Without it only channel and guild toggles apply.
   */
  categoryOf?: (channelId: string) => string | null;
}

interface Entry {
  module: string;
  channelId: string | null;
}

const key = (guildId: string) => `guild:${guildId}:modules-off`;

function parseEntries(raw: string): Entry[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const entries: Entry[] = [];
    for (const item of value) {
      if (typeof item?.module !== "string") return null;
      if (item.channelId !== null && typeof item.channelId !== "string") return null;
      entries.push({ module: item.module, channelId: item.channelId });
    }
    return entries;
  } catch {
    return null;
  }
}

/**
 * Every command and event goes through this, so a guild's disabled modules are loaded once and cached
 * in Redis as JSON. If Redis is down it reads Postgres; if Postgres is down too the module counts as
 * enabled (fail open): a database outage should not silence the whole bot.
 */
export function createModuleGate({
  toggles,
  cache,
  logger,
  ttlMs = 10 * 60_000,
  timeoutMs = 1500,
  categoryOf,
}: ModuleGateDeps): ModuleGate {
  async function load(guildId: string): Promise<Entry[] | null> {
    const cached = await cache.get(key(guildId)).catch((error: unknown) => {
      logger.warn("Module toggle cache read failed", { guildId, error });
      return null;
    });
    if (cached !== null) {
      const entries = parseEntries(cached);
      if (entries) return entries;
      logger.warn("Module toggle cache holds invalid data; reloading", { guildId });
    }

    let entries: Entry[];
    try {
      entries = await toggles.listDisabled(guildId);
    } catch (error) {
      logger.error("Module toggle lookup failed; treating modules as enabled", { guildId, error });
      return null;
    }
    // An empty slot is only filled, so a toggle written while this read was in flight is not undone (see
    // forget); a garbage entry is overwritten.
    const value = JSON.stringify(entries);
    await (cached === null
      ? cache.setIfAbsent(key(guildId), value, ttlMs)
      : cache.set(key(guildId), value, ttlMs)
    ).catch((error: unknown) => {
      logger.warn("Module toggle cache write failed", { guildId, error });
    });
    return entries;
  }

  /** A slow Redis plus a slow Postgres must not eat the 3 s Discord gives an interaction to respond. */
  function loadWithin(guildId: string): Promise<Entry[] | null> {
    return withTimeout(load(guildId), timeoutMs).catch((error: unknown) => {
      logger.warn(
        error instanceof TimeoutError
          ? "Module toggle lookup timed out; treating modules as enabled"
          : "Module toggle lookup failed; treating modules as enabled",
        { guildId, timeoutMs, error },
      );
      return null;
    });
  }

  async function refresh(guildId: string): Promise<void> {
    try {
      const entries = await toggles.listDisabled(guildId);
      await cache.set(key(guildId), JSON.stringify(entries), ttlMs);
    } catch (error) {
      logger.warn("Module toggle cache refresh failed; dropping the entry", { guildId, error });
      await cache.del(key(guildId)).catch((delError: unknown) => {
        logger.warn("Module toggle cache invalidation failed", { guildId, error: delError });
      });
    }
  }

  // Refreshes of one guild run one after another: overlapping ones could write an older read last and keep it
  // for the TTL. An entry leaves the map once its chain has drained. `refresh` never rejects.
  const refreshing = new Map<string, Promise<void>>();

  return {
    async isEnabled(guildId, channelId, module) {
      if (guildId === null || PROTECTED_MODULES.has(module)) return true;
      const entries = await loadWithin(guildId);
      if (!entries) return true;
      const category = channelId === null ? null : (categoryOf?.(channelId) ?? null);
      return !entries.some(
        (entry) =>
          entry.module === module &&
          (entry.channelId === null ||
            entry.channelId === channelId ||
            (category !== null && entry.channelId === category)),
      );
    },

    forget(guildId) {
      const run = (refreshing.get(guildId) ?? Promise.resolve()).then(() => refresh(guildId));
      refreshing.set(guildId, run);
      return run.then(() => {
        if (refreshing.get(guildId) === run) refreshing.delete(guildId);
      });
    },
  };
}
