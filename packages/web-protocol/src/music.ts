import { z } from "zod";
import { Snowflake } from "./snowflake.ts";

/** Upcoming tracks in one `music.state` answer or event; the panel pages through the rest. */
export const MUSIC_QUEUE_PAGE = 20;
/** Search results shown at once; a playlist shows its first ones and can be added whole. */
export const MAX_MUSIC_RESULTS = 20;
/** Tracks one `music.enqueue` may add: a playlist's worth, as `/play` takes. */
export const MAX_MUSIC_PICKS = 100;
/**
 * The player's queue cap, current track included: `MAX_QUEUE_LENGTH` of the music module, which this package
 * cannot import (a bot test keeps the two equal). Queue places and offsets stay below it.
 */
export const MAX_MUSIC_QUEUE_LENGTH = 500;
/** Voice channels in one `music.voice_channels` answer. */
export const MAX_VOICE_CHANNELS = 50;
export const MAX_MUSIC_QUERY_LENGTH = 200;
export const MAX_TRACK_TITLE_LENGTH = 150;
export const MAX_TRACK_AUTHOR_LENGTH = 80;
export const MAX_TRACK_URI_LENGTH = 512;
export const MAX_PLAYLIST_NAME_LENGTH = 100;
/** Same range as `/volume`. */
export const MAX_MUSIC_VOLUME = 150;
/**
 * Joining voice, searching YouTube and loading a playlist can take longer than the panel's usual wait; these
 * commands get this long instead (under the 30 s deadline limit).
 */
export const SLOW_MUSIC_TIMEOUT_MS = 15_000;

export const LOOP_MODES = ["off", "track", "queue"] as const;
export const MUSIC_FILTERS = ["off", "bassboost", "nightcore", "vaporwave", "8d"] as const;

/** A track names itself to the panel by this short hash of the player's own id, which can be kilobytes. */
export const TrackKey = z.string().regex(/^[0-9a-f]{1,16}$/);

/** The short key of a player track id; both sides compute it the same way. */
export function trackKey(id: string): string {
  return Bun.hash(id).toString(16);
}

export const MusicTrackInfo = z.object({
  key: TrackKey,
  title: z.string().max(MAX_TRACK_TITLE_LENGTH),
  author: z.string().max(MAX_TRACK_AUTHOR_LENGTH),
  /** 0 for a stream. */
  durationMs: z.number().int().nonnegative(),
  /** Only an https link; anything else is left out. */
  uri: z
    .url({ protocol: /^https$/ })
    .max(MAX_TRACK_URI_LENGTH)
    .nullable(),
  requesterId: Snowflake,
  /** The bot's own song (the scheduled one): members cannot pause or skip it, the panel can. */
  byBot: z.boolean(),
  isStream: z.boolean(),
  isSeekable: z.boolean(),
});
export type MusicTrackInfo = z.infer<typeof MusicTrackInfo>;

/** What the panel needs of a player track, cut to the limits above. */
export interface MusicTrackSource {
  id: string;
  title: string;
  author: string;
  durationMs: number;
  uri: string | null;
  requesterId: string;
  byBot?: boolean;
  isStream: boolean;
  isSeekable: boolean;
}

const httpsUri = (uri: string | null): string | null => {
  if (uri === null || uri.length > MAX_TRACK_URI_LENGTH) return null;
  try {
    const url = new URL(uri);
    return url.protocol === "https:" && url.href.length <= MAX_TRACK_URI_LENGTH ? url.href : null;
  } catch {
    return null;
  }
};

/** Cuts at a code point, never between the halves of a surrogate pair. */
const cut = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
};

export function toMusicTrackInfo(track: MusicTrackSource): MusicTrackInfo {
  return {
    key: trackKey(track.id),
    title: cut(track.title, MAX_TRACK_TITLE_LENGTH),
    author: cut(track.author, MAX_TRACK_AUTHOR_LENGTH),
    durationMs: Math.max(0, Math.round(track.durationMs)),
    uri: httpsUri(track.uri),
    requesterId: track.requesterId,
    byBot: track.byBot === true,
    isStream: track.isStream,
    isSeekable: track.isSeekable,
  };
}

