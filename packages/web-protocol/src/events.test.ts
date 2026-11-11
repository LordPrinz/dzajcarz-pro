import { describe, expect, test } from "bun:test";
import { BOT_OFFLINE_AFTER_MS, isBotOnline } from "./events.ts";

describe("isBotOnline", () => {
  test("is online while the last heartbeat is younger than 45 s", () => {
    expect(isBotOnline(1_000, 1_000 + 44_900)).toBe(true);
  });

  test("is offline at 45 s", () => {
    expect(BOT_OFFLINE_AFTER_MS).toBe(45_000);
    expect(isBotOnline(1_000, 1_000 + 45_000)).toBe(false);
  });

  test("is offline with no heartbeat", () => {
    expect(isBotOnline(null, 1_000)).toBe(false);
  });
});
