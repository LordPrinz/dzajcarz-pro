import type { Logger } from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import {
  type RiotId,
  RiotLookupError,
  type ValorantMatch,
  type ValorantProfile,
} from "@dzajcarz/module-riot";
import {
  PLATFORM_ROUTES,
  RequestCancelledError,
  RequestTimeoutError,
  RiotApiError,
  type TransportAdapter,
  TransportError,
  ValorantApi,
} from "wrapper-valorant-api";
import { z } from "zod";
import { createCachedJson } from "./cache.ts";
import { lookupErrorFromStatus, TIMEOUT_MS } from "./errors.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MATCHLIST_TTL_MS = 300_000;
/** How many of the newest matches the embed lists. */
const MATCH_COUNT = 5;

/** Account-v1 is served from `europe` for every Valorant shard; Riot routes the account by itself. */
const ACCOUNT_REGION = "europe";

// Competitive tiers 0-2 are unrated or unused; 3 is Iron 1 and 27 is Radiant.
const TIER_FAMILIES = [
  "Iron",
  "Bronze",
  "Silver",
  "Gold",
  "Platinum",
  "Diamond",
  "Ascendant",
  "Immortal",
] as const;

export function tierName(tier: number): string | null {
  if (tier < 3 || tier > 27) return null;
  if (tier === 27) return "Radiant";
  const index = tier - 3;
  return `${TIER_FAMILIES[Math.floor(index / 3)]} ${(index % 3) + 1}`;
}

// Wire data is untrusted: each schema keeps only the fields in use.
const AccountSchema = z.object({ puuid: z.string(), gameName: z.string(), tagLine: z.string() });
const ShardSchema = z.object({ activeShard: z.enum(PLATFORM_ROUTES) });
const MatchlistSchema = z
  .object({
    history: z.array(
      z.object({ matchId: z.string(), gameStartTimeMillis: z.number(), queueId: z.string() }),
    ),
  })
  // Only the newest few are used, so only those are cached.
  .transform(({ history }) => ({
    history: [...history]
      .sort((a, b) => b.gameStartTimeMillis - a.gameStartTimeMillis)
      .slice(0, MATCH_COUNT),
  }));
const MatchSchema = z.object({
  matchInfo: z.object({
    mapId: z.string(),
    gameStartMillis: z.number(),
    queueId: z.string().optional(),
  }),
  players: z.array(
    z.object({
      puuid: z.string(),
      teamId: z.string(),
      characterId: z.string().optional(),
      competitiveTier: z.number().default(0),
      stats: z.object({ kills: z.number(), deaths: z.number(), assists: z.number() }),
    }),
  ),
  teams: z
    .array(z.object({ teamId: z.string(), won: z.boolean(), roundsWon: z.number() }))
    .default([]),
});
type Match = z.infer<typeof MatchSchema>;

const NamedSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    assetName: z.string().optional(),
    assetPath: z.string().optional(),
    localizedNames: z.record(z.string(), z.string()).optional(),
  })
  // The Polish name replaces the English one, so the cached copy needs no translations.
  .transform(({ localizedNames, name, ...rest }) => ({
    ...rest,
    name: localizedNames?.["pl-PL"] ?? name,
  }));
const ContentSchema = z.object({ characters: z.array(NamedSchema), maps: z.array(NamedSchema) });
type Content = z.infer<typeof ContentSchema>;

const lastSegment = (path: string) => path.split("/").filter(Boolean).at(-1);

function mapName(content: Content, mapId: string): string | null {
  const wanted = lastSegment(mapId);
  const named = content.maps.find(
    (map) =>
      wanted !== undefined &&
      ((map.assetPath !== undefined && lastSegment(map.assetPath) === wanted) ||
        map.assetName === wanted),
  );
  return named?.name ?? wanted ?? null;
}

function agentName(content: Content, characterId: string | undefined): string | null {
  const agent = content.characters.find(
    (character) => character.id.toLowerCase() === characterId?.toLowerCase(),
  );
  return agent ? agent.name : null;
}

function toMatch(match: Match, puuid: string, content: Content, fallbackQueue: string) {
  const player = match.players.find((candidate) => candidate.puuid === puuid);
  if (!player) return null;
  const own = match.teams.find((team) => team.teamId === player.teamId);
  const others = match.teams.filter((team) => team.teamId !== player.teamId);
  // Two teams make a score; a deathmatch lists one team per player and has none.
  const opponent = match.teams.length === 2 && own ? others[0] : undefined;
  const queue = match.matchInfo.queueId ?? fallbackQueue;
  const result: ValorantMatch = {
    won: opponent && own ? own.won : null,
    score: opponent && own ? `${own.roundsWon}:${opponent.roundsWon}` : null,
    map: mapName(content, match.matchInfo.mapId),
    agent: agentName(content, player.characterId),
    kills: player.stats.kills,
    deaths: player.stats.deaths,
    assists: player.stats.assists,
    startedAt: new Date(match.matchInfo.gameStartMillis),
    queue,
  };
  return { result, tier: queue === "competitive" ? player.competitiveTier : 0 };
}

