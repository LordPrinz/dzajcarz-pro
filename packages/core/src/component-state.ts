import { UserError } from "./errors.ts";
import { coreMessages } from "./messages.ts";

/** Thrown by `ComponentStateStore.load` once the saved state is gone; the caller is told the menu expired. */
export class ExpiredStateError extends UserError {
  constructor() {
    super((locale) => coreMessages(locale).menuExpired);
  }
}

/** The slice of `KeyValueStore` (@dzajcarz/kv) this needs. */
export interface StateStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
}

export interface ComponentStateStore {
  /** Saves JSON-serialisable state and returns a short key to put in the custom_id data. */
  save(value: unknown): Promise<string>;
  /** Throws ExpiredStateError when the key is unknown or past its TTL. */
  load<T>(key: string): Promise<T>;
}

/** Length of a generated key: 16 random bytes in base64url. It sits in the custom_id, so it counts. */
export const STATE_KEY_LENGTH = 22;

function randomKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

export const COMPONENT_STATE_TTL_MS = 15 * 60_000;

/**
 * For state too big for a custom_id (a list of search results, a long help tree). It lives in the
 * KeyValueStore, which is allowed to lose it (ADR 3): the user then re-runs the command.
 */
export function createComponentStateStore(
  storage: StateStorage,
  {
    ttlMs = COMPONENT_STATE_TTL_MS,
    newKey = randomKey,
  }: { ttlMs?: number; newKey?: () => string } = {},
): ComponentStateStore {
  const storageKey = (key: string) => `component-state:${key}`;
  return {
    async save(value) {
      const key = newKey();
      await storage.set(storageKey(key), JSON.stringify(value), ttlMs);
      return key;
    },
    async load<T>(key: string): Promise<T> {
      const raw = await storage.get(storageKey(key));
      if (raw === null) throw new ExpiredStateError();
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new ExpiredStateError();
      }
    },
  };
}
