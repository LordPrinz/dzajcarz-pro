import type { Logger } from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";

type Store = Pick<KeyValueStore, "get" | "set">;

/** Keys hold Riot IDs, so logs get only the leading segments (`riot:lol:account`). */
const keyPrefix = (key: string) => key.split(":").slice(0, 3).join(":");

async function read(store: Store, key: string, logger: Logger): Promise<unknown | undefined> {
  let raw: string | null;
  try {
    raw = await store.get(key);
  } catch (error) {
    logger.warn("Riot cache read failed", { key: keyPrefix(key), error });
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function write(
  store: Store,
  key: string,
  value: unknown,
  ttlMs: number,
  logger: Logger,
): Promise<void> {
  try {
    await store.set(key, JSON.stringify(value), Math.ceil(ttlMs));
  } catch (error) {
    logger.warn("Riot cache write failed", { key: keyPrefix(key), error });
  }
}

type CachedJson = <T>(
  key: string,
  ttlMs: number,
  parse: (value: unknown) => T,
  load: () => Promise<unknown>,
) => Promise<T>;

/**
 * Returns the cached value under `key`, or loads it and keeps it for `ttlMs`. `parse` validates and
 * shrinks the body to the fields in use, and only that projection is stored. A broken entry, or one that
 * no longer parses, is a miss; a failing store only costs a request.
 */
export function createCachedJson(store: Store, logger: Logger): CachedJson {
  return async (key, ttlMs, parse, load) => {
    const cached = await read(store, key, logger);
    if (cached !== undefined) {
      try {
        return parse(cached);
      } catch {
        // The schema changed since the entry was written; load it again below.
      }
    }
    const value = parse(await load());
    await write(store, key, value, ttlMs, logger);
    return value;
  };
}
