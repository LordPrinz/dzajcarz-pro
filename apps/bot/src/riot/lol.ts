import type { Logger } from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import {
  type LolPlatform,
  type LolProfile,
  type LolQueueEntry,
  type RiotId,
  RiotLookupError,
} from "@dzajcarz/module-riot";
import { z } from "zod";
import { createCachedJson } from "./cache.ts";
import { lookupErrorFromStatus, retryAfterMs, TIMEOUT_MS } from "./errors.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SHORT_TTL_MS = 300_000;
const TOP_CHAMPIONS = 3;

/** Account-v1 is served from `europe` for every platform; Riot routes the account by itself. */
const ACCOUNT_HOST = "https://europe.api.riotgames.com";
const DDRAGON = "https://ddragon.leagueoflegends.com";

const AccountSchema = z.object({ puuid: z.string(), gameName: z.string(), tagLine: z.string() });
const SummonerSchema = z.object({ profileIconId: z.number(), summonerLevel: z.number() });
const EntriesSchema = z.array(
  z.object({
    queueType: z.string(),
    tier: z.string(),
    rank: z.string(),
    leaguePoints: z.number(),
    wins: z.number(),
    losses: z.number(),
  }),
);
const MasterySchema = z.array(
  z.object({ championId: z.number(), championLevel: z.number(), championPoints: z.number() }),
);
// Only the newest version is used, so only that one is cached.
const VersionsSchema = z
  .array(z.string())
  .min(1)
  .transform((versions) => versions.slice(0, 1));
const VERSION = /^\d+(\.\d+)+$/;
const ChampionsSchema = z.object({
  data: z.record(z.string(), z.object({ key: z.string(), name: z.string() })),
});

const QUEUE_TYPES: Record<string, LolQueueEntry["queue"]> = {
  RANKED_SOLO_5x5: "solo",
  RANKED_FLEX_SR: "flex",
};

export interface LolStatsDeps {
  apiKey: string;
  store: Pick<KeyValueStore, "get" | "set">;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
}

export function createLolStats({ apiKey, store, logger, fetch = globalThis.fetch }: LolStatsDeps) {
  const cachedJson = createCachedJson(store, logger);

  /** GET as JSON; Riot's failures become the module's `RiotLookupError`. The key goes to Riot hosts only. */
  async function getJson(url: string): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (new URL(url).hostname.endsWith(".api.riotgames.com")) headers["X-Riot-Token"] = apiKey;
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new RiotLookupError("unavailable");
    }
    if (!response.ok) {
      throw lookupErrorFromStatus(
        response.status,
        retryAfterMs(response.headers.get("Retry-After")),
      );
    }
    try {
      return await response.json();
    } catch {
      throw new RiotLookupError("unavailable");
    }
  }

  /** Cached, validated GET against the Riot API. A schema mismatch means Riot changed shape: unavailable. */
  function riot<T>(key: string, url: string, ttlMs: number, schema: z.ZodType<T>): Promise<T> {
    return cachedJson(
      `riot:lol:${key}`,
      ttlMs,
      (value) => {
        const parsed = schema.safeParse(value);
        if (!parsed.success) throw new RiotLookupError("unavailable");
        return parsed.data;
      },
      () => getJson(url),
    );
  }

  /** Data Dragon is public and unauthenticated; the names are a nicety, so a failure falls back to ids. */
  async function championNames(): Promise<{ names: Map<number, string>; version: string } | null> {
    try {
      const [version] = await cachedJson(
        "riot:lol:ddragon:versions",
        DAY_MS,
        (value) => VersionsSchema.parse(value),
        () => getJson(`${DDRAGON}/api/versions.json`),
      );
      if (!version || !VERSION.test(version)) return null;
      const champions = await cachedJson(
        `riot:lol:ddragon:champions:${version}`,
        DAY_MS,
        (value) => ChampionsSchema.parse(value),
        () => getJson(`${DDRAGON}/cdn/${version}/data/pl_PL/champion.json`),
      );
      const names = new Map(
        Object.values(champions.data).map((champion) => [Number(champion.key), champion.name]),
      );
      return { names, version };
    } catch (error) {
      logger.warn("Data Dragon lookup failed", { error });
      return null;
    }
  }

  return {
    async lol(id: RiotId, platform: LolPlatform): Promise<LolProfile> {
      const host = `https://${platform}.api.riotgames.com`;
      // Riot ignores case, so one spelling per player keeps the cache keys together.
      const gameName = id.gameName.toLowerCase();
      const tagLine = id.tagLine.toLowerCase();
      const account = await riot(
        `account:${gameName}#${tagLine}`,
        `${ACCOUNT_HOST}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
        HOUR_MS,
        AccountSchema,
      );
      const puuid = encodeURIComponent(account.puuid);
      // The summoner goes first on its own: a 429 or 403 here stops the other requests from being sent.
      // A 404 here means the account exists but has no League profile on this platform, not "no such player".
      const summoner = await riot(
        `summoner:${platform}:${account.puuid}`,
        `${host}/lol/summoner/v4/summoners/by-puuid/${puuid}`,
        SHORT_TTL_MS,
        SummonerSchema,
      ).catch((error: unknown) => {
        if (error instanceof RiotLookupError && error.kind === "not-found") {
          throw new RiotLookupError("no-region-profile");
        }
        throw error;
      });
      const [entries, mastery, ddragon] = await Promise.all([
        riot(
          `entries:${platform}:${account.puuid}`,
          `${host}/lol/league/v4/entries/by-puuid/${puuid}`,
          SHORT_TTL_MS,
          EntriesSchema,
        ),
        riot(
          `mastery:${platform}:${account.puuid}`,
          `${host}/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=${TOP_CHAMPIONS}`,
          SHORT_TTL_MS,
          MasterySchema,
        ),
        championNames(),
      ]);

      const queues = entries.flatMap((entry) => {
        const queue = QUEUE_TYPES[entry.queueType];
        return queue
          ? [
              {
                queue,
                tier: entry.tier,
                rank: entry.rank,
                lp: entry.leaguePoints,
                wins: entry.wins,
                losses: entry.losses,
              },
            ]
          : [];
      });
      return {
        riotId: { gameName: account.gameName, tagLine: account.tagLine },
        platform,
        level: summoner.summonerLevel,
        iconUrl: ddragon
          ? `${DDRAGON}/cdn/${ddragon.version}/img/profileicon/${summoner.profileIconId}.png`
          : "",
        queues,
        topChampions: mastery.slice(0, TOP_CHAMPIONS).map((champion) => ({
          name: ddragon?.names.get(champion.championId) ?? `#${champion.championId}`,
          level: champion.championLevel,
          points: champion.championPoints,
        })),
      };
    },
  };
}
