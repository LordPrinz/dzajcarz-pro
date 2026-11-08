/** In-memory ports for the module tests; nothing here talks to Lavalink or Discord. */
import type { StateStorage } from "@dzajcarz/core";
import type {
  DirectMessages,
  LoopMode,
  MusicFilter,
  MusicListener,
  MusicPlayer,
  MusicQuery,
  MusicTrack,
  PanelMessage,
  PanelMessages,
  PlayerState,
  SearchResult,
  VoiceChannels,
} from "./ports.ts";

export function track(title: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: `encoded-${title}`,
    title,
    author: "Autor",
    durationMs: 200_000,
    uri: `https://www.youtube.com/watch?v=${encodeURIComponent(title)}`,
    artworkUrl: "https://i.ytimg.com/vi/x/hqdefault.jpg",
    isStream: false,
    isSeekable: !overrides.isStream,
    requesterId: "200000000000000002",
    ...overrides,
  };
}

interface GuildPlayer {
  voiceChannelId: string;
  textChannelId: string;
  current: MusicTrack | null;
  upcoming: MusicTrack[];
  positionMs: number;
  paused: boolean;
  loop: LoopMode;
  volume: number;
  filter: MusicFilter;
  /** Tracks that played before the current one, newest first. */
  history: MusicTrack[];
}

export interface FakePlayer extends MusicPlayer {
  up: boolean;
  /** What the next `search` returns. */
  nextResult: SearchResult;
  /** Runs while a search is in flight (a member moving channels meanwhile). */
  duringSearch: (() => void) | null;
  readonly shuffles: string[];
  readonly skips: { guildId: string; expectedTrackId: string }[];
  readonly searches: { query: MusicQuery; requesterId: string }[];
  readonly joins: { guildId: string; voiceChannelId: string; textChannelId: string }[];
  readonly players: Map<string, GuildPlayer>;
  /** A skip was sent and the next track has not started yet: jump, previous and seek answer "changed". */
  skipInFlight: boolean;
  /** The current track ends on its own (autoplay of the next one). */
  finishTrack(guildId: string): void;
  /** The bot was kicked from voice or the node dropped the player. */
  destroy(guildId: string): void;
  /** The node could not play the current track; it moves on to the next one. */
  failTrack(guildId: string): void;
  /**
   * The bot plays its own track (a scheduled song) in `voiceChannelId`, with the voice channel as its
   * text channel until a member joins the player.
   */
  playByBot(guildId: string, voiceChannelId: string, title: string): void;
}

