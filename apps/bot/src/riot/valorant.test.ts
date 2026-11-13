import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import { createMemoryStore } from "@dzajcarz/kv";
import { RiotLookupError } from "@dzajcarz/module-riot";
import {
  type HttpRequest,
  type HttpResponse,
  type TransportAdapter,
  TransportError,
} from "wrapper-valorant-api";
import { createValorantStats, tierName } from "./valorant.ts";

const PUUID = "puuid-1";
const AGENT_ID = "ADD6443A-41BD-E414-F6AD-E58D267F4E95";
const MAP_ID = "/Game/Maps/Ascent/Ascent";

const player = (puuid: string, teamId: string, tier = 0) => ({
  puuid,
  teamId,
  characterId: AGENT_ID.toLowerCase(),
  competitiveTier: tier,
  stats: { kills: 21, deaths: 12, assists: 5 },
});

const matchBody = (queueId: string, startedAt: number, won: boolean) => ({
  matchInfo: { mapId: MAP_ID, gameStartMillis: startedAt, queueId },
  players: [player(PUUID, "Blue", 14), player("enemy", "Red", 20)],
  teams: [
    { teamId: "Blue", won, roundsWon: won ? 13 : 7 },
    { teamId: "Red", won: !won, roundsWon: won ? 7 : 13 },
  ],
});

const respond = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  ({ status, statusText: String(status), headers: new Headers(headers), body }) as HttpResponse;

/** Answers by URL path and records every request. */
function fakeTransport(overrides: Record<string, () => HttpResponse> = {}) {
  const requests: HttpRequest[] = [];
  const routes: Record<string, () => HttpResponse> = {
    "/riot/account/v1/accounts/by-riot-id/": () =>
      respond(200, { puuid: PUUID, gameName: "Zażółć", tagLine: "EUNE" }),
    "/riot/account/v1/active-shards/by-game/val/": () => respond(200, { activeShard: "eu" }),
    "/val/match/v1/matchlists/by-puuid/": () =>
      respond(200, {
        puuid: PUUID,
        history: [
          { matchId: "m1", gameStartTimeMillis: 1_000, queueId: "deathmatch" },
          { matchId: "m2", gameStartTimeMillis: 2_000, queueId: "competitive" },
        ],
      }),
    "/val/match/v1/matches/m1": () =>
      respond(200, {
        matchInfo: { mapId: MAP_ID, gameStartMillis: 1_000, queueId: "deathmatch" },
        players: [player(PUUID, PUUID)],
        teams: [{ teamId: PUUID, won: false, roundsWon: 40 }],
      }),
    "/val/match/v1/matches/m2": () => respond(200, matchBody("competitive", 2_000, true)),
    "/val/content/v1/contents": () =>
      respond(200, {
        characters: [{ id: AGENT_ID, name: "Jett", localizedNames: { "pl-PL": "Jett PL" } }],
        maps: [{ id: "x", name: "Ascent", assetPath: MAP_ID }],
      }),
    ...overrides,
  };
  const transport: TransportAdapter = {
    async send(request) {
      requests.push(request);
      const path = Object.keys(routes).find((candidate) =>
        request.url.pathname.includes(candidate),
      );
      return path ? (routes[path]?.() as HttpResponse) : respond(404);
    },
  };
  return { transport, requests };
}

function setup(overrides?: Record<string, () => HttpResponse>) {
  const { transport, requests } = fakeTransport(overrides);
  const store = createMemoryStore();
  const stats = createValorantStats({
    apiKey: "RGAPI-secret-test-key",
    store,
    logger: silentLogger,
    transport,
  });
  return { stats, requests, store };
}

const id = { gameName: "Zażółć", tagLine: "EUNE" };