export const MusicPlayerInfo = z.object({
  voiceChannelId: Snowflake,
  current: MusicTrackInfo.nullable(),
  /** At `MusicSnapshot.at`; the panel moves it on itself while playing. */
  positionMs: z.number().int().nonnegative(),
  paused: z.boolean(),
  loop: z.enum(LOOP_MODES),
  volume: z.number().int().min(0).max(1000),
  filter: z.enum(MUSIC_FILTERS),
  queue: z.object({
    /** Where `tracks` starts among the upcoming tracks. */
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    tracks: z.array(MusicTrackInfo).max(MUSIC_QUEUE_PAGE),
  }),
});
export type MusicPlayerInfo = z.infer<typeof MusicPlayerInfo>;

/** A guild's player as the panel sees it; `player` is null while the bot is not in voice there. */
export const MusicSnapshot = z.object({
  guildId: Snowflake,
  /** False while no Lavalink node is connected: every control is refused. */
  available: z.boolean(),
  /** When the bot read the state. */
  at: z.iso.datetime(),
  player: MusicPlayerInfo.nullable(),
});
export type MusicSnapshot = z.infer<typeof MusicSnapshot>;

export const VoiceChannelInfo = z.object({
  id: Snowflake,
  name: z.string().max(100),
  parentId: Snowflake.nullable(),
  /** People in it, bots left out. */
  listeners: z.number().int().nonnegative(),
  /** The bot may connect and speak there, and it is not full. */
  joinable: z.boolean(),
});
export type VoiceChannelInfo = z.infer<typeof VoiceChannelInfo>;

/** Why the bot did not do what the panel asked; the panel shows each in Polish. */
export const MUSIC_REJECTIONS = [
  /** No Lavalink node is connected. */
  "unavailable",
  /** The bot is not in voice in that server. */
  "no_player",
  "nothing_playing",
  /** Not a voice channel of that server, or the bot cannot see it. */
  "unknown_channel",
  /** The bot may not connect or speak there, or the channel is full. */
  "no_connect",
  /** The queue moved since the panel read it. */
  "queue_changed",
  /** Another track plays by now, or a skip is on its way. */
  "track_changed",
  "not_seekable",
  "past_end",
  "queue_full",
  /** The search is older than the bot keeps results, or was never made there. */
  "search_expired",
  "unsupported_link",
  "not_found",
  "load_failed",
  /** `music.enqueue` named a channel, but the bot plays in another one there; move it first. */
  "other_channel",
  /** Two searches for that server are still running. */
  "search_busy",
  /** Shuffle needs two tracks waiting. */
  "too_few_tracks",
  "empty_queue",
] as const;
export type MusicRejection = (typeof MUSIC_REJECTIONS)[number];

const Rejected = z.object({ status: z.literal("rejected"), reason: z.enum(MUSIC_REJECTIONS) });
const DoneOrRejected = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }),
  Rejected,
]);
const GuildOnly = z.object({ guildId: Snowflake }).strict();
const QueueIndex = z
  .number()
  .int()
  .min(0)
  .max(MAX_MUSIC_QUEUE_LENGTH - 1);

/** One control of `music.control`. */
export const MusicControl = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
  /** Skips the current track if it still is `key`. */
  z.object({ action: z.literal("skip"), key: TrackKey }).strict(),
  z
    .object({
      action: z.literal("seek"),
      key: TrackKey,
      positionMs: z
        .number()
        .int()
        .min(0)
        .max(100 * 3_600_000),
    })
    .strict(),
  z.object({ action: z.literal("loop"), mode: z.enum(LOOP_MODES) }).strict(),
  z
    .object({ action: z.literal("volume"), percent: z.number().int().min(0).max(MAX_MUSIC_VOLUME) })
    .strict(),
  z.object({ action: z.literal("filter"), filter: z.enum(MUSIC_FILTERS) }).strict(),
  /** Stops, clears the queue and leaves voice. */
  z.object({ action: z.literal("disconnect") }).strict(),
]);
export type MusicControl = z.infer<typeof MusicControl>;

