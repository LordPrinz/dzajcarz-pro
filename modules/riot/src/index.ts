import {
  type BotModule,
  type CommandContext,
  type CommandContexts,
  defineCommand,
  type Embed,
  type Logger,
  UserError,
} from "@dzajcarz/core";
import type { KeyValueStore } from "@dzajcarz/kv";
import { escapeMarkdown, lolEmbed, valorantEmbed } from "./format.ts";
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
  store: Pick<KeyValueStore, "get" | "set" | "setIfAbsent" | "increment">;
  now: () => number;
  logger: Logger;
}

/** Everywhere: servers, a DM with the bot and other private channels, for both install types. */
const EVERYWHERE: CommandContexts = {
  places: ["guild", "bot-dm", "private-channel"],
  installs: ["guild", "user"],
};

/** Shared by every lookup: while it is set, Riot asked us to stop. The value is the deadline in ms. */
const RETRY_AFTER_KEY = "riot:retry-after";
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

const pauseMessage = (seconds: number) => `Riot API prosi o przerwę. Spróbuj za ${seconds} s.`;
const secondsUntil = (deadline: number, now: number) =>
  Math.max(1, Math.ceil((deadline - now) / 1000));

type Game = "valorant" | "lol";
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

  /** Runs one lookup behind the shared checks; every refusal and failure becomes a Polish UserError. */
  async function lookup(
    ctx: CommandContext,
    game: Game,
    input: string,
    fetchEmbed: ((id: RiotId) => Promise<Embed>) | undefined,
  ): Promise<void> {
    if (!fetchEmbed) {
      throw new UserError(`Statystyki ${GAME_NAMES[game]} są wyłączone: bot nie ma klucza API.`);
    }
    const id = parseRiotId(input);

    const deadline = Number(await guarded("pause read", null, () => store.get(RETRY_AFTER_KEY)));
    if (deadline > now()) throw new UserError(pauseMessage(secondsUntil(deadline, now())));
    const free = await guarded("cooldown", true, () =>
      store.setIfAbsent(`riot:user:${ctx.user.id}`, "1", USER_COOLDOWN_MS),
    );
    if (!free) throw new UserError("Poczekaj chwilę przed kolejnym sprawdzeniem.");
    const budget = await guarded("budget", null, () =>
      store.increment(GLOBAL_KEY, GLOBAL_WINDOW_MS),
    );
    if (budget !== null && budget.count > GLOBAL_MAX_LOOKUPS) {
      throw new UserError("Za dużo zapytań do Riot w ostatniej minucie. Spróbuj za chwilę.");
    }

    await ctx.defer();
    try {
      await ctx.reply({ embeds: [await fetchEmbed(id)] });
    } catch (error) {
      if (error instanceof RiotLookupError) throw await toUserError(error, game, id);
      throw error;
    }
  }

  async function toUserError(error: RiotLookupError, game: Game, id: RiotId): Promise<UserError> {
    switch (error.kind) {
      case "not-found":
        return new UserError(
          `Nie znalazłem gracza **${escapeMarkdown(id.gameName)}#${escapeMarkdown(id.tagLine)}**.`,
        );
      case "forbidden":
        return new UserError(
          game === "valorant"
            ? "Klucz Riot API nie ma dostępu do tych danych (klucz deweloperski nie czyta historii meczów Valorant)."
            : "Klucz Riot API wygasł albo nie ma dostępu.",
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
          store.set(RETRY_AFTER_KEY, String(now() + waitMs), waitMs),
        );
        return new UserError(pauseMessage(secondsUntil(now() + waitMs, now())));
      }
      case "unavailable":
        return new UserError("Riot API nie odpowiada. Spróbuj za chwilę.");
    }
  }

  const valorant = defineCommand({
    name: "valorant",
    description: "Statystyki gracza Valorant: ranga i ostatnie mecze",
    contexts: EVERYWHERE,
    options: {
      riot_id: {
        type: "string",
        description: "Riot ID, np. Nazwa#TAG",
        required: true,
        rest: true,
      },
    },
    run: (ctx) =>
      lookup(
        ctx,
        "valorant",
        ctx.args.riot_id,
        valorantStats && (async (id) => valorantEmbed(await valorantStats(id))),
      ),
  });

  const lol = defineCommand({
    name: "lol",
    description: "Statystyki gracza League of Legends: rangi i najlepsi bohaterowie",
    contexts: EVERYWHERE,
    options: {
      riot_id: {
        type: "string",
        description:
          'Riot ID, np. Nazwa#TAG (z odstępami w cudzysłowie: !lol "Nazwa ze spacją#TAG" euw)',
        required: true,
      },
      region: {
        type: "string",
        description: "Serwer gry (domyślnie eune)",
        choices: REGIONS,
      },
    },
    run: async (ctx) => {
      const platform = ctx.args.region ?? "eun1";
      if (!isLolPlatform(platform)) throw new UserError("Nieznany serwer gry.");
      await lookup(
        ctx,
        "lol",
        ctx.args.riot_id,
        lolStats && (async (id) => lolEmbed(await lolStats(id, platform))),
      );
    },
  });

  return { name: "riot", commands: [valorant, lol] };
}
