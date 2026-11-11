import { describe, expect, test } from "bun:test";
import { fetchBotOnline, fetchGuilds } from "./api.ts";

const answer =
  (status: number, body: unknown = {}) =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe("fetchGuilds", () => {
  test("200 is the list", async () => {
    const guilds = [{ id: "1", name: "A", iconUrl: null, memberCount: 1 }];
    expect(await fetchGuilds(answer(200, { guilds }))).toEqual({ kind: "ready", guilds });
  });

  test("503 means the bot is unavailable, whichever way it failed", async () => {
    expect(await fetchGuilds(answer(503, { error: "bot_timeout" }))).toEqual({
      kind: "unavailable",
    });
    expect(await fetchGuilds(answer(503, { error: "bot_unavailable" }))).toEqual({
      kind: "unavailable",
    });
  });

  test("another status, a malformed body or a network failure is an error", async () => {
    expect(await fetchGuilds(answer(502))).toEqual({ kind: "error" });
    expect(await fetchGuilds(answer(200, { nope: true }))).toEqual({ kind: "error" });
    expect(
      await fetchGuilds(async () => {
        throw new TypeError("network");
      }),
    ).toEqual({ kind: "error" });
  });
});

describe("fetchBotOnline", () => {
  test("reads the bot status", async () => {
    expect(await fetchBotOnline(answer(200, { bot: "online" }))).toBe(true);
    expect(await fetchBotOnline(answer(200, { bot: "offline" }))).toBe(false);
  });

  test("is null when the panel cannot be asked", async () => {
    expect(await fetchBotOnline(answer(401))).toBeNull();
    expect(
      await fetchBotOnline(async () => {
        throw new TypeError("network");
      }),
    ).toBeNull();
  });
});
