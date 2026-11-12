import { describe, expect, test } from "bun:test";
import { formatTime, type MusicPlayerInfo, positionAt } from "./music-api.ts";

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
