/** Pure translations between lavalink-client objects and the music module's port types. */
import type {
  LoopMode,
  MusicFilter,
  MusicQuery,
  MusicTrack,
  PlayerState,
  SearchResult,
} from "@dzajcarz/module-music";
import type { LavalinkNodeOptions, Track, UnresolvedTrack } from "lavalink-client";

/** A restarted node is back within seconds; fast retries cover about a minute (spike DZAJ-10). */
export const FAST_RETRIES = 20;
export const FAST_RETRY_MS = 3000;
/** After that the node is retried this often, forever: music comes back without a bot restart. */
export const SLOW_RETRY_MS = 30_000;

/** How long to wait before the next reconnect, given how many attempts were made since the drop. */
export function retryDelayAfter(attempts: number): number {
  return attempts >= FAST_RETRIES ? SLOW_RETRY_MS : FAST_RETRY_MS;
}

/** Node options from `LAVALINK_URL` (`http://host:2333`, `https://…` for TLS). */
export function nodeOptions(url: string, password: string): LavalinkNodeOptions {
  const parsed = new URL(url);
  const secure = parsed.protocol === "https:";
  return {
    id: "main",
    host: parsed.hostname,
    port: parsed.port === "" ? (secure ? 443 : 80) : Number(parsed.port),
    authorization: password,
    secure,
    // The client destroys the node and every player once it runs out of attempts, so it never may: the
    // adapter stretches the delay instead (retryDelayAfter).
    retryAmount: Number.MAX_SAFE_INTEGER,
    retryDelay: FAST_RETRY_MS,
  };
}

/**
 * The Lavalink identifier for a query, sent to `/loadtracks` as is. Search text always gets the
 * `ytsearch:` prefix, so whatever the member typed after it (`local:/etc/x`, `scsearch:`, `https://… x`)
 * is only ever search words and never selects a source or a file.
 */
export function toIdentifier(query: MusicQuery): string {
  return query.kind === "url" ? query.url : `ytsearch:${query.text}`;
}

/** A track as Lavalink's REST API returns it. */
export interface RawTrack {
  encoded: string;
  info: Track["info"];
  pluginInfo: Track["pluginInfo"];
}

/** Lavalink 4 `/loadtracks` response. */
export type RawLoadResult =
  | { loadType: "track"; data: RawTrack }
  | { loadType: "playlist"; data: { info?: { name?: string | null }; tracks: RawTrack[] } }
  | { loadType: "search"; data: RawTrack[] }
  | { loadType: "empty"; data?: unknown }
  | { loadType: "error"; data?: { message?: string | null } | null };

/** The playable tracks of a response; tracks without an encoded form cannot be played later. */
export function rawTracksOf(result: RawLoadResult): RawTrack[] {
  const tracks =
    result.loadType === "track"
      ? [result.data]
      : result.loadType === "search"
        ? result.data
        : result.loadType === "playlist"
          ? result.data.tracks
          : [];
  return (Array.isArray(tracks) ? tracks : []).filter(
    (track) =>
      typeof track?.encoded === "string" &&
      track.encoded !== "" &&
      typeof track.info?.title === "string",
  );
}

/** `tracks` are the response's playable tracks, already mapped (`rawTracksOf` → `toMusicTrack`). */
export function toSearchResult(result: RawLoadResult, tracks: MusicTrack[]): SearchResult {
  switch (result.loadType) {
    case "error":
      return { kind: "error", message: result.data?.message ?? "unknown error" };
    case "playlist":
      if (tracks.length === 0) return { kind: "empty" };
      return { kind: "playlist", name: result.data.info?.name || "playlista", tracks };
    case "track":
    case "search":
      return tracks.length === 0 ? { kind: "empty" } : { kind: "tracks", tracks };
    default:
      return { kind: "empty" };
  }
}

interface TrackRequester {
  id?: unknown;
}

function requesterOf(track: Track | UnresolvedTrack): string {
  const requester = track.requester as TrackRequester | undefined;
  return typeof requester?.id === "string" ? requester.id : "";
}

export function toMusicTrack(track: Track | UnresolvedTrack): MusicTrack {
  const { info } = track;
  return {
    id: track.encoded ?? "",
    title: info.title,
    author: info.author ?? "",
    durationMs: info.isStream ? 0 : (info.duration ?? 0),
    uri: info.uri ?? null,
    artworkUrl: info.artworkUrl ?? track.pluginInfo?.artworkUrl ?? null,
    isStream: info.isStream ?? false,
    requesterId: requesterOf(track),
  };
}

/**
 * Where to resume a track after a node restart: the stored position, or null when the track would have
 * ended during the outage (then the next one plays). A stream resumes live, from 0.
 */
export function resumePosition(
  info: Pick<Track["info"], "duration" | "isStream">,
  positionMs: number,
): number | null {
  if (info.isStream) return 0;
  const position = Math.max(0, positionMs);
  return info.duration > 0 && position >= info.duration ? null : position;
}

/** The slice of a lavalink-client Player the state needs. */
export interface PlayerLike {
  voiceChannelId: string | null;
  textChannelId: string | null;
  playing: boolean;
  paused: boolean;
  position: number;
  volume: number;
  repeatMode: LoopMode;
  queue: { current: Track | null; tracks: (Track | UnresolvedTrack)[] };
}

export function toPlayerState(player: PlayerLike, filter: MusicFilter): PlayerState | null {
  if (!player.voiceChannelId) return null;
  const current = player.queue.current;
  return {
    voiceChannelId: player.voiceChannelId,
    textChannelId: player.textChannelId ?? "",
    current: current ? toMusicTrack(current) : null,
    upcoming: player.queue.tracks.map(toMusicTrack),
    positionMs: current ? Math.max(0, player.position) : 0,
    paused: player.paused,
    loop: player.repeatMode,
    volume: player.volume,
    filter,
  };
}
