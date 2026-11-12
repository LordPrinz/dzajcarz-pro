import { describe, expect, test } from "bun:test";
import {
  dayStart,
  fetchDms,
  fetchMessages,
  fetchVersions,
  messagesPath,
  searchArchive,
  searchPath,
} from "./reading-api.ts";

const CHANNEL = "200000000000000002";
const GUILD = "100000000000000001";

const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as never;

describe("paths", () => {
  test("messages: guild or dm, parent, one cursor", () => {
    expect(messagesPath({ id: CHANNEL, guildId: null, name: "x" }, null)).toBe(
      `/api/channels/${CHANNEL}/messages?guild=dm`,
    );
    expect(
      messagesPath({ id: CHANNEL, guildId: GUILD, parentId: "2", name: "x" }, { before: "5" }),
    ).toBe(`/api/channels/${CHANNEL}/messages?guild=${GUILD}&parent=2&before=5`);
  });

  test("search: only the filters that are set, the 'to' day included", () => {
    const path = searchPath(
      { q: " pizza ", guild: "dm", channel: "", author: "", from: "2026-11-01", to: "2026-11-02" },
      "7",
    );
    const params = new URL(path, "https://x").searchParams;
    expect(params.get("q")).toBe("pizza");
    expect(params.get("guild")).toBe("dm");
    expect(params.has("channel")).toBe(false);
    expect(params.get("from")).toBe(dayStart("2026-11-01"));
    expect(params.get("to")).toBe(dayStart("2026-11-03"));
    expect(params.get("before")).toBe("7");
  });

  test("dayStart is local midnight, and null for anything else", () => {
    expect(dayStart("2026-11-01")).toBe(new Date(2026, 10, 1).toISOString());
    expect(dayStart("2026-11-30", 1)).toBe(new Date(2026, 11, 1).toISOString());
    expect(dayStart("wczoraj")).toBeNull();
  });
});

describe("fetchMessages", () => {
  const channel = { id: CHANNEL, guildId: GUILD, name: "x" };

  test("returns the page", async () => {
    const page = { source: "live", messages: [], resolved: {}, hasOlder: false, hasNewer: false };
    expect(await fetchMessages(channel, null, { fetcher: answer(200, page) })).toEqual({
      ok: true,
      page,
    } as never);
  });

  test.each([
    [503, "bot_unavailable", "unavailable"],
    [503, "bot_timeout", "unavailable"],
    [503, "database_unavailable", "database"],
    [403, "no_access", "no_access"],
    [404, "unknown_channel", "unknown_channel"],
    [404, "unknown_message", "unknown_message"],
    [409, "not_archived", "not_archived"],
    [503, "query_timeout", "timeout"],
    [500, "internal_error", "error"],
  ])("%i %s is %s", async (status, error, expected) => {
    expect(await fetchMessages(channel, null, { fetcher: answer(status, { error }) })).toEqual({
      ok: false,
      error: expected,
    } as never);
  });

  test("a network failure is an error", async () => {
    const failing = (async () => {
      throw new TypeError("network");
    }) as never;
    expect(await fetchMessages(channel, null, { fetcher: failing })).toEqual({
      ok: false,
      error: "error",
    });
  });
});

describe("the other readers", () => {
  test("versions, search and DMs", async () => {
    expect(await fetchVersions("1", answer(200, { versions: [] }))).toEqual([]);
    expect(await fetchVersions("1", answer(503, {}))).toBeNull();
    const filters = { q: "a", guild: "", channel: "", author: "", from: "", to: "" };
    expect(await searchArchive(filters, null, answer(400, {}))).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await searchArchive(filters, null, answer(503, {}))).toEqual({
      ok: false,
      error: "database",
    });
    expect(await searchArchive(filters, null, answer(503, { error: "query_timeout" }))).toEqual({
      ok: false,
      error: "timeout",
    });
    expect(await fetchDms(answer(200, { dms: [], bot: "unavailable", truncated: false }))).toEqual({
      kind: "ready",
      dms: [],
      botAvailable: false,
      truncated: false,
    });
    expect(await fetchDms(answer(503, {}))).toEqual({ kind: "error" });
  });
});
