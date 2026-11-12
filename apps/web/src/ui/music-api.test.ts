import { describe, expect, test } from "bun:test";
import {
  clearQueue,
  enqueueTracks,
  fetchMusicState,
  fetchVoiceChannels,
  formatTime,
  joinVoice,
  MUSIC_ERRORS,
  type MusicPlayerInfo,
  moveTrack,
  parseMusicEvent,
  positionAt,
  removeTrack,
  searchMusic,
  sendControl,
  shuffleQueue,
} from "./music-api.ts";

const player = (overrides: Partial<MusicPlayerInfo> = {}): MusicPlayerInfo => ({
  voiceChannelId: "400000000000000004",
  current: {
    key: "ab",
    title: "A",
    author: "Autor",
    durationMs: 200_000,
    uri: null,
    requesterId: "100000000000000099",
    byBot: false,
    isStream: false,
    isSeekable: true,
  },
  positionMs: 30_000,
  paused: false,
  loop: "off",
  volume: 100,
  filter: "off",
  queue: { offset: 0, total: 0, totalDurationMs: 0, tracks: [] },
  ...overrides,
});

describe("positionAt", () => {
  test("moves on from when the page received the state, whatever the clocks say", () => {
    expect(positionAt(player(), 1_000, 6_000)).toBe(35_000);
    // A receive time ahead of now (a clock step back) never moves the position back.
    expect(positionAt(player(), 9_000, 6_000)).toBe(30_000);
  });

  test("stands still while paused and stops at the end of the track", () => {
    expect(positionAt(player({ paused: true }), 1_000, 60_000)).toBe(30_000);
    expect(positionAt(player(), 0, 1_000_000)).toBe(200_000);
  });
});

test("formatTime", () => {
  expect([0, 5_000, 185_000, 3_723_000].map(formatTime)).toEqual([
    "0:00",
    "0:05",
    "3:05",
    "1:02:03",
  ]);
});

const reply = (status: number, body: unknown) => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("music endpoints", () => {
  type Seen = { path: string; init?: RequestInit };
  const recorder = (status = 200, body: unknown = { status: "ok" }) => {
    const seen: Seen[] = [];
    const fetcher = async (path: string, init?: RequestInit) => {
      seen.push({ path, init });
      return new Response(JSON.stringify(body), { status });
    };
    return { seen, fetcher };
  };

  test("fetchMusicState reads the state with the queue offset and returns the data", async () => {
    const { seen, fetcher } = recorder(200, { guildId: "1" });
    const result = await fetchMusicState("1", 40, fetcher);
    expect(result).toEqual({ ok: true, data: { guildId: "1" } } as never);
    expect(seen[0]?.path).toBe("/api/music/1/state?offset=40");
    expect(seen[0]?.init?.method).toBe("GET");
    expect(seen[0]?.init?.body).toBeUndefined();
  });

  test("fetchVoiceChannels reads the voice channels of the guild", async () => {
    const { seen, fetcher } = recorder(200, { channels: [], truncated: false });
    await fetchVoiceChannels("a/b", fetcher);
    expect(seen[0]?.path).toBe("/api/music/a%2Fb/voice-channels");
  });

  test("searchMusic encodes the query", async () => {
    const { seen, fetcher } = recorder(200, {});
    await searchMusic("1", "a b&c", fetcher);
    expect(seen[0]?.path).toBe("/api/music/1/search?q=a%20b%26c");
  });

  test("joinVoice posts the channel id as JSON", async () => {
    const { seen, fetcher } = recorder();
    await joinVoice("1", "42", fetcher);
    expect(seen[0]?.path).toBe("/api/music/1/join");
    expect(seen[0]?.init?.method).toBe("POST");
    expect(seen[0]?.init?.body).toBe(JSON.stringify({ channelId: "42" }));
    expect(seen[0]?.init?.headers).toEqual({ "Content-Type": "application/json" });
  });

  test("enqueueTracks posts the picks to the queue", async () => {
    const { seen, fetcher } = recorder(200, { status: "ok", added: 2, skipped: 0 });
    const result = await enqueueTracks("1", { searchId: "s", picks: [0, 2] }, fetcher);
    expect(result).toEqual({ ok: true, data: { status: "ok", added: 2, skipped: 0 } });
    expect(seen[0]?.path).toBe("/api/music/1/queue");
    expect(seen[0]?.init?.body).toBe(JSON.stringify({ searchId: "s", picks: [0, 2] }));
  });

  test("removeTrack and moveTrack post the index and the track key", async () => {
    const { seen, fetcher } = recorder();
    await removeTrack("1", 3, "k", fetcher);
    await moveTrack("1", 3, 0, "k", fetcher);
    expect(seen[0]?.path).toBe("/api/music/1/queue/remove");
    expect(seen[0]?.init?.body).toBe(JSON.stringify({ index: 3, key: "k" }));
    expect(seen[1]?.path).toBe("/api/music/1/queue/move");
    expect(seen[1]?.init?.body).toBe(JSON.stringify({ from: 3, to: 0, key: "k" }));
  });

  test("shuffleQueue posts an empty object and clearQueue sends a DELETE without a body", async () => {
    const { seen, fetcher } = recorder();
    await shuffleQueue("1", fetcher);
    await clearQueue("1", fetcher);
    expect(seen[0]?.path).toBe("/api/music/1/queue/shuffle");
    expect(seen[0]?.init?.body).toBe("{}");
    expect(seen[1]?.init?.method).toBe("DELETE");
    expect(seen[1]?.init?.body).toBeUndefined();
  });

  test("sendControl posts the control action", async () => {
    const { seen, fetcher } = recorder();
    await sendControl("1", { action: "volume", percent: 80 }, fetcher);
    expect(seen[0]?.path).toBe("/api/music/1/control");
    expect(seen[0]?.init?.body).toBe(JSON.stringify({ action: "volume", percent: 80 }));
  });
});

