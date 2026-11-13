import {
  type BotModule,
  type CommandContext,
  type CommandContexts,
  defineCommand,
  type Embed,
  type Locale,
  type Logger,
  UserError,
  withTimeout,
} from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import { escapeText, lolEmbed, valorantEmbed } from "./format.ts";
import { t } from "./messages.ts";
import {
  LOL_PLATFORMS,
  type LolPlatform,
  MAX_RETRY_AFTER_MS,
  type RiotId,
  RiotLookupError,
  type RiotStats,
} from "./ports.ts";
import { parseRiotId } from "./riot-id.ts";

export { lolEmbed, valorantEmbed } from "./format.ts";
export * from "./ports.ts";
export { parseRiotId } from "./riot-id.ts";

export interface RiotModuleDeps {
  /** A game without its API key is left out: its command then says that stats are off. */
  stats: Partial<RiotStats>;
  store: Pick<KeyValueStore, "get" | "set" | "setIfAbsent" | "increment" | "delIfEquals">;
  now: () => number;
  logger: Logger;
}

/** Everywhere: servers, a DM with the bot and other private channels, for both install types. */
const EVERYWHERE: CommandContexts = {
  places: ["guild", "bot-dm", "private-channel"],
  installs: ["guild", "user"],
};

type Game = "valorant" | "lol";

/** Riot limits each key on its own: while a game's pause is set, Riot asked us to stop. The value is the deadline in ms. */
const retryAfterKey = (game: Game) => `riot:retry-after:${game}`;
const DEFAULT_RETRY_AFTER_MS = 10_000;
const USER_COOLDOWN_MS = 10_000;
/** All users together: a fixed window that starts with the first lookup. */
const GLOBAL_KEY = "riot:global";
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX_LOOKUPS = 30;

const REGIONS = [
  { name: "eune", value: "eun1" },
  { name: "euw", value: "euw1" },
  { name: "na", value: "na1" },
  { name: "kr", value: "kr" },
  { name: "br", value: "br1" },
  { name: "jp", value: "jp1" },
  { name: "tr", value: "tr1" },
  { name: "oc", value: "oc1" },
] as const satisfies readonly { name: string; value: LolPlatform }[];

const isLolPlatform = (value: string): value is LolPlatform =>
  (LOL_PLATFORMS as readonly string[]).includes(value);

const pauseMessage = (seconds: number) => (l: Locale) => t(l).pause(seconds);
const secondsUntil = (deadline: number, now: number) =>
  Math.max(1, Math.ceil((deadline - now) / 1000));

const GAME_NAMES: Record<Game, string> = { valorant: "Valorant", lol: "League of Legends" };

export function createRiotModule({ stats, store, now, logger }: RiotModuleDeps): BotModule {
  const { valorant: valorantStats, lol: lolStats } = stats;

  /** The shared state is a convenience: when Redis fails the lookup goes ahead and the failure is logged. */
  async function guarded<T>(what: string, fallback: T, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      logger.warn(`Riot ${what} failed`, { error });
      return fallback;
    }
  }

  /** Runs one lookup behind the shared checks; every refusal and failure becomes a UserError. */
  async function lookup(
    ctx: CommandContext,
    game: Game,
    input: string,
    fetchEmbed: ((id: RiotId, locale: Locale) => Promise<Embed>) | undefined,
    /** The region choice's label ("EUNE"), for the failures that name it. */
    region?: string,
  ): Promise<void> {
    if (!fetchEmbed) {
      throw new UserError((l) => t(l).statsOff(GAME_NAMES[game]));
    }
    const id = parseRiotId(input);

    const deadline = Number(
      await guarded("pause read", null, () => store.get(retryAfterKey(game))),
    );
    if (deadline > now()) throw new UserError(pauseMessage(secondsUntil(deadline, now())));
    const cooldownKey = `riot:user:${ctx.user.id}`;
    // A unique value, so only this call's own key is ever released.
    const cooldownToken = crypto.randomUUID();
    let tookCooldown = false;
    const free = await guarded("cooldown", true, async () => {
      tookCooldown = await store.setIfAbsent(cooldownKey, cooldownToken, USER_COOLDOWN_MS);
      return tookCooldown;
    });
    if (!free) throw new UserError((l) => t(l).cooldown);
    const budget = await guarded("budget", null, () =>
      store.increment(GLOBAL_KEY, GLOBAL_WINDOW_MS),
    );
    if (budget !== null && budget.count > GLOBAL_MAX_LOOKUPS) {
      // No lookup happened, so the member should not also wait out the cooldown.
      if (tookCooldown) {
        await guarded("cooldown release", false, () =>
          withTimeout(store.delIfEquals(cooldownKey, cooldownToken)),
        );
      }
      throw new UserError((l) => t(l).tooManyLookups);
    }

    await ctx.defer();
    try {
      await ctx.reply({ embeds: [await fetchEmbed(id, ctx.locale)] });
    } catch (error) {
      if (error instanceof RiotLookupError) throw await toUserError(error, game, id, region);
      throw error;
    }
  }

  async function toUserError(
    error: RiotLookupError,
    game: Game,
    id: RiotId,
    region?: string,
  ): Promise<UserError> {
    const player = `${escapeText(id.gameName)}#${escapeText(id.tagLine)}`;
    switch (error.kind) {
      case "not-found":
        return new UserError((l) => t(l).notFound(player));
      case "no-region-profile":
        return new UserError((l) => t(l).noRegionProfile(player, region));
      case "forbidden":
        return new UserError((l) =>
          game === "valorant" ? t(l).forbiddenValorant : t(l).forbiddenLol,
        );
      case "rate-limited": {
        const asked = error.retryAfterMs;
        const waitMs = Math.min(
          MAX_RETRY_AFTER_MS,
          Math.max(
            1000,
            Math.ceil(
              asked !== undefined && Number.isFinite(asked) ? asked : DEFAULT_RETRY_AFTER_MS,
            ),
          ),
        );
        logger.warn("Riot API rate limit hit", { waitMs });
        await guarded("pause write", undefined, () =>
          store.set(retryAfterKey(game), String(now() + waitMs), waitMs),
        );
        return new UserError(pauseMessage(secondsUntil(now() + waitMs, now())));
      }
      case "unavailable":
        return new UserError((l) => t(l).unavailable);
    }
  }

  const valorant = defineCommand({
    name: "valorant",
    description: t.all("valorantDescription"),
    contexts: EVERYWHERE,
    options: {
      riot_id: {
        type: "string",
        description: t.all("valorantIdOption"),
        required: true,
        rest: true,
      },
    },
    run: (ctx) =>
      lookup(
        ctx,
        "valorant",
        ctx.args.riot_id,
        valorantStats && (async (id, locale) => valorantEmbed(await valorantStats(id), locale)),
      ),
  });

  const lol = defineCommand({
    name: "lol",
    description: t.all("lolDescription"),
    contexts: EVERYWHERE,
    options: {
      riot_id: {
        type: "string",
        description: t.all("lolIdOption"),
        required: true,
      },
      region: {
        type: "string",
        description: t.all("regionOption"),
        choices: REGIONS,
      },
    },
    run: async (ctx) => {
      const platform = ctx.args.region ?? "eun1";
      if (!isLolPlatform(platform)) throw new UserError((l) => t(l).unknownRegion);
      await lookup(
        ctx,
        "lol",
        ctx.args.riot_id,
        lolStats && (async (id, locale) => lolEmbed(await lolStats(id, platform), locale)),
        REGIONS.find((region) => region.value === platform)?.name.toUpperCase(),
      );
    },
  });

  return { name: "riot", commands: [valorant, lol] };
}
