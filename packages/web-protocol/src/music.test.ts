import { describe, expect, test } from "bun:test";
import { COMMANDS } from "./commands.ts";
import { MAX_MESSAGE_BYTES } from "./envelope.ts";
import { EVENTS } from "./events.ts";
import {
  MAX_MUSIC_PICKS,
  MAX_MUSIC_QUEUE_LENGTH,
  MAX_MUSIC_RESULTS,
  MAX_PLAYLIST_NAME_LENGTH,
  MAX_TRACK_AUTHOR_LENGTH,
  MAX_TRACK_TITLE_LENGTH,
  MAX_TRACK_URI_LENGTH,
  MAX_VOICE_CHANNELS,
  MUSIC_QUEUE_PAGE,
  MusicTrackInfo,
  type MusicTrackSource,
  toMusicTrackInfo,
  trackKey,
} from "./music.ts";

const GUILD = "100000000000000001";
const VOICE = "400000000000000004";
const ID = "8b0f3c1e-1d2a-4f5b-9c6d-7e8f9a0b1c2d";
const SNOWFLAKE = "12345678901234567890";

function source(overrides: Partial<MusicTrackSource> = {}): MusicTrackSource {
  return {
    id: "QAAAjQIAJVJpY2sgQXN0bGV5",
    title: "Never Gonna Give You Up",
    author: "Rick Astley",
    durationMs: 213_000,
    uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    requesterId: SNOWFLAKE,
    isStream: false,
    isSeekable: true,
    ...overrides,
  };
}

/** The largest track the schema lets through: every text at its cap in characters JSON escapes to six bytes. */
const worstTrack = (): MusicTrackInfo => ({
  key: "ffffffffffffffff",
  title: "\u0001".repeat(MAX_TRACK_TITLE_LENGTH),
  author: "\u0001".repeat(MAX_TRACK_AUTHOR_LENGTH),
  durationMs: Number.MAX_SAFE_INTEGER,
  uri: `https://a.example/${"a".repeat(MAX_TRACK_URI_LENGTH - 18)}`,
  requesterId: SNOWFLAKE,
  byBot: false,
  isStream: false,
  isSeekable: true,
});

const reply = (result: unknown) => JSON.stringify({ v: 1, id: ID, ok: true, result });
const event = (name: string, payload: unknown) =>
  JSON.stringify({ v: 1, event: name, payload, at: Date.now() });

