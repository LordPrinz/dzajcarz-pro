import type { Logger } from "@dzajcarz/core";
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
    await cache.set(key(guildId), JSON.stringify(entries), ttlMs).catch((error: unknown) => {
      logger.warn("Module toggle cache write failed", { guildId, error });
    });
    return entries;
  }

  /** A slow Redis plus a slow Postgres must not eat the 3 s Discord gives an interaction to respond. */
  async function loadWithin(guildId: string): Promise<Entry[] | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        logger.warn("Module toggle lookup timed out; treating modules as enabled", {
          guildId,
          timeoutMs,
        });
        resolve(null);
      }, timeoutMs);
    });
    try {
      return await Promise.race([load(guildId), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async isEnabled(guildId, channelId, module) {
      if (guildId === null || PROTECTED_MODULES.has(module)) return true;
      const entries = await loadWithin(guildId);
      if (!entries) return true;
      return !entries.some(
        (entry) =>
          entry.module === module && (entry.channelId === null || entry.channelId === channelId),
      );
    },

    async forget(guildId) {
      // Postgres already has the change; a stale cache entry expires on its own.
      await cache.del(key(guildId)).catch((error: unknown) => {
        logger.warn("Module toggle cache invalidation failed", { guildId, error });
      });
    },
  };
}
