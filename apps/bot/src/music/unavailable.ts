import type { LavalinkMusicPlayer } from "./lavalink.ts";

/** The player when no Lavalink node is configured: music commands answer that music is unavailable. */
export function createUnavailableMusicPlayer(): LavalinkMusicPlayer {
  const unavailable = async (): Promise<never> => {
    throw new Error("Music is not configured (LAVALINK_URL)");
  };
  return {
    available: () => false,
    search: unavailable,
    state: () => null,
    join: unavailable,
    playLocalFile: unavailable,
    enqueue: unavailable,
    skip: unavailable,
    pause: unavailable,
    resume: unavailable,
    leave: unavailable,
    subscribe: () => () => {},
    destroy: async () => {},
  };
}
