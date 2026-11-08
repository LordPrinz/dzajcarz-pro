import { describe, expect, test } from "bun:test";
import type { LavalinkMusicPlayer } from "./lavalink.ts";
import { createScheduledSongPlayer } from "./scheduled.ts";
import { LAVALINK_MUSIC_DIR, SCHEDULED_SONG_FILES, scheduledSongPath } from "./scheduled-songs.ts";

function fakeMusic(current: object | null = null) {
  const plays: string[][] = [];
  const music = {
    available: () => true,
    state: () => (current ? { current } : null),
    playLocalFile: async (guildId: string, channelId: string, file: string) => {
      plays.push([guildId, channelId, file]);
      return { queued: false };
    },
    leave: async () => {},
  } as unknown as LavalinkMusicPlayer;
  return { music, plays };
}

describe("scheduled song player", () => {
  test("plays a listed song by its file path", async () => {
    const { music, plays } = fakeMusic();
    const player = createScheduledSongPlayer(music);
    await player.play("g", "c", "lato_z_radiem");
    expect(plays).toEqual([["g", "c", `${LAVALINK_MUSIC_DIR}/lato_z_radiem.mp3`]]);
  });

  test("refuses a name that is not in the list, including paths and local identifiers", async () => {
    const { music, plays } = fakeMusic();
    const player = createScheduledSongPlayer(music);
    for (const name of [
      "local:/etc/passwd",
      "/etc/passwd",
      "../lato_z_radiem",
      "lato_z_radiem.mp3",
    ]) {
      await expect(player.play("g", "c", name)).rejects.toThrow("not a scheduled song");
    }
    expect(plays).toEqual([]);
  });

  test("music is playing only while a track is current", () => {
    expect(createScheduledSongPlayer(fakeMusic({}).music).isPlaying("g")).toBe(true);
    expect(createScheduledSongPlayer(fakeMusic(null).music).isPlaying("g")).toBe(false);
  });

  test("every listed file name stays inside the music directory", () => {
    for (const { name, file } of SCHEDULED_SONG_FILES) {
      expect(file).toMatch(/^[a-z0-9_]+\.mp3$/);
      expect(scheduledSongPath(name)).toBe(`${LAVALINK_MUSIC_DIR}/${file}`);
    }
  });
});
