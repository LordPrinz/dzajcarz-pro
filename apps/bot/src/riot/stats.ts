import type { Logger } from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import type { RiotStats } from "@dzajcarz/module-riot";
import { createLolStats } from "./lol.ts";
import { createValorantStats } from "./valorant.ts";

export interface RiotStatsDeps {
  /** Riot issues a separate key per game; a game without its key is left out. */
  valorantApiKey?: string | undefined;
  lolApiKey?: string | undefined;
  cache: Pick<KeyValueStore, "get" | "set">;
  logger: Logger;
}

/** Valorant goes through wrapper-valorant-api, League through plain fetch (ADR 8). */
export function createRiotStats({
  valorantApiKey,
  lolApiKey,
  cache,
  logger,
}: RiotStatsDeps): Partial<RiotStats> {
  return {
    ...(valorantApiKey && {
      valorant: createValorantStats({ apiKey: valorantApiKey, store: cache, logger }).valorant,
    }),
    ...(lolApiKey && {
      lol: createLolStats({ apiKey: lolApiKey, store: cache, logger }).lol,
    }),
  };
}