describe("createValorantStats", () => {
  test("maps the account, shard, matchlist, matches and content into a profile", async () => {
    const { stats } = setup();
    const profile = await stats.valorant(id);
    expect(profile.riotId).toEqual({ gameName: "Zażółć", tagLine: "EUNE" });
    expect(profile.region).toBe("eu");
    expect(profile.rank).toBe("Gold 3");
    expect(profile.matches).toEqual([
      {
        won: true,
        score: "13:7",
        map: "Ascent",
        agent: "Jett PL",
        kills: 21,
        deaths: 12,
        assists: 5,
        startedAt: new Date(2_000),
        queue: "competitive",
      },
      {
        won: null,
        score: null,
        map: "Ascent",
        agent: "Jett PL",
        kills: 21,
        deaths: 12,
        assists: 5,
        startedAt: new Date(1_000),
        queue: "deathmatch",
      },
    ]);
  });

  test("account is looked up on europe, the rest on the player's shard, with the key in a header", async () => {
    const { stats, requests } = setup();
    await stats.valorant({ gameName: "A B/ü", tagLine: "T#1" });
    const account = requests.find((request) => request.url.pathname.includes("by-riot-id"));
    expect(account?.url.origin).toBe("https://europe.api.riotgames.com");
    expect(account?.url.pathname).toBe("/riot/account/v1/accounts/by-riot-id/a%20b%2F%C3%BC/t%231");
    const matchlist = requests.find((request) => request.url.pathname.includes("matchlists"));
    expect(matchlist?.url.origin).toBe("https://eu.api.riotgames.com");
    expect(account?.headers["X-Riot-Token"]).toBe("RGAPI-secret-test-key");
    expect(requests.some((request) => request.url.href.includes("RGAPI"))).toBe(false);
  });

  test("falls back to the map's last path segment and no agent name without content", async () => {
    const { stats } = setup({ "/val/content/v1/contents": () => respond(500) });
    const profile = await stats.valorant(id);
    expect(profile.matches[0]?.map).toBe("Ascent");
    expect(profile.matches[0]?.agent).toBeNull();
  });

  test("an empty matchlist and a 404 matchlist both give no matches", async () => {
    for (const answer of [() => respond(200, { puuid: PUUID, history: [] }), () => respond(404)]) {
      const { stats } = setup({ "/val/match/v1/matchlists/by-puuid/": answer });
      expect(await stats.valorant(id)).toMatchObject({ rank: null, matches: [] });
    }
  });

  test("a player missing from a match is skipped, and unranked matches give no rank", async () => {
    const { stats } = setup({
      "/val/match/v1/matches/m2": () =>
        respond(200, {
          ...matchBody("competitive", 2_000, true),
          players: [player("x", "Blue", 9)],
        }),
    });
    const profile = await stats.valorant(id);
    expect(profile.matches).toHaveLength(1);
    expect(profile.rank).toBeNull();
  });

  test("an account without Valorant activity (no active shard) is not found", async () => {
    const { stats } = setup({ "/riot/account/v1/active-shards/by-game/val/": () => respond(404) });
    await expect(stats.valorant(id)).rejects.toEqual(new RiotLookupError("not-found"));
  });

  test("403 on the matchlist (a development key) is forbidden", async () => {
    const { stats } = setup({ "/val/match/v1/matchlists/by-puuid/": () => respond(403) });
    await expect(stats.valorant(id)).rejects.toEqual(new RiotLookupError("forbidden"));
  });

  test("429 carries Retry-After in milliseconds", async () => {
    const { stats } = setup({
      "/val/match/v1/matchlists/by-puuid/": () => respond(429, {}, { "Retry-After": "7" }),
    });
    await expect(stats.valorant(id)).rejects.toEqual(new RiotLookupError("rate-limited", 7000));
  });

  test("a rate-limited content request is not swallowed", async () => {
    const { stats } = setup({
      "/val/content/v1/contents": () => respond(429, {}, { "Retry-After": "3" }),
    });
    await expect(stats.valorant(id)).rejects.toEqual(new RiotLookupError("rate-limited", 3000));
  });

  test("a failing transport is unavailable", async () => {
    const stats = createValorantStats({
      apiKey: "k",
      store: createMemoryStore(),
      logger: silentLogger,
      transport: {
        send: async () => {
          throw new TransportError({ cause: new Error("socket closed") });
        },
      },
    });
    await expect(stats.valorant(id)).rejects.toEqual(new RiotLookupError("unavailable"));
  });

  test("a response of the wrong shape is unavailable", async () => {
    const { stats } = setup({
      "/riot/account/v1/active-shards/by-game/val/": () => respond(200, { activeShard: "moon" }),
    });
    await expect(stats.valorant(id)).rejects.toEqual(new RiotLookupError("unavailable"));
  });

  test("the second lookup hits the KV cache instead of the transport", async () => {
    const { stats, requests } = setup();
    await stats.valorant(id);
    const first = requests.length;
    expect(requests.filter((request) => request.url.pathname.endsWith("/matches/m2"))).toHaveLength(
      1,
    );

    await stats.valorant(id);
    expect(requests.length).toBe(first);
  });
});