export function createFakePlayer(): FakePlayer {
  const listeners = new Set<MusicListener>();
  const players = new Map<string, GuildPlayer>();
  /** Players the bot started; the next member join gives them its text channel. */
  const unclaimed = new Set<string>();

  const emit = (fn: (listener: MusicListener) => void) => {
    for (const listener of listeners) fn(listener);
  };

  function advance(guildId: string, guild: GuildPlayer): void {
    if (guild.current) guild.history.unshift(guild.current);
    const next = guild.upcoming.shift() ?? null;
    guild.current = next;
    guild.positionMs = 0;
    guild.paused = false;
    if (next) emit((listener) => listener.trackStart(guildId, next));
    else emit((listener) => listener.queueEnd(guildId));
  }

  function need(guildId: string): GuildPlayer {
    const guild = players.get(guildId);
    if (!guild) throw new Error(`No player in ${guildId}`);
    return guild;
  }

  const fake: FakePlayer = {
    up: true,
    nextResult: { kind: "tracks", tracks: [track("Pierwszy")] },
    duringSearch: null,
    shuffles: [],
    skips: [],
    searches: [],
    joins: [],
    players,
    skipInFlight: false,
    available: () => fake.up,
    async search(query, requesterId) {
      fake.searches.push({ query, requesterId });
      fake.duringSearch?.();
      return fake.nextResult;
    },
    state(guildId): PlayerState | null {
      const guild = players.get(guildId);
      if (!guild) return null;
      const { history: _history, ...state } = guild;
      return { ...state, upcoming: [...guild.upcoming] };
    },
    async join(guildId, voiceChannelId, textChannelId) {
      fake.joins.push({ guildId, voiceChannelId, textChannelId });
      // Joining waits for Discord, which is where two quick additions used to overlap.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const existing = players.get(guildId);
      if (existing) {
        if (unclaimed.delete(guildId)) existing.textChannelId = textChannelId;
        return;
      }
      players.set(guildId, {
        voiceChannelId,
        textChannelId,
        current: null,
        upcoming: [],
        positionMs: 0,
        paused: false,
        loop: "off",
        volume: 100,
        filter: "off",
        history: [],
      });
    },
    async enqueue(guildId, tracks) {
      const guild = need(guildId);
      guild.upcoming.push(...tracks);
      if (!guild.current) advance(guildId, guild);
    },
    async skip(guildId, expectedTrackId) {
      fake.skips.push({ guildId, expectedTrackId });
      const guild = need(guildId);
      if (guild.current?.id === expectedTrackId) advance(guildId, guild);
    },
    async pause(guildId) {
      need(guildId).paused = true;
    },
    async resume(guildId) {
      need(guildId).paused = false;
    },
    async setLoop(guildId, mode) {
      need(guildId).loop = mode;
    },
    async shuffle(guildId) {
      fake.shuffles.push(guildId);
      need(guildId).upcoming.reverse();
    },
    async seek(guildId, positionMs, expectedTrackId) {
      const guild = need(guildId);
      if (guild.current?.id !== expectedTrackId || fake.skipInFlight) return false;
      if (!guild.current.isSeekable) throw new Error("Current track is not seekable");
      guild.positionMs = positionMs;
      return true;
    },
    async setVolume(guildId, percent) {
      need(guildId).volume = percent;
    },
    async setFilter(guildId, filter) {
      need(guildId).filter = filter;
    },
    async remove(guildId, index, expectedTrackId) {
      const guild = need(guildId);
      if (guild.upcoming[index]?.id !== expectedTrackId) return null;
      return guild.upcoming.splice(index, 1)[0] ?? null;
    },
    async jump(guildId, index, expectedTrackId) {
      const guild = need(guildId);
      if (guild.upcoming[index]?.id !== expectedTrackId || fake.skipInFlight) return false;
      const passed = guild.upcoming.splice(0, index);
      if (guild.loop === "queue") guild.upcoming.push(...passed);
      advance(guildId, guild);
      return true;
    },
    async previous(guildId) {
      const guild = need(guildId);
      if (fake.skipInFlight) return "changed";
      const back = guild.history.shift();
      if (!back) return "none";
      if (guild.current) guild.upcoming.unshift(guild.current);
      guild.current = back;
      guild.positionMs = 0;
      emit((listener) => listener.trackStart(guildId, back));
      return back;
    },
    async clear(guildId) {
      need(guildId).upcoming.length = 0;
    },
    async leave(guildId) {
      fake.destroy(guildId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    finishTrack(guildId) {
      advance(guildId, need(guildId));
    },
    destroy(guildId) {
      unclaimed.delete(guildId);
      if (!players.delete(guildId)) return;
      emit((listener) => listener.playerDestroyed(guildId));
    },
    failTrack(guildId) {
      const guild = need(guildId);
      const failed = guild.current;
      if (failed) emit((listener) => listener.trackFailed(guildId, failed));
      advance(guildId, guild);
    },
    playByBot(guildId, voiceChannelId, title) {
      const song = track(title, { requesterId: "100000000000000099", byBot: true });
      players.set(guildId, {
        voiceChannelId,
        textChannelId: voiceChannelId,
        current: song,
        upcoming: [],
        positionMs: 0,
        paused: false,
        loop: "off",
        volume: 100,
        filter: "off",
        history: [],
      });
      unclaimed.add(guildId);
      emit((listener) => listener.trackStart(guildId, song));
    },
  };
  return fake;
}

export interface FakeVoice extends VoiceChannels {
  /** userId → voice channel id; every user here counts as a human. */
  readonly members: Map<string, string>;
}

export function createFakeVoice(): FakeVoice {
  const members = new Map<string, string>();
  return {
    members,
    channelOf: async (_guildId, userId) => members.get(userId) ?? null,
    humanCount: async (_guildId, channelId) =>
      [...members.values()].filter((channel) => channel === channelId).length,
  };
}

export interface FakePanels extends PanelMessages {
  /** messageId → what is on it now. */
  readonly messages: Map<string, { channelId: string; message: PanelMessage }>;
  readonly posts: string[];
  readonly edits: string[];
  readonly deletes: string[];
  /** Edits reject with this (a non-"gone" Discord failure) while set. */
  editError: Error | null;
}

export function createFakePanels(): FakePanels {
  const messages = new Map<string, { channelId: string; message: PanelMessage }>();
  let next = 0;
  const panels: FakePanels = {
    messages,
    posts: [],
    edits: [],
    deletes: [],
    editError: null,
    async post(channelId, message) {
      const id = `panel-${++next}`;
      messages.set(id, { channelId, message });
      panels.posts.push(id);
      return id;
    },
    async edit(channelId, messageId, message) {
      if (panels.editError) throw panels.editError;
      if (!messages.has(messageId)) return "gone";
      messages.set(messageId, { channelId, message });
      panels.edits.push(messageId);
      return "edited";
    },
    async delete(_channelId, messageId) {
      messages.delete(messageId);
      panels.deletes.push(messageId);
    },
  };
  return panels;
}

export interface FakeDirectMessages extends DirectMessages {
  /** Direct messages received, oldest first. */
  readonly sent: { userId: string; message: PanelMessage }[];
  /** Direct messages fail (closed DMs) while false. */
  open: boolean;
}

export function createFakeDirectMessages(): FakeDirectMessages {
  const dms: FakeDirectMessages = {
    sent: [],
    open: true,
    async send(userId, message) {
      if (!dms.open) return false;
      dms.sent.push({ userId, message });
      return true;
    },
  };
  return dms;
}

export function createMemoryStorage(): StateStorage {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
  };
}

/** Lets the module's fire-and-forget panel and idle work finish. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
