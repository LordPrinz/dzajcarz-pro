/** Pure translations between lavalink-client objects and the music module's port types. */
import type { MusicQuery, MusicTrack, PlayerState, SearchResult } from "@dzajcarz/module-music";
import type { LavalinkNodeOptions, Track, UnresolvedTrack } from "lavalink-client";

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
    // A restarted node is back within seconds; this covers about a minute of downtime (spike DZAJ-10).
    retryAmount: 20,
    retryDelay: 3000,
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
    (track) => typeof track?.encoded === "string" && track.encoded !== "" && track.info,
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

/** The slice of a lavalink-client Player the state needs. */
export interface PlayerLike {
  voiceChannelId: string | null;
  textChannelId: string | null;
  playing: boolean;
  paused: boolean;
  position: number;
  queue: { current: Track | null; tracks: (Track | UnresolvedTrack)[] };
}

export function toPlayerState(player: PlayerLike): PlayerState | null {
  if (!player.voiceChannelId) return null;
  const current = player.queue.current;
  return {
    voiceChannelId: player.voiceChannelId,
    textChannelId: player.textChannelId ?? "",
    current: current ? toMusicTrack(current) : null,
    upcoming: player.queue.tracks.map(toMusicTrack),
    positionMs: current ? Math.max(0, player.position) : 0,
    paused: player.paused,
  };
}
