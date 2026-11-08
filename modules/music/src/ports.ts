import type { Reply } from "@dzajcarz/core";

/** What the music module needs from the outside world. apps/bot implements these around Lavalink and Discord. */

/** What a member asked for: a link, or words to search YouTube with. Never a raw Lavalink identifier. */
export type MusicQuery = { kind: "url"; url: string } | { kind: "search"; text: string };

export interface MusicTrack {
  /** Opaque handle the player uses to play the track again (Lavalink's encoded track). */
  id: string;
  title: string;
  author: string;
  /** 0 for a live stream. */
  durationMs: number;
  /** Link to the track's page; null when the source has none. */
  uri: string | null;
  artworkUrl: string | null;
  isStream: boolean;
  /** Member who added it. */
  requesterId: string;
}

export type SearchResult =
  | { kind: "tracks"; tracks: MusicTrack[] }
  | { kind: "playlist"; name: string; tracks: MusicTrack[] }
  | { kind: "empty" }
  /** The source refused (video unavailable, region lock…); `message` is for the log, not for users. */
  | { kind: "error"; message: string };

/** A guild's player as the module sees it. */
export interface PlayerState {
  voiceChannelId: string;
  /** Where music was started; the now playing panel lives there. */
  textChannelId: string;
  /** Null between tracks and after the queue ran out. */
  current: MusicTrack | null;
  /** Tracks after the current one, in order. */
  upcoming: readonly MusicTrack[];
  positionMs: number;
  paused: boolean;
}

export interface MusicListener {
  trackStart(guildId: string, track: MusicTrack): void;
  /** The last track ended and nothing is queued; the player stays in the channel. */
  queueEnd(guildId: string): void;
  /** The player is gone (left, kicked from the channel, shut down); the bot is no longer in voice there. */
  playerDestroyed(guildId: string): void;
  /** A track could not be played (load failure, stuck stream); the player moves on by itself. */
  trackFailed(guildId: string, track: MusicTrack): void;
}

/**
 * Audio playback, one player per guild. Every method except `available`, `state`, `leave` and `subscribe`
 * rejects when no audio node is reachable, so callers check `available()` first. `leave` works without a
 * node: the bot still leaves voice and the player is dropped.
 */
export interface MusicPlayer {
  /** False while no audio node is connected (not configured, down, restarting). */
  available(): boolean;
  search(query: MusicQuery, requesterId: string): Promise<SearchResult>;
  /** Null when the bot has no player in the guild. */
  state(guildId: string): PlayerState | null;
  /** Creates the guild's player in the voice channel, or keeps the existing one. */
  join(guildId: string, voiceChannelId: string, textChannelId: string): Promise<void>;
  /** Appends to the queue and starts playing when nothing is. */
  enqueue(guildId: string, tracks: readonly MusicTrack[]): Promise<void>;
  /**
   * Ends the current track if it is still `expectedTrackId` (a `MusicTrack.id`) and was not skipped already;
   * with an empty queue that ends the queue. Two quick skips of the same track skip it once.
   */
  skip(guildId: string, expectedTrackId: string): Promise<void>;
  pause(guildId: string): Promise<void>;
  resume(guildId: string): Promise<void>;
  /** Stops playback, clears the queue and leaves the voice channel. */
  leave(guildId: string): Promise<void>;
  /** Returns a function that removes the listener. */
  subscribe(listener: MusicListener): () => void;
}

/** Who sits in which voice channel, from the gateway's voice states. */
export interface VoiceChannels {
  /** The voice channel the member is in, or null. */
  channelOf(guildId: string, userId: string): Promise<string | null>;
  /** People in the channel, bots excluded. */
  humanCount(guildId: string, channelId: string): Promise<number>;
}

/**
 * Messages of the now playing panel, and short notes in its channel. Every method rejects when Discord
 * refuses.
 */
export interface PanelMessages {
  /** Posts the message and returns its id. */
  post(channelId: string, message: PanelMessage): Promise<string>;
  /** "gone" when the message or its channel no longer exists, so the caller posts a new one. */
  edit(channelId: string, messageId: string, message: PanelMessage): Promise<"edited" | "gone">;
  /** A message that is already gone counts as deleted. */
  delete(channelId: string, messageId: string): Promise<void>;
}

/** A panel is a normal reply without `ephemeral`. */
export type PanelMessage = Exclude<Reply, string>;