describe("createValorantStats projections and resilience", () => {
  test("one match of the wrong shape and one 404 match are dropped, the rest is shown", async () => {
    const history = Array.from({ length: 4 }, (_, index) => ({
      matchId: `q${index + 10}`,
      gameStartTimeMillis: 10_000 - index,
      queueId: "competitive",
    }));
    const { stats } = setup({
      "/val/match/v1/matchlists/by-puuid/": () => respond(200, { puuid: PUUID, history }),
      "/val/match/v1/matches/q10": () => respond(200, { matchInfo: "nope" }),
      "/val/match/v1/matches/q11": () => respond(404),
      "/val/match/v1/matches/q12": () => respond(200, matchBody("competitive", 9_998, true)),
      "/val/match/v1/matches/q13": () => respond(200, matchBody("competitive", 9_997, false)),
    });
    const profile = await stats.valorant(id);
    expect(profile.matches.map((match) => match.won)).toEqual([true, false]);
  });

  test("a rate limit on one match still fails the lookup", async () => {
    const { stats } = setup({
      "/val/match/v1/matches/m2": () => respond(429, {}, { "Retry-After": "5" }),
    });
    await expect(stats.valorant(id)).rejects.toEqual(new RiotLookupError("rate-limited", 5000));
  });

  test("a missing queue id falls back to the matchlist entry", async () => {
    const body = matchBody("competitive", 2_000, true);
    const { stats } = setup({
      "/val/match/v1/matches/m2": () =>
        respond(200, { ...body, matchInfo: { mapId: MAP_ID, gameStartMillis: 2_000 } }),
    });
    expect((await stats.valorant(id)).matches[0]?.queue).toBe("competitive");
  });

  test("maps are matched by the last path segment of assetPath or by assetName", async () => {
    for (const map of [
      { id: "x", name: "Zbocze", assetPath: "ShooterGame/Content/Maps/Ascent/Ascent" },
      { id: "x", name: "Zbocze", assetName: "Ascent" },
    ]) {
      const { stats } = setup({
        "/val/content/v1/contents": () => respond(200, { characters: [], maps: [map] }),
      });
      expect((await stats.valorant(id)).matches[0]?.map).toBe("Zbocze");
    }
  });

  test("only the projection is cached, not the raw bodies", async () => {
    const big = "x".repeat(5_000);
    const { stats, store } = setup({
      "/val/match/v1/matches/m2": () =>
        respond(200, { ...matchBody("competitive", 2_000, true), junk: big }),
      "/val/content/v1/contents": () =>
        respond(200, { characters: [], maps: [], skins: [{ name: big }] }),
    });
    await stats.valorant(id);
    for (const key of ["riot:val:match:eu:m2", "riot:val:content:eu"]) {
      const cached = await store.get(key);
      expect(cached).not.toBeNull();
      expect(cached).not.toContain("xxxx");
    }
  });

  test("account lookups use lowercase names so the cache is shared", async () => {
    const { stats, requests } = setup();
    await stats.valorant({ gameName: "ZAŻÓŁĆ", tagLine: "EUNE" });
    await stats.valorant({ gameName: "zażółć", tagLine: "eune" });
    expect(requests.filter((r) => r.url.pathname.includes("by-riot-id"))).toHaveLength(1);
  });
});

describe("tierName", () => {
  test.each([
    [0, null],
    [2, null],
    [3, "Iron 1"],
    [14, "Gold 3"],
    [24, "Immortal 1"],
    [26, "Immortal 3"],
    [27, "Radiant"],
    [28, null],
  ])("tier %d", (tier, name) => {
    expect(tierName(tier)).toBe(name);
  });
});
