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
  /** False for a stream and for sources that cannot jump to a position. */
  isSeekable: boolean;
  /** Member who added it. */
  requesterId: string;
  /**
   * Queued by the bot itself (a scheduled song), not by a member: it gets no now playing panel and no
   * failure note.
   */
  byBot?: true;
}

export type SearchResult =
  | { kind: "tracks"; tracks: MusicTrack[] }
  | { kind: "playlist"; name: string; tracks: MusicTrack[] }
  | { kind: "empty" }
  /** The source refused (video unavailable, region lock…); `message` is for the log, not for users. */
  | { kind: "error"; message: string };

/** What repeats: nothing, the current track, or the whole queue. */
export type LoopMode = "off" | "track" | "queue";

/** Sound effects the player can apply; one at a time. */
export type MusicFilter = "off" | "bassboost" | "nightcore" | "vaporwave" | "8d";

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
  loop: LoopMode;
  /** Percent; 100 is the source's own level, and the level a new player starts at. */
  volume: number;
  filter: MusicFilter;
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
  /**
   * Creates the guild's player in the voice channel, or keeps the existing one. A player the bot started
   * on its own (a scheduled song) takes `textChannelId` as its panel channel the first time a member joins
   * it this way.
   */
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
  setLoop(guildId: string, mode: LoopMode): Promise<void>;
  /** Shuffles the upcoming tracks; the current one stays. */
  shuffle(guildId: string): Promise<void>;
  /**
   * Moves the current track to `positionMs` (the track's length itself is allowed and ends it) if it still is
   * `expectedTrackId`; false when another track plays by now or a skip is on its way. Rejects for a track
   * that is not seekable.
   */
  seek(guildId: string, positionMs: number, expectedTrackId: string): Promise<boolean>;
  /** `percent` is 0 to 150. */
  setVolume(guildId: string, percent: number): Promise<void>;
  /** Replaces the active filter (`off` clears it); setting the active one again changes nothing. */
  setFilter(guildId: string, filter: MusicFilter): Promise<void>;
  /**
   * Removes `upcoming[index]` (zero-based) if it still is `expectedTrackId`; returns it, or null when that
   * place holds another track by now.
   */
  remove(guildId: string, index: number, expectedTrackId: string): Promise<MusicTrack | null>;
  /**
   * Plays `upcoming[index]` now, if it still is `expectedTrackId`. The tracks before it are dropped, or with
   * the queue loop moved to the end of the queue. False when that place holds another track by now or a skip
   * is on its way.
   */
  jump(guildId: string, index: number, expectedTrackId: string): Promise<boolean>;
  /**
   * Plays the previously played track again; the current one goes back to the front of the queue. Copies of
   * the current track in the history (the track loop) are passed over. `"none"` when there is no previous
   * track, `"changed"` while a skip is on its way.
   */
  previous(guildId: string): Promise<MusicTrack | "none" | "changed">;
  /** Empties the upcoming tracks; the current one keeps playing. */
  clear(guildId: string): Promise<void>;
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

/** Direct messages to members. */
export interface DirectMessages {
  /** False when the member's DMs are closed to the bot. Rejects on other failures. */
  send(userId: string, message: PanelMessage): Promise<boolean>;
}

/** A panel is a normal reply without `ephemeral`. */
export type PanelMessage = Exclude<Reply, string>;