export const MusicSearchResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    /** Names the results for `music.enqueue`; the bot keeps them for a while. */
    searchId: z.uuid(),
    kind: z.enum(["tracks", "playlist"]),
    /** The playlist's name; null for search results. */
    name: z.string().max(MAX_PLAYLIST_NAME_LENGTH).nullable(),
    /** How many tracks can be picked (a playlist keeps at most `MAX_MUSIC_PICKS`). */
    total: z.number().int().nonnegative().max(MAX_MUSIC_PICKS),
    /** The first ones, to show. */
    tracks: z.array(MusicTrackInfo).max(MAX_MUSIC_RESULTS),
  }),
  Rejected,
]);
export type MusicSearchResult = z.infer<typeof MusicSearchResult>;

/** The music commands (#148). Every one acts as the owner: no voice channel check, no song lock. */
export const MUSIC_COMMANDS = {
  /** The guild's player, with one page of the queue from `offset`. */
  "music.state": {
    request: z.object({ guildId: Snowflake, offset: QueueIndex }).strict(),
    response: MusicSnapshot,
  },
  /** The server's voice channels; null when the bot is not in the server. */
  "music.voice_channels": {
    request: GuildOnly,
    response: z
      .object({
        channels: z.array(VoiceChannelInfo).max(MAX_VOICE_CHANNELS),
        truncated: z.boolean(),
      })
      .nullable(),
  },
  /** Joins the channel, or moves the bot there from another one even while people listen. */
  "music.join": {
    request: z.object({ guildId: Snowflake, channelId: Snowflake }).strict(),
    response: DoneOrRejected,
  },
  /** Searches YouTube, or loads a link (the hosts `/play` accepts). */
  "music.search": {
    request: z
      .object({
        guildId: Snowflake,
        query: z.string().trim().min(1).max(MAX_MUSIC_QUERY_LENGTH),
      })
      .strict(),
    response: MusicSearchResult,
  },
  /**
   * Adds picked results of a search to the queue. Without a player the bot first joins `channelId`;
   * an existing player stays where it is.
   */
  "music.enqueue": {
    request: z
      .object({
        guildId: Snowflake,
        searchId: z.uuid(),
        picks: z
          .array(
            z
              .number()
              .int()
              .min(0)
              .max(MAX_MUSIC_PICKS - 1),
          )
          .min(1)
          .max(MAX_MUSIC_PICKS),
        channelId: Snowflake.optional(),
      })
      .strict(),
    response: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("ok"),
        added: z.number().int().nonnegative(),
        /** Left out because the queue is full. */
        skipped: z.number().int().nonnegative(),
      }),
      Rejected,
    ]),
  },
  /** Removes `upcoming[index]` if it still is `key`. */
  "music.queue.remove": {
    request: z.object({ guildId: Snowflake, index: QueueIndex, key: TrackKey }).strict(),
    response: DoneOrRejected,
  },
  /** Moves `upcoming[from]` to place `to` if it still is `key`. */
  "music.queue.move": {
    request: z
      .object({ guildId: Snowflake, from: QueueIndex, to: QueueIndex, key: TrackKey })
      .strict(),
    response: DoneOrRejected,
  },
  "music.queue.shuffle": { request: GuildOnly, response: DoneOrRejected },
  "music.queue.clear": { request: GuildOnly, response: DoneOrRejected },
  "music.control": {
    request: z.object({ guildId: Snowflake, control: MusicControl }).strict(),
    response: DoneOrRejected,
  },
} as const;

/** The music events: a guild's player after a change, and whether the node is there at all. */
export const MUSIC_EVENTS = {
  "music.state": MusicSnapshot,
  "music.status": z.object({ available: z.boolean() }),
} as const;
