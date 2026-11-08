import { describe, expect, test } from "bun:test";
import type { Track } from "lavalink-client";
import {
  FAST_RETRIES,
  FAST_RETRY_MS,
  nodeOptions,
  type RawLoadResult,
  type RawTrack,
  rawTracksOf,
  resumePosition,
  retryDelayAfter,
  SLOW_RETRY_MS,
  toIdentifier,
  toMusicTrack,
  toPlayerState,
  toSearchResult,
} from "./mapping.ts";

function raw(title: string, info: Partial<RawTrack["info"]> = {}): RawTrack {
  return {
    encoded: `QAAA-${title}`,
    info: {
      identifier: title,
      title,
      author: "Rick Astley",
      duration: 213_000,
      artworkUrl: "https://i.ytimg.com/vi/x/mqdefault.jpg",
      uri: `https://www.youtube.com/watch?v=${title}`,
      sourceName: "youtube",
      isSeekable: true,
      isStream: false,
      isrc: null,
      ...info,
    },
    pluginInfo: {},
  };
}

/** What lavalink-client's buildTrack makes of a raw track. */
const built = (track: RawTrack, requesterId = "200000000000000002"): Track => ({
  ...track,
  requester: { id: requesterId },
});

describe("nodeOptions", () => {
  test("reads host, port and TLS from the URL", () => {
    expect(nodeOptions("http://localhost:2333", "pw")).toMatchObject({
      host: "localhost",
      port: 2333,
      secure: false,
      authorization: "pw",
      retryAmount: Number.MAX_SAFE_INTEGER,
      retryDelay: FAST_RETRY_MS,
    });
    expect(nodeOptions("https://lava.example.com", "pw")).toMatchObject({
      port: 443,
      secure: true,
    });
    expect(nodeOptions("http://lava.example.com", "pw").port).toBe(80);
  });
});

describe("reconnecting", () => {
  test("retries fast for about a minute, then every 30 s forever", () => {
    expect(retryDelayAfter(0)).toBe(FAST_RETRY_MS);
    expect(retryDelayAfter(FAST_RETRIES - 1)).toBe(FAST_RETRY_MS);
    expect(retryDelayAfter(FAST_RETRIES)).toBe(SLOW_RETRY_MS);
    expect(retryDelayAfter(10_000)).toBe(SLOW_RETRY_MS);
    expect(FAST_RETRIES * FAST_RETRY_MS).toBe(60_000);
  });

  test("a track resumes where it was unless it would have ended", () => {
    const song = { duration: 213_000, isStream: false };
    expect(resumePosition(song, 60_000)).toBe(60_000);
    expect(resumePosition(song, -5)).toBe(0);
    expect(resumePosition(song, 213_000)).toBeNull();
    expect(resumePosition(song, 500_000)).toBeNull();
    expect(resumePosition({ duration: 0, isStream: true }, 500_000)).toBe(0);
  });
});

describe("toIdentifier", () => {
  test("links go as they are, everything else is a YouTube search", () => {
    expect(toIdentifier({ kind: "url", url: "https://youtu.be/x" })).toBe("https://youtu.be/x");
    expect(toIdentifier({ kind: "search", text: "lofi" })).toBe("ytsearch:lofi");
    // A source prefix or a path typed by a member stays search text behind ytsearch:.
    expect(toIdentifier({ kind: "search", text: "local:/etc/passwd" })).toBe(
      "ytsearch:local:/etc/passwd",
    );
    expect(toIdentifier({ kind: "search", text: "https://x.example a b" })).toBe(
      "ytsearch:https://x.example a b",
    );
  });
});

describe("toSearchResult", () => {
  const mapped = (result: RawLoadResult) =>
    toSearchResult(
      result,
      rawTracksOf(result).map((track) => toMusicTrack(built(track))),
    );

  test("a single track, a search and a playlist", () => {
    expect(mapped({ loadType: "track", data: raw("a") })).toMatchObject({
      kind: "tracks",
      tracks: [{ title: "a" }],
    });
    expect(mapped({ loadType: "search", data: [raw("a"), raw("b")] })).toMatchObject({
      kind: "tracks",
      tracks: [{ title: "a" }, { title: "b" }],
    });
    expect(
      mapped({ loadType: "playlist", data: { info: { name: "Mix" }, tracks: [raw("a")] } }),
    ).toMatchObject({ kind: "playlist", name: "Mix", tracks: [{ title: "a" }] });
  });

  test("empty, error and tracks that cannot be played", () => {
    expect(mapped({ loadType: "empty" })).toEqual({ kind: "empty" });
    expect(mapped({ loadType: "search", data: [] })).toEqual({ kind: "empty" });
    expect(mapped({ loadType: "error", data: { message: "This video is unavailable" } })).toEqual({
      kind: "error",
      message: "This video is unavailable",
    });
    const unplayable = { ...raw("a"), encoded: "" };
    expect(mapped({ loadType: "track", data: unplayable })).toEqual({ kind: "empty" });
    expect(
      mapped({ loadType: "playlist", data: { info: { name: "Mix" }, tracks: [unplayable] } }),
    ).toEqual({ kind: "empty" });
  });
});

describe("toMusicTrack", () => {
  test("keeps what the module shows and the requester id", () => {
    expect(toMusicTrack(built(raw("dQw4w9WgXcQ")))).toEqual({
      id: "QAAA-dQw4w9WgXcQ",
      title: "dQw4w9WgXcQ",
      author: "Rick Astley",
      durationMs: 213_000,
      uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      artworkUrl: "https://i.ytimg.com/vi/x/mqdefault.jpg",
      isStream: false,
      requesterId: "200000000000000002",
    });
  });

  test("a stream has no duration", () => {
    const stream = toMusicTrack(built(raw("live", { isStream: true, duration: 9_999_999 })));
    expect(stream).toMatchObject({ isStream: true, durationMs: 0 });
  });
});

describe("toPlayerState", () => {
  test("maps the player and its queue", () => {
    const state = toPlayerState(
      {
        voiceChannelId: "400000000000000004",
        textChannelId: "300000000000000003",
        playing: true,
        paused: false,
        position: 12_345,
        volume: 80,
        repeatMode: "queue",
        queue: { current: built(raw("a")), tracks: [built(raw("b"))] },
      },
      "nightcore",
    );
    expect(state).toMatchObject({
      voiceChannelId: "400000000000000004",
      textChannelId: "300000000000000003",
      current: { title: "a" },
      upcoming: [{ title: "b" }],
      positionMs: 12_345,
      paused: false,
      loop: "queue",
      volume: 80,
      filter: "nightcore",
    });
  });

  test("no position without a track, no state without a channel", () => {
    const base = {
      textChannelId: null,
      playing: false,
      paused: false,
      position: 5000,
      volume: 50,
      repeatMode: "off" as const,
      queue: { current: null, tracks: [] },
    };
    expect(toPlayerState({ ...base, voiceChannelId: "4" }, "off")?.positionMs).toBe(0);
    expect(toPlayerState({ ...base, voiceChannelId: null }, "off")).toBeNull();
  });
});