describe("error mapping", () => {
  test("a 422 with a known reason maps to that reason", async () => {
    const result = await clearQueue("1", reply(422, { error: "rejected", reason: "queue_full" }));
    expect(result).toEqual({ ok: false, error: "queue_full" });
  });

  test("a 422 with an unknown reason becomes a generic error", async () => {
    const result = await clearQueue("1", reply(422, { reason: "toString" }));
    expect(result).toEqual({ ok: false, error: "error" });
  });

  test("a 503 maps to bot_unavailable, or audit_unavailable when the audit log is down", async () => {
    expect(await clearQueue("1", reply(503, { error: "bot_unavailable" }))).toEqual({
      ok: false,
      error: "bot_unavailable",
    });
    expect(await clearQueue("1", reply(503, { error: "audit_unavailable" }))).toEqual({
      ok: false,
      error: "audit_unavailable",
    });
  });

  test("a 400 maps to invalid", async () => {
    expect(await clearQueue("1", reply(400, {}))).toEqual({ ok: false, error: "invalid" });
  });

  test("other statuses and unreadable bodies map to a generic error", async () => {
    expect(await clearQueue("1", reply(500, "not json"))).toEqual({ ok: false, error: "error" });
  });

  test("a network failure maps to a generic error", async () => {
    const failing = async () => {
      throw new Error("offline");
    };
    expect(await clearQueue("1", failing)).toEqual({ ok: false, error: "error" });
  });

  test("every error has a Polish text", () => {
    for (const text of Object.values(MUSIC_ERRORS)) expect(text.length).toBeGreaterThan(5);
  });
});

describe("parseMusicEvent", () => {
  test("accepts a state event with a guild id", () => {
    const event = { event: "music.state", payload: { guildId: "1", available: true } };
    expect(parseMusicEvent(event)).toEqual(event as never);
  });

  test("accepts a status event with a boolean flag", () => {
    const event = { event: "music.status", payload: { available: false } };
    expect(parseMusicEvent(event)).toEqual(event as never);
  });

  test("rejects malformed or unrelated events", () => {
    expect(parseMusicEvent(null)).toBeNull();
    expect(parseMusicEvent({ event: "music.state", payload: null })).toBeNull();
    expect(parseMusicEvent({ event: "music.state", payload: { guildId: 1 } })).toBeNull();
    expect(parseMusicEvent({ event: "music.status", payload: { available: "yes" } })).toBeNull();
    expect(parseMusicEvent({ event: "message.create", payload: {} })).toBeNull();
  });
});
