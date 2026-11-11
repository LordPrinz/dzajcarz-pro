import { describe, expect, test } from "bun:test";
import {
  type AnyCommand,
  type Embed,
  executeCommand,
  type Reply,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext } from "@dzajcarz/core/testing";
import {
  createMemoryStore,
  createStalledStore,
  createTimedStore,
  type KeyValueStore,
} from "@dzajcarz/kv";
import { createRiotModule } from "./index.ts";
import {
  type LolPlatform,
  type LolProfile,
  type RiotFailureKind,
  type RiotId,
  RiotLookupError,
  type RiotStats,
  type ValorantProfile,
} from "./ports.ts";

const VALORANT: ValorantProfile = {
  riotId: { gameName: "Dzajcarz", tagLine: "EUNE" },
  region: "eu",
  rank: "Platyna 2",
  matches: [
    {
      won: true,
      score: "13:7",
      map: "Ascent",
      agent: "Jett",
      kills: 21,
      deaths: 12,
      assists: 5,
      startedAt: new Date("2026-11-01T12:00:00Z"),
      queue: "competitive",
    },
    {
      won: null,
      score: null,
      map: "Piazza",
      agent: "Sage",
      kills: 30,
      deaths: 10,
      assists: 0,
      startedAt: new Date("2026-11-01T11:00:00Z"),
      queue: "deathmatch",
    },
  ],
};

const LOL: LolProfile = {
  riotId: { gameName: "Dzajcarz", tagLine: "EUNE" },
  platform: "eun1",
  level: 312,
  iconUrl: "https://ddragon.test/cdn/1.0/img/profileicon/1.png",
  queues: [{ queue: "solo", tier: "GOLD", rank: "IV", lp: 37, wins: 20, losses: 18 }],
  topChampions: [{ name: "Ahri", level: 7, points: 123456 }],
};

interface FakeStats extends RiotStats {
  calls: { game: "valorant" | "lol"; id: RiotId; platform?: LolPlatform }[];
  failWith?: RiotLookupError;
}

function fakeStats(): FakeStats {
  const stats: FakeStats = {
    calls: [],
    async valorant(id) {
      stats.calls.push({ game: "valorant", id });
      if (stats.failWith) throw stats.failWith;
      return VALORANT;
    },
    async lol(id, platform) {
      stats.calls.push({ game: "lol", id, platform });
      if (stats.failWith) throw stats.failWith;
      return LOL;
    },
  };
  return stats;
}

