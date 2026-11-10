import { afterEach, describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import { createMemoryStore } from "@dzajcarz/kv";
import { createRiotStats } from "./stats.ts";

const VALORANT_KEY = "RGAPI-valorant-test-key";
const LOL_KEY = "RGAPI-lol-test-key";
const cache = createMemoryStore();

const build = (keys: { valorantApiKey?: string; lolApiKey?: string }) =>
  createRiotStats({ ...keys, cache, logger: silentLogger });

describe("createRiotStats", () => {
  test("offers only the games that have a key", () => {
    expect(Object.keys(build({ valorantApiKey: VALORANT_KEY }))).toEqual(["valorant"]);
    expect(Object.keys(build({ lolApiKey: LOL_KEY }))).toEqual(["lol"]);
    expect(Object.keys(build({ valorantApiKey: VALORANT_KEY, lolApiKey: LOL_KEY })).sort()).toEqual(
      ["lol", "valorant"],
    );
    expect(build({})).toEqual({});
  });

  test("treats an empty key as missing", () => {
    expect(build({ valorantApiKey: "", lolApiKey: "" })).toEqual({});
  });

  describe("League lookups", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    test("send the League key, not the Valorant one", async () => {
      const tokens: unknown[] = [];
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        tokens.push(new Headers(init?.headers).get("X-Riot-Token"));
        return new Response("{}", { status: 404 });
      }) as unknown as typeof fetch;

      const { lol } = build({ valorantApiKey: VALORANT_KEY, lolApiKey: LOL_KEY });
      await lol?.({ gameName: "Dzajcarz", tagLine: "EUNE" }, "eun1").catch(() => undefined);

      expect(tokens).toEqual([LOL_KEY]);
    });
  });
});
