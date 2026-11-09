import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import { createMemoryStore } from "@dzajcarz/kv";
import { RiotLookupError } from "@dzajcarz/module-riot";
import { createLolStats } from "./lol.ts";

const KEY = "RGAPI-secret-test-key";

const ACCOUNT = { puuid: "puuid-1", gameName: "Zażółć", tagLine: "EUNE" };

/** Answers by URL; every call is recorded. */
function fakeFetch(overrides: Record<string, () => Response> = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const json = (body: unknown) => () => Response.json(body);
  const routes: Record<string, () => Response> = {
    "/riot/account/v1/accounts/by-riot-id/": json(ACCOUNT),
    "/lol/summoner/v4/summoners/by-puuid/": json({ profileIconId: 4321, summonerLevel: 250 }),
    "/lol/league/v4/entries/by-puuid/": json([
      {
        queueType: "RANKED_SOLO_5x5",
        tier: "GOLD",
        rank: "IV",
        leaguePoints: 37,
        wins: 20,
        losses: 18,
      },
      { queueType: "RANKED_TFT", tier: "IRON", rank: "I", leaguePoints: 0, wins: 1, losses: 1 },
    ]),
    "/lol/champion-mastery/v4/champion-masteries/by-puuid/": json([
      { championId: 103, championLevel: 7, championPoints: 123456 },
      { championId: 999999, championLevel: 5, championPoints: 100 },
    ]),
    "/api/versions.json": json(["14.1.1", "14.0.1"]),
    "/data/pl_PL/champion.json": json({ data: { Ahri: { key: "103", name: "Ahri" } } }),
    ...overrides,
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = Object.keys(routes).find((path) => url.includes(path));
    return route ? routes[route]?.() : new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function setup(overrides?: Record<string, () => Response>) {
  const { fetch, calls } = fakeFetch(overrides);
  const store = createMemoryStore();
  const stats = createLolStats({ apiKey: KEY, store, logger: silentLogger, fetch });
  return { stats, calls, store };
}

const id = { gameName: "Zażółć", tagLine: "EUNE" };

describe("createLolStats", () => {
  test("maps the four endpoints and Data Dragon into a profile", async () => {
    const { stats } = setup();
    const profile = await stats.lol(id, "eun1");
    expect(profile).toEqual({
      riotId: { gameName: "Zażółć", tagLine: "EUNE" },
      platform: "eun1",
      level: 250,
      iconUrl: "https://ddragon.leagueoflegends.com/cdn/14.1.1/img/profileicon/4321.png",
      queues: [{ queue: "solo", tier: "GOLD", rank: "IV", lp: 37, wins: 20, losses: 18 }],
      topChampions: [
        { name: "Ahri", level: 7, points: 123456 },
        { name: "#999999", level: 5, points: 100 },
      ],
    });
  });

  test("encodes the Riot ID, routes by platform and sends the token only to Riot", async () => {
    const { stats, calls } = setup();
    await stats.lol({ gameName: "A B/ü?", tagLine: "T#1" }, "euw1");
    const urls = calls.map((call) => call.url);
    expect(urls).toContain(
      "https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/a%20b%2F%C3%BC%3F/t%231",
    );
    expect(urls).toContain(
      "https://euw1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/puuid-1",
    );
    expect(urls).toContain("https://euw1.api.riotgames.com/lol/league/v4/entries/by-puuid/puuid-1");
    expect(urls).toContain(
      "https://euw1.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/puuid-1/top?count=3",
    );
    expect(urls).toContain(
      "https://ddragon.leagueoflegends.com/cdn/14.1.1/data/pl_PL/champion.json",
    );
    for (const call of calls) {
      const isRiot = call.url.includes("api.riotgames.com");
      expect(call.headers["X-Riot-Token"]).toBe(isRiot ? KEY : undefined);
    }
  });

  test("the second lookup is served from the cache", async () => {
    const { stats, calls } = setup();
    await stats.lol(id, "eun1");
    const first = calls.length;
    expect(first).toBe(6);
    await stats.lol(id, "eun1");
    expect(calls.length).toBe(first);
  });

  test("a broken cache entry is a miss", async () => {
    const { stats, calls, store } = setup();
    await stats.lol(id, "eun1");
    await store.set("riot:lol:summoner:eun1:puuid-1", "{not json");
    const before = calls.length;
    const profile = await stats.lol(id, "eun1");
    expect(profile.level).toBe(250);
    expect(calls.length).toBe(before + 1);
  });

  test("a failing cache only costs a request", async () => {
    const { fetch } = fakeFetch();
    const broken = createMemoryStore();
    broken.get = async () => {
      throw new Error("redis down");
    };
    broken.set = async () => {
      throw new Error("redis down");
    };
    const stats = createLolStats({ apiKey: KEY, store: broken, logger: silentLogger, fetch });
    expect((await stats.lol(id, "eun1")).level).toBe(250);
  });

  test("without Data Dragon champions are shown by id and the icon is empty", async () => {
    const { stats } = setup({ "/api/versions.json": () => new Response("down", { status: 500 }) });
    const profile = await stats.lol(id, "eun1");
    expect(profile.iconUrl).toBe("");
    expect(profile.topChampions[0]?.name).toBe("#103");
  });

  const failures: [number, string, RiotLookupError][] = [
    [404, "not-found", new RiotLookupError("not-found")],
    [403, "forbidden", new RiotLookupError("forbidden")],
    [401, "forbidden", new RiotLookupError("forbidden")],
    [500, "unavailable", new RiotLookupError("unavailable")],
  ];
  test.each(failures)("status %d on the account lookup is %s", async (status, _kind, expected) => {
    const { stats } = setup({
      "/riot/account/v1/accounts/by-riot-id/": () => new Response("", { status }),
    });
    await expect(stats.lol(id, "eun1")).rejects.toEqual(expected);
  });

  test("zero, negative, empty and huge Retry-After values are sanitised", async () => {
    const cases: [string, number | undefined][] = [
      ["0", undefined],
      ["-5", undefined],
      ["", undefined],
      ["abc", undefined],
      ["99999", 120_000],
    ];
    for (const [header, expected] of cases) {
      const { stats } = setup({
        "/lol/league/v4/entries/by-puuid/": () =>
          new Response("", { status: 429, headers: { "Retry-After": header } }),
      });
      await expect(stats.lol(id, "eun1")).rejects.toEqual(
        new RiotLookupError("rate-limited", expected),
      );
    }
  });

  test("a 429 on the summoner stops the remaining requests", async () => {
    const { stats, calls } = setup({
      "/lol/summoner/v4/summoners/by-puuid/": () => new Response("", { status: 429 }),
    });
    await expect(stats.lol(id, "eun1")).rejects.toBeInstanceOf(RiotLookupError);
    expect(calls.some((call) => call.url.includes("league/v4"))).toBe(false);
  });

  test("requests refuse redirects", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const { fetch } = fakeFetch();
    const spy = ((input: string | URL | Request, init?: RequestInit) => {
      seen.push(init);
      return fetch(input, init);
    }) as typeof globalThis.fetch;
    const stats = createLolStats({
      apiKey: KEY,
      store: createMemoryStore(),
      logger: silentLogger,
      fetch: spy,
    });
    await stats.lol(id, "eun1");
    expect(seen.every((init) => init?.redirect === "error")).toBe(true);
  });

  test("a suspicious Data Dragon version is not used", async () => {
    const { stats, calls } = setup({ "/api/versions.json": () => Response.json(["../../evil"]) });
    const profile = await stats.lol(id, "eun1");
    expect(profile.iconUrl).toBe("");
    expect(calls.some((call) => call.url.includes("evil"))).toBe(false);
  });

  test("only key and name of Data Dragon champions are cached", async () => {
    const { stats, store } = setup({
      "/data/pl_PL/champion.json": () =>
        Response.json({ data: { Ahri: { key: "103", name: "Ahri", blurb: "x".repeat(5000) } } }),
    });
    await stats.lol(id, "eun1");
    expect(await store.get("riot:lol:ddragon:champions:14.1.1")).not.toContain("xxxx");
  });

  test("429 carries Retry-After in milliseconds", async () => {
    const { stats } = setup({
      "/lol/league/v4/entries/by-puuid/": () =>
        new Response("", { status: 429, headers: { "Retry-After": "7" } }),
    });
    await expect(stats.lol(id, "eun1")).rejects.toEqual(new RiotLookupError("rate-limited", 7000));
  });

  test("429 without Retry-After carries no wait", async () => {
    const { stats } = setup({
      "/lol/league/v4/entries/by-puuid/": () => new Response("", { status: 429 }),
    });
    await expect(stats.lol(id, "eun1")).rejects.toEqual(new RiotLookupError("rate-limited"));
  });

  test("a network failure or a timeout is unavailable", async () => {
    const stats = createLolStats({
      apiKey: KEY,
      store: createMemoryStore(),
      logger: silentLogger,
      fetch: (async () => {
        throw new DOMException("timed out", "TimeoutError");
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(stats.lol(id, "eun1")).rejects.toEqual(new RiotLookupError("unavailable"));
  });

  test("a response of the wrong shape is unavailable", async () => {
    const { stats } = setup({
      "/lol/summoner/v4/summoners/by-puuid/": () => Response.json({ nope: true }),
    });
    await expect(stats.lol(id, "eun1")).rejects.toEqual(new RiotLookupError("unavailable"));
  });
});