function setup({
  stats = fakeStats() as Partial<RiotStats>,
  store: given,
}: {
  stats?: Partial<RiotStats>;
  store?: KeyValueStore;
} = {}) {
  let time = 1_000_000;
  const store = given ?? createMemoryStore(() => time);
  const module = createRiotModule({ stats, store, now: () => time, logger: silentLogger });
  const command = (name: string): AnyCommand => {
    const found = module.commands?.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no command ${name}`);
    return found;
  };
  async function run(
    name: string,
    args: Record<string, unknown>,
    options: { userId?: string; guildId?: string | null } = {},
  ) {
    const ctx = createFakeContext({ args, ...options });
    await executeCommand(command(name), ctx, silentLogger);
    return ctx;
  }
  return {
    run,
    store,
    stats,
    advance: (ms: number) => {
      time += ms;
    },
    module,
  };
}

const textOf = (reply: Reply | undefined) =>
  typeof reply === "string" ? reply : (reply?.content ?? "");
const embedOf = (reply: Reply | undefined): Embed | undefined =>
  typeof reply === "string" ? undefined : reply?.embeds?.[0];

describe("riot module", () => {
  test("without any API key both commands say stats are off", async () => {
    const { run } = setup({ stats: {} });
    for (const [name, args, game] of [
      ["valorant", { riot_id: "Dzajcarz#EUNE" }, "Valorant"],
      ["lol", { riot_id: "Dzajcarz#EUNE" }, "League of Legends"],
    ] as const) {
      const ctx = await run(name, args);
      expect(textOf(ctx.replies[0])).toBe(
        `Statystyki ${game} są wyłączone: bot nie ma klucza API.`,
      );
    }
  });

  test("a game without its key is off while the other one keeps working", async () => {
    const full = fakeStats();
    const onlyLol = setup({ stats: { lol: full.lol } });
    const valorantOff = await onlyLol.run("valorant", { riot_id: "Dzajcarz#EUNE" });
    expect(textOf(valorantOff.replies[0])).toBe(
      "Statystyki Valorant są wyłączone: bot nie ma klucza API.",
    );
    const lolOn = await onlyLol.run("lol", { riot_id: "Dzajcarz#EUNE" });
    expect(embedOf(lolOn.replies.at(-1))?.title).toBe("Dzajcarz#EUNE");

    const onlyValorant = setup({ stats: { valorant: full.valorant } });
    const lolOff = await onlyValorant.run("lol", { riot_id: "Dzajcarz#EUNE" });
    expect(textOf(lolOff.replies[0])).toBe(
      "Statystyki League of Legends są wyłączone: bot nie ma klucza API.",
    );
    const valorantOn = await onlyValorant.run("valorant", { riot_id: "Dzajcarz#EUNE" });
    expect(embedOf(valorantOn.replies.at(-1))?.title).toBe("Dzajcarz#EUNE");
  });

  test("a malformed Riot ID is refused before any lookup", async () => {
    const { run, stats } = setup();
    const ctx = await run("valorant", { riot_id: "bez-tagu" });
    expect(textOf(ctx.replies[0])).toBe("Podaj Riot ID jako `Nazwa#TAG`.");
    expect((stats as FakeStats).calls).toEqual([]);
    expect(ctx.deferred).toBe(false);
  });

  test("/valorant replies with a public embed of the profile", async () => {
    const { run, stats } = setup();
    const ctx = await run("valorant", { riot_id: "Dzajcarz#EUNE" });
    expect(ctx.deferred).toBe(true);
    expect((stats as FakeStats).calls[0]).toEqual({
      game: "valorant",
      id: { gameName: "Dzajcarz", tagLine: "EUNE" },
    });
    const embed = embedOf(ctx.replies[0]);
    expect(embed?.title).toBe("Dzajcarz#EUNE");
    expect(embed?.fields?.map((field) => field.value)).toContain("Platyna 2");
    const matches = embed?.fields?.at(-1)?.value ?? "";
    expect(matches).toContain("Wygrana 13:7 · Ascent · Jett · 21/12/5");
    expect(matches).toContain("Mecz · Piazza · Sage · 30/10/0");
    expect((ctx.replies[0] as { ephemeral?: boolean }).ephemeral).toBeUndefined();
  });

  test("/valorant without recent matches says so", async () => {
    const stats = fakeStats();
    stats.valorant = async () => ({ ...VALORANT, rank: null, matches: [] });
    const { run } = setup({ stats });
    const embed = embedOf((await run("valorant", { riot_id: "Dzajcarz#EUNE" })).replies[0]);
    expect(embed?.fields?.at(-1)?.value).toBe("Brak ostatnich meczów.");
    expect(embed?.fields?.map((field) => field.value)).toContain("Bez rangi");
  });

  test("/lol defaults to eune and shows queues and champions", async () => {
    const { run, stats } = setup();
    const ctx = await run("lol", { riot_id: "Dzajcarz#EUNE" });
    expect((stats as FakeStats).calls[0]?.platform).toBe("eun1");
    const embed = embedOf(ctx.replies[0]);
    expect(embed?.thumbnail).toBe(LOL.iconUrl);
    const values = embed?.fields?.map((field) => field.value) ?? [];
    expect(values).toContain("Gold IV, 37 LP (20W/18L)");
    expect(values).toContain("Bez rangi");
    expect(values.at(-1)).toContain("Ahri");
    expect(values.at(-1)).toContain(new Intl.NumberFormat("pl-PL").format(123456));
  });

  test("/lol passes the chosen platform", async () => {
    const { run, stats } = setup();
    await run("lol", { riot_id: "Dzajcarz#EUNE", region: "euw1" });
    expect((stats as FakeStats).calls[0]?.platform).toBe("euw1");
  });

  test("/lol rejects an unknown platform", async () => {
    const { run } = setup();
    const ctx = await run("lol", { riot_id: "Dzajcarz#EUNE", region: "mars" });
    expect(textOf(ctx.replies[0])).toBe("Nieznany serwer gry.");
  });

  test("works in a direct message", async () => {
    const { run } = setup();
    const ctx = await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { guildId: null });
    expect(embedOf(ctx.replies[0])?.title).toBe("Dzajcarz#EUNE");
  });

  test("markdown in Riot names does not format the embed", async () => {
    const stats = fakeStats();
    stats.valorant = async () => ({
      ...VALORANT,
      riotId: { gameName: "**bold**_x", tagLine: "EUNE" },
    });
    const { run } = setup({ stats });
    const embed = embedOf((await run("valorant", { riot_id: "abc#EUNE" })).replies[0]);
    expect(embed?.title).toBe("\\*\\*bold\\*\\*\\_x#EUNE");
  });

  const failures: [RiotFailureKind, string][] = [
    ["not-found", "Nie znalazłem gracza **Dzajcarz#EUNE**."],
    [
      "forbidden",
      "Klucz Riot API nie ma dostępu do tych danych (klucz deweloperski nie czyta historii meczów Valorant).",
    ],
    ["unavailable", "Riot API nie odpowiada. Spróbuj za chwilę."],
  ];
  test.each(failures)("%s becomes a Polish error", async (kind, message) => {
    const stats = fakeStats();
    stats.failWith = new RiotLookupError(kind);
    const { run } = setup({ stats });
    const ctx = await run("valorant", { riot_id: "Dzajcarz#EUNE" });
    expect(textOf(ctx.replies[0])).toBe(message);
    expect((ctx.replies[0] as { ephemeral?: boolean }).ephemeral).toBe(true);
  });

  test("a missing League profile names the chosen region", async () => {
    const stats = fakeStats();
    stats.failWith = new RiotLookupError("no-region-profile");
    const { run } = setup({ stats });
    const defaultRegion = await run("lol", { riot_id: "Dzajcarz#EUNE" });
    expect(textOf(defaultRegion.replies[0])).toBe(
      "Gracz **Dzajcarz#EUNE** nie ma konta League of Legends na serwerze EUNE. Spróbuj z innym regionem.",
    );
    const na = await setup({ stats }).run("lol", { riot_id: "Dzajcarz#EUNE", region: "na1" });
    expect(textOf(na.replies[0])).toContain("na serwerze NA.");
  });

  test("forbidden reads differently for /lol", async () => {
    const stats = fakeStats();
    stats.failWith = new RiotLookupError("forbidden");
    const { run } = setup({ stats });
    const ctx = await run("lol", { riot_id: "Dzajcarz#EUNE" });
    expect(textOf(ctx.replies[0])).toBe("Klucz Riot API wygasł albo nie ma dostępu.");
  });

  test("markdown in a champion name is escaped", async () => {
    const stats = fakeStats();
    stats.lol = async () => ({
      ...LOL,
      topChampions: [{ name: "*Ahri*_", level: 1, points: 1 }],
    });
    const { run } = setup({ stats });
    const embed = embedOf((await run("lol", { riot_id: "Dzajcarz#EUNE" })).replies[0]);
    expect(embed?.fields?.at(-1)?.value).toContain("**\\*Ahri\\*\\_**");
  });

  const firstMatch = VALORANT.matches[0] as ValorantProfile["matches"][number];
  const lines = async (queues: string[]) => {
    const stats = fakeStats();
    stats.valorant = async () => ({
      ...VALORANT,
      matches: queues.map((queue) => ({ ...firstMatch, queue })),
    });
    const { run } = setup({ stats });
    const embed = embedOf((await run("valorant", { riot_id: "Dzajcarz#EUNE" })).replies[0]);
    return (embed?.fields?.at(-1)?.value ?? "").split("\n");
  };

  test("a queue is labelled in Polish, an unknown one keeps its id, an empty one is omitted", async () => {
    const [ranked, unknown, empty] = await lines(["competitive", "newmap", ""]);
    expect(ranked).toContain("· Rankingowa ·");
    expect(unknown).toContain("· newmap ·");
    expect(empty).not.toContain("· ·");
    expect(empty).toMatch(/21\/12\/5 · <t:\d+:R>$/);
  });

  test("the match list is cut by whole lines", async () => {
    const stats = fakeStats();
    stats.valorant = async () => ({
      ...VALORANT,
      matches: Array.from({ length: 5 }, () => ({ ...firstMatch, map: "M".repeat(250) })),
    });
    const { run } = setup({ stats });
    const embed = embedOf((await run("valorant", { riot_id: "Dzajcarz#EUNE" })).replies[0]);
    const value = embed?.fields?.at(-1)?.value ?? "";
    expect(value.length).toBeLessThanOrEqual(1024);
    expect(value.split("\n").every((line) => line.endsWith(":R>"))).toBe(true);
  });

  describe("shared state", () => {
    test("a Redis failure does not hide the 429 message or fail the command", async () => {
      const stats = fakeStats();
      stats.failWith = new RiotLookupError("rate-limited", 7000);
      const { run, store } = setup({ stats });
      const down = async () => {
        throw new Error("redis down");
      };
      store.get = down;
      store.set = down;
      store.setIfAbsent = down;
      store.increment = down;
      const ctx = await run("valorant", { riot_id: "Dzajcarz#EUNE" });
      expect(textOf(ctx.replies[0])).toBe("Riot API prosi o przerwę. Spróbuj za 7 s.");
    });

    test("a zero Retry-After still pauses for a second", async () => {
      const stats = fakeStats();
      stats.failWith = new RiotLookupError("rate-limited", 0);
      const { run, store } = setup({ stats });
      const ctx = await run("valorant", { riot_id: "Dzajcarz#EUNE" });
      expect(textOf(ctx.replies[0])).toBe("Riot API prosi o przerwę. Spróbuj za 1 s.");
      expect(await store.get("riot:retry-after:valorant")).toBe(String(1_000_000 + 1000));
    });

    test("a huge Retry-After is capped at two minutes", async () => {
      const stats = fakeStats();
      stats.failWith = new RiotLookupError("rate-limited", Number.MAX_SAFE_INTEGER);
      const { run } = setup({ stats });
      const ctx = await run("valorant", { riot_id: "Dzajcarz#EUNE" });
      expect(textOf(ctx.replies[0])).toBe("Riot API prosi o przerwę. Spróbuj za 120 s.");
    });

    test("thirty lookups a minute are allowed for everyone together, the next waits", async () => {
      const { run, advance, stats } = setup();
      for (let user = 1; user <= 30; user++) {
        const ctx = await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { userId: String(user) });
        expect(embedOf(ctx.replies[0])?.title).toBe("Dzajcarz#EUNE");
      }
      const over = await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { userId: "31" });
      expect(textOf(over.replies[0])).toBe(
        "Za dużo zapytań do Riot w ostatniej minucie. Spróbuj za chwilę.",
      );
      expect((stats as FakeStats).calls).toHaveLength(30);

      advance(60_001);
      const later = await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { userId: "32" });
      expect(embedOf(later.replies[0])?.title).toBe("Dzajcarz#EUNE");
    });
  });

  describe("rate limit", () => {
    test("a 429 stores the deadline and blocks the next lookup without calling Riot", async () => {
      const stats = fakeStats();
      stats.failWith = new RiotLookupError("rate-limited", 7000);
      const { run, store, advance } = setup({ stats });

      const first = await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { userId: "1" });
      expect(textOf(first.replies[0])).toBe("Riot API prosi o przerwę. Spróbuj za 7 s.");
      expect(await store.get("riot:retry-after:valorant")).toBe(String(1_000_000 + 7000));

      advance(3000);
      const second = await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { userId: "2" });
      expect(textOf(second.replies[0])).toBe("Riot API prosi o przerwę. Spróbuj za 4 s.");
      expect(stats.calls).toHaveLength(1);
    });

    test("a pause on one game's key leaves the other game running", async () => {
      const stats = fakeStats();
      stats.failWith = new RiotLookupError("rate-limited", 7000);
      const { run } = setup({ stats });
      await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { userId: "1" });

      stats.failWith = undefined;
      const lol = await run("lol", { riot_id: "Dzajcarz#EUNE" }, { userId: "2" });
      expect(embedOf(lol.replies[0])?.title).toBe("Dzajcarz#EUNE");
    });

    test("lookups resume once the deadline has passed", async () => {
      const stats = fakeStats();
      stats.failWith = new RiotLookupError("rate-limited", 7000);
      const { run, advance } = setup({ stats });
      await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { userId: "1" });

      advance(7001);
      stats.failWith = undefined;
      const ctx = await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { userId: "2" });
      expect(embedOf(ctx.replies[0])?.title).toBe("Dzajcarz#EUNE");
    });

    test("a 429 without Retry-After waits ten seconds", async () => {
      const stats = fakeStats();
      stats.failWith = new RiotLookupError("rate-limited");
      const { run } = setup({ stats });
      const ctx = await run("valorant", { riot_id: "Dzajcarz#EUNE" });
      expect(textOf(ctx.replies[0])).toBe("Riot API prosi o przerwę. Spróbuj za 10 s.");
    });
  });

  test("a user waits ten seconds between lookups, other users do not", async () => {
    const { run, advance } = setup();
    await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { userId: "1" });

    const again = await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { userId: "1" });
    expect(textOf(again.replies[0])).toBe("Poczekaj chwilę przed kolejnym sprawdzeniem.");

    const other = await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { userId: "2" });
    expect(embedOf(other.replies[0])?.title).toBe("Dzajcarz#EUNE");

    advance(10_001);
    const later = await run("valorant", { riot_id: "Dzajcarz#EUNE" }, { userId: "1" });
    expect(embedOf(later.replies[0])?.title).toBe("Dzajcarz#EUNE");
  });

  test("both commands are available everywhere", () => {
    const { module } = setup();
    for (const command of module.commands ?? []) {
      expect(command.contexts?.places).toEqual(["guild", "bot-dm", "private-channel"]);
      expect(command.contexts?.installs).toEqual(["guild", "user"]);
    }
  });

  test("a store that never answers does not hold a lookup past the limit", async () => {
    const t = setup({ store: createTimedStore(createStalledStore(), 20) });
    const started = performance.now();
    const ctx = await t.run("valorant", { riot_id: "Dzajcarz#EUNE" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(ctx.replies).toHaveLength(1);
  });
});
