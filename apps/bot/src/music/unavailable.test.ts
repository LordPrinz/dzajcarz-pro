import { describe, expect, test } from "bun:test";
import { createUnavailableMusicPlayer } from "./unavailable.ts";

describe("music player without Lavalink", () => {
  test("playback calls reject with the reason", async () => {
    await expect(createUnavailableMusicPlayer().join("g", "v", "t")).rejects.toThrow(
      "Music is not configured (LAVALINK_URL)",
    );
  });

  test("leave works, as the port promises for a missing node", async () => {
    await expect(createUnavailableMusicPlayer().leave("g")).resolves.toBeUndefined();
  });
});
