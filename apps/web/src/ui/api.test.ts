import { describe, expect, test } from "bun:test";
import {
  backfillChannel,
  fetchArchiveSettings,
  fetchBotOnline,
  fetchChannels,
  fetchGuilds,
  saveDmArchive,
  saveGuildArchive,
} from "./api.ts";

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

describe("archive calls", () => {
  const GUILD = "100000000000000001";

  test("fetchArchiveSettings reads the settings, or null", async () => {
    const settings = { dm: { enabled: false }, guilds: [] };
    expect(await fetchArchiveSettings(answer(200, settings))).toEqual(settings);
    expect(await fetchArchiveSettings(answer(503))).toBeNull();
    expect(await fetchArchiveSettings(answer(200, { dm: null }))).toBeNull();
  });

  test("fetchChannels tells an unavailable bot from an error", async () => {
    const channels = [{ id: "1", name: "a", kind: "text" as const, parentId: null }];
    expect(await fetchChannels(GUILD, answer(200, { channels, truncated: true }))).toEqual({
      kind: "ready",
      channels,
      truncated: true,
    });
    expect(await fetchChannels(GUILD, answer(503))).toEqual({ kind: "unavailable" });
    expect(await fetchChannels(GUILD, answer(404))).toEqual({ kind: "error" });
  });

  test("a change is sent as JSON with the right method and path", async () => {
    const seen: [string, RequestInit | undefined][] = [];
    const fetcher = async (input: string, init?: RequestInit) => {
      seen.push([input, init]);
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    };
    await saveGuildArchive(GUILD, { enabled: true, excludedChannelIds: [] }, fetcher);
    await saveDmArchive(true, fetcher);
    await backfillChannel("200000000000000002", fetcher);
    expect(seen.map(([path, init]) => [init?.method, path, init?.body])).toEqual([
      ["PUT", `/api/archive/guilds/${GUILD}`, '{"enabled":true,"excludedChannelIds":[]}'],
      ["PUT", "/api/archive/dm", '{"enabled":true}'],
      ["POST", "/api/archive/channels/200000000000000002/backfill", "{}"],
    ]);
  });

  test("a refused change says why", async () => {
    expect(await saveDmArchive(true, answer(503, { error: "audit_unavailable" }))).toEqual({
      ok: false,
      error: "audit_unavailable",
    });
    expect(await saveDmArchive(true, answer(503, { error: "bot_timeout" }))).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await saveDmArchive(true, answer(400))).toEqual({ ok: false, error: "error" });
    expect(
      await saveDmArchive(true, async () => {
        throw new TypeError("network");
      }),
    ).toEqual({ ok: false, error: "error" });
  });
});
