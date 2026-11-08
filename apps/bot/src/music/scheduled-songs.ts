/** The only audio files the bot plays from Lavalink's `local` source (ADR 4). Never built from member input. */
import type { ScheduledSong } from "@dzajcarz/module-schedule";

/** Where docker-compose mounts `infra/lavalink/music` inside the Lavalink container. */
export const LAVALINK_MUSIC_DIR = "/opt/Lavalink/music";

interface ScheduledSongFile extends ScheduledSong {
  /** File name inside `infra/lavalink/music`. */
  file: string;
}

/** The first entry is the default song. */
export const SCHEDULED_SONG_FILES = [
  { name: "lato_z_radiem", title: "Lato z Radiem", file: "lato_z_radiem.mp3" },
  { name: "icona_pop", title: "Icona Pop - I Love It", file: "icona_pop.mp3" },
] as const satisfies readonly ScheduledSongFile[];

/** What the schedule module may offer to servers. */
export const SCHEDULED_SONGS: readonly [ScheduledSong, ...ScheduledSong[]] = [
  { name: SCHEDULED_SONG_FILES[0].name, title: SCHEDULED_SONG_FILES[0].title },
  { name: SCHEDULED_SONG_FILES[1].name, title: SCHEDULED_SONG_FILES[1].title },
];

/** The node-side path of a listed song; undefined for any name that is not in the list. */
export function scheduledSongPath(name: string): string | undefined {
  const song = SCHEDULED_SONG_FILES.find((entry) => entry.name === name);
  return song && `${LAVALINK_MUSIC_DIR}/${song.file}`;
}
