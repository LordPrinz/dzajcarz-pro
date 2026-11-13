export type RiotFailureKind =
  | "not-found"
  /** The Riot account exists, but the player has no League account on the chosen platform. */
  | "no-region-profile"
  | "forbidden"
  | "rate-limited"
  | "unavailable";

/** What the adapters throw; the module turns it into a Polish `UserError`. */
export class RiotLookupError extends Error {
  override readonly name = "RiotLookupError";

  constructor(
    readonly kind: RiotFailureKind,
    /** Rate limit only: how long Riot asked us to wait. */
    readonly retryAfterMs?: number,
  ) {
    super(`Riot lookup failed: ${kind}`);
  }
}

export interface RiotId {
  gameName: string;
  tagLine: string;
}

export interface ValorantMatch {
  /** null when the mode has no two-team result (deathmatch). */
  won: boolean | null;
  /** `13:7`; null when the mode has no two-team result. */
  score: string | null;
  /** null when Riot sent neither a content name nor an id to show. */
  map: string | null;
  agent: string | null;
  kills: number;
  deaths: number;
  assists: number;
  startedAt: Date;
  queue: string;
}

export interface ValorantProfile {
  riotId: RiotId;
  region: string;
  /** Tier name of the newest competitive match among the listed ones, or null. */
  rank: string | null;
  matches: ValorantMatch[];
}

export interface LolQueueEntry {
  queue: "solo" | "flex";
  /** Riot's upper-case tier, e.g. `GOLD`. */
  tier: string;
  /** Division, e.g. `IV`. */
  rank: string;
  lp: number;
  wins: number;
  losses: number;
}

export interface LolProfile {
  riotId: RiotId;
  platform: string;
  level: number;
  iconUrl: string;
  queues: LolQueueEntry[];
  topChampions: { name: string; level: number; points: number }[];
}

/** Platform routing values of the League API. */
export const LOL_PLATFORMS = ["eun1", "euw1", "na1", "kr", "br1", "jp1", "tr1", "oc1"] as const;
export type LolPlatform = (typeof LOL_PLATFORMS)[number];

export interface RiotStats {
  valorant(id: RiotId): Promise<ValorantProfile>;
  lol(id: RiotId, platform: LolPlatform): Promise<LolProfile>;
}

/** The longest pause the module honours, whatever Riot asks for. */
export const MAX_RETRY_AFTER_MS = 120_000;