/** Wrapper and decode failures as the module understands them; anything unexpected is left alone. */
function toLookupError(error: unknown): unknown {
  if (error instanceof RiotLookupError) return error;
  if (error instanceof RiotApiError) return lookupErrorFromStatus(error.status, error.retryAfterMs);
  if (
    error instanceof RequestTimeoutError ||
    error instanceof TransportError ||
    error instanceof RequestCancelledError ||
    error instanceof z.ZodError
  ) {
    return new RiotLookupError("unavailable");
  }
  return error;
}

export interface ValorantStatsDeps {
  apiKey: string;
  store: Pick<KeyValueStore, "get" | "set">;
  logger: Logger;
  /** Replaces the wrapper's fetch transport; tests use it. */
  transport?: TransportAdapter;
}

export function createValorantStats({ apiKey, store, logger, transport }: ValorantStatsDeps) {
  // No wrapper cache: it would store whole responses (a match is tens of kilobytes). The projections
  // below are cached instead.
  const api = new ValorantApi({
    apiKey,
    defaultPlatform: "eu",
    timeoutMs: TIMEOUT_MS,
    transport,
  });
  const cachedJson = createCachedJson(store, logger);
  const raw = (value: unknown) => value;

  async function profile(riotId: RiotId): Promise<ValorantProfile> {
    // Riot ignores case, so one spelling per player keeps the cache keys together.
    const gameName = riotId.gameName.toLowerCase();
    const tagLine = riotId.tagLine.toLowerCase();
    const account = await cachedJson(
      `riot:val:account:${gameName}#${tagLine}`,
      HOUR_MS,
      AccountSchema.parse,
      () => api.account.getByRiotId(gameName, tagLine, { region: ACCOUNT_REGION, decode: raw }),
    );
    const { activeShard: platform } = await cachedJson(
      `riot:val:shard:${account.puuid}`,
      HOUR_MS,
      ShardSchema.parse,
      () =>
        api.account.getActiveShard(account.puuid, "val", { region: ACCOUNT_REGION, decode: raw }),
    );

    const history = await cachedJson(
      `riot:val:matchlist:${platform}:${account.puuid}`,
      MATCHLIST_TTL_MS,
      MatchlistSchema.parse,
      () => api.match.getMatchlist(account.puuid, { platform, decode: raw }),
    ).catch((error: unknown) =>
      // Riot answers 404 for a player without any Valorant match.
      error instanceof RiotApiError && error.status === 404
        ? { history: [] }
        : Promise.reject(error),
    );
    const newest = history.history;

    const shown = { gameName: account.gameName, tagLine: account.tagLine };
    if (newest.length === 0) return { riotId: shown, region: platform, rank: null, matches: [] };

    const [matches, content] = await Promise.all([
      Promise.all(
        newest.map((entry) =>
          cachedJson(`riot:val:match:${platform}:${entry.matchId}`, DAY_MS, MatchSchema.parse, () =>
            api.match.getMatch(entry.matchId, { platform, decode: raw }),
          ).catch((error: unknown) => {
            // One bad match must not fail the whole profile; only a rate limit stops it.
            const mapped = toLookupError(error);
            if (mapped instanceof RiotLookupError && mapped.kind === "rate-limited") throw mapped;
            logger.warn("Valorant match skipped", { error: mapped });
            return null;
          }),
        ),
      ),
      // Names are a nicety: any failure except a rate limit falls back to the ids.
      cachedJson(`riot:val:content:${platform}`, DAY_MS, ContentSchema.parse, () =>
        api.content.getContents({ platform, locale: "pl-PL", decode: raw }),
      ).catch((error: unknown) => {
        const mapped = toLookupError(error);
        if (mapped instanceof RiotLookupError && mapped.kind === "rate-limited") throw mapped;
        logger.warn("Valorant content lookup failed", { error: mapped });
        return { characters: [], maps: [] } satisfies Content;
      }),
    ]);

    const listed = matches.flatMap((match, index) => {
      const entry = newest[index];
      const mapped = match && entry ? toMatch(match, account.puuid, content, entry.queueId) : null;
      return mapped ? [mapped] : [];
    });
    const rankedTier = listed.find((item) => item.tier > 0)?.tier ?? 0;
    return {
      riotId: shown,
      region: platform,
      rank: tierName(rankedTier),
      matches: listed.map((item) => item.result),
    };
  }

  return {
    async valorant(id: RiotId): Promise<ValorantProfile> {
      try {
        return await profile(id);
      } catch (error) {
        throw toLookupError(error);
      }
    },
  };
}