describe("music tracks", () => {
  test("the key is short and the same on both sides for the same id", () => {
    const key = trackKey("QAAAjQIAJVJpY2sgQXN0bGV5".repeat(100));
    expect(key).toMatch(/^[0-9a-f]{1,16}$/);
    expect(trackKey("QAAAjQIAJVJpY2sgQXN0bGV5".repeat(100))).toBe(key);
    expect(trackKey("other")).not.toBe(key);
  });

  test("a track is cut to the limits and keeps only an https link", () => {
    const info = toMusicTrackInfo(
      source({
        title: `${"x".repeat(MAX_TRACK_TITLE_LENGTH - 1)}😀`,
        author: "a".repeat(500),
        uri: "http://example.com/plain",
        byBot: true,
      }),
    );
    expect(info.title).toBe("x".repeat(MAX_TRACK_TITLE_LENGTH - 1));
    expect(info.author).toHaveLength(MAX_TRACK_AUTHOR_LENGTH);
    expect(info.uri).toBeNull();
    expect(info.byBot).toBe(true);
    expect(MusicTrackInfo.safeParse(info).success).toBe(true);
    expect(toMusicTrackInfo(source({ uri: "javascript:alert(1)" })).uri).toBeNull();
    expect(
      toMusicTrackInfo(source({ uri: `https://a.example/${"a".repeat(MAX_TRACK_URI_LENGTH)}` }))
        .uri,
    ).toBeNull();
    expect(toMusicTrackInfo(source()).uri).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

describe("music commands", () => {
  test("music.control takes each control with its own fields only", () => {
    const { request } = COMMANDS["music.control"];
    const ok = (control: unknown) => request.safeParse({ guildId: GUILD, control }).success;
    expect(ok({ action: "pause" })).toBe(true);
    expect(ok({ action: "skip", key: "abc" })).toBe(true);
    expect(ok({ action: "skip" })).toBe(false);
    expect(ok({ action: "seek", key: "abc", positionMs: 90_000 })).toBe(true);
    expect(ok({ action: "seek", key: "abc", positionMs: -1 })).toBe(false);
    expect(ok({ action: "volume", percent: 150 })).toBe(true);
    expect(ok({ action: "volume", percent: 151 })).toBe(false);
    expect(ok({ action: "loop", mode: "queue" })).toBe(true);
    expect(ok({ action: "loop", mode: "all" })).toBe(false);
    expect(ok({ action: "filter", filter: "8d" })).toBe(true);
    expect(ok({ action: "filter", filter: "echo" })).toBe(false);
    expect(ok({ action: "pause", extra: 1 })).toBe(false);
    expect(ok({ action: "stop" })).toBe(false);
    expect(ok({ action: "skip", key: "XYZ" })).toBe(false);
  });

  test("music.enqueue needs a search id and one to a playlist's worth of picks", () => {
    const { request } = COMMANDS["music.enqueue"];
    const base = { guildId: GUILD, searchId: ID };
    expect(request.safeParse({ ...base, picks: [0] }).success).toBe(true);
    expect(request.safeParse({ ...base, picks: [0], channelId: VOICE }).success).toBe(true);
    expect(request.safeParse({ ...base, picks: [] }).success).toBe(false);
    expect(request.safeParse({ ...base, picks: [MAX_MUSIC_PICKS] }).success).toBe(false);
    expect(
      request.safeParse({ ...base, picks: Array.from({ length: MAX_MUSIC_PICKS + 1 }, () => 0) })
        .success,
    ).toBe(false);
    expect(request.safeParse({ ...base, searchId: "x", picks: [0] }).success).toBe(false);
  });

  test("music.search takes trimmed text up to its limit", () => {
    const { request } = COMMANDS["music.search"];
    expect(request.safeParse({ guildId: GUILD, query: "  lato z radiem " }).data?.query).toBe(
      "lato z radiem",
    );
    expect(request.safeParse({ guildId: GUILD, query: "   " }).success).toBe(false);
    expect(request.safeParse({ guildId: GUILD, query: "a".repeat(201) }).success).toBe(false);
  });

  test("queue edits name the track by place and key", () => {
    const remove = COMMANDS["music.queue.remove"].request;
    expect(remove.safeParse({ guildId: GUILD, index: 0, key: "ab12" }).success).toBe(true);
    expect(remove.safeParse({ guildId: GUILD, index: -1, key: "ab12" }).success).toBe(false);
    const move = COMMANDS["music.queue.move"].request;
    expect(move.safeParse({ guildId: GUILD, from: 3, to: 0, key: "ab12" }).success).toBe(true);
    expect(move.safeParse({ guildId: GUILD, from: 3, key: "ab12" }).success).toBe(false);
    expect(
      remove.safeParse({ guildId: GUILD, index: MAX_MUSIC_QUEUE_LENGTH, key: "ab12" }).success,
    ).toBe(false);
  });

  test("the largest music.state reply and event fit in one message", () => {
    const snapshot = {
      guildId: GUILD,
      available: true,
      at: new Date().toISOString(),
      player: {
        voiceChannelId: SNOWFLAKE,
        current: worstTrack(),
        positionMs: Number.MAX_SAFE_INTEGER,
        paused: false,
        loop: "queue",
        volume: 150,
        filter: "vaporwave",
        queue: {
          offset: MAX_MUSIC_QUEUE_LENGTH - 1,
          total: 500,
          totalDurationMs: Number.MAX_SAFE_INTEGER,
          tracks: Array.from({ length: MUSIC_QUEUE_PAGE }, worstTrack),
        },
      },
    };
    expect(COMMANDS["music.state"].response.safeParse(snapshot).success).toBe(true);
    expect(EVENTS["music.state"].safeParse(snapshot).success).toBe(true);
    expect(Buffer.byteLength(reply(snapshot))).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(event("music.state", snapshot))).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  test("the largest music.search reply fits in one message", () => {
    const result = {
      status: "ok",
      searchId: ID,
      kind: "playlist",
      name: "\u0001".repeat(MAX_PLAYLIST_NAME_LENGTH),
      total: MAX_MUSIC_PICKS,
      tracks: Array.from({ length: MAX_MUSIC_RESULTS }, worstTrack),
    };
    expect(COMMANDS["music.search"].response.safeParse(result).success).toBe(true);
    expect(Buffer.byteLength(reply(result))).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  test("the largest music.voice_channels reply fits in one message", () => {
    const channel = {
      id: SNOWFLAKE,
      name: "中".repeat(100),
      parentId: SNOWFLAKE,
      listeners: 99_999,
      joinable: false,
    };
    const result = {
      channels: Array.from({ length: MAX_VOICE_CHANNELS }, () => channel),
      truncated: true,
    };
    const { response } = COMMANDS["music.voice_channels"];
    expect(response.safeParse(result).success).toBe(true);
    expect(response.safeParse({ ...result, channels: [...result.channels, channel] }).success).toBe(
      false,
    );
    expect(Buffer.byteLength(reply(result))).toBeLessThan(MAX_MESSAGE_BYTES);
  });
});
