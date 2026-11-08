/** `ScheduledSongPlayer` on top of the Lavalink player: song names in, files from the fixed list out. */
import type { ScheduledSongPlayer } from "@dzajcarz/module-schedule";
import type { LavalinkMusicPlayer } from "./lavalink.ts";
import { scheduledSongPath } from "./scheduled-songs.ts";

export function createScheduledSongPlayer(
  music: LavalinkMusicPlayer,
  pathOf: (song: string) => string | undefined = scheduledSongPath,
): ScheduledSongPlayer {
  return {
    available: () => music.available(),
    isPlaying: (guildId) => music.isPlaying(guildId),
    async play(guildId, voiceChannelId, song) {
      const file = pathOf(song);
      if (file === undefined) throw new Error(`"${song}" is not a scheduled song`);
      return music.playLocalFile(guildId, voiceChannelId, file);
    },
    leave: (guildId) => music.leave(guildId),
  };
}
