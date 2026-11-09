import type { Logger } from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import type { RiotStats } from "@dzajcarz/module-riot";
import { createLolStats } from "./lol.ts";
import { createValorantStats } from "./valorant.ts";

export interface RiotStatsDeps {
  apiKey: string;
  cache: Pick<KeyValueStore, "get" | "set">;
  logger: Logger;
}

/** Valorant goes through wrapper-valorant-api, League through plain fetch (ADR 8). */
export function createRiotStats({ apiKey, cache, logger }: RiotStatsDeps): RiotStats {
  const valorant = createValorantStats({ apiKey, store: cache, logger });
  const lol = createLolStats({ apiKey, store: cache, logger });
  return { valorant: valorant.valorant, lol: lol.lol };
}
