/** In-memory ports for the module tests; nothing here talks to Lavalink or Discord. */
import type { StateStorage } from "@dzajcarz/core";
import type {
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
}

export interface FakePlayer extends MusicPlayer {
  up: boolean;
  /** What the next `search` returns. */
  nextResult: SearchResult;
  readonly searches: { query: MusicQuery; requesterId: string }[];
  readonly joins: { guildId: string; voiceChannelId: string; textChannelId: string }[];
  readonly players: Map<string, GuildPlayer>;
  /** The current track ends on its own (autoplay of the next one). */
  finishTrack(guildId: string): void;
  /** The bot was kicked from voice or the node dropped the player. */
  destroy(guildId: string): void;
}

export function createFakePlayer(): FakePlayer {
  const listeners = new Set<MusicListener>();
  const players = new Map<string, GuildPlayer>();

  const emit = (fn: (listener: MusicListener) => void) => {
    for (const listener of listeners) fn(listener);
  };

  function advance(guildId: string, guild: GuildPlayer): void {
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
    searches: [],
    joins: [],
    players,
    available: () => fake.up,
    async search(query, requesterId) {
      fake.searches.push({ query, requesterId });
      return fake.nextResult;
    },
    state(guildId): PlayerState | null {
      const guild = players.get(guildId);
      return guild ? { ...guild, upcoming: [...guild.upcoming] } : null;
    },
    async join(guildId, voiceChannelId, textChannelId) {
      fake.joins.push({ guildId, voiceChannelId, textChannelId });
      if (players.has(guildId)) return;
      players.set(guildId, {
        voiceChannelId,
        textChannelId,
        current: null,
        upcoming: [],
        positionMs: 0,
        paused: false,
      });
    },
    async enqueue(guildId, tracks) {
      const guild = need(guildId);
      guild.upcoming.push(...tracks);
      if (!guild.current) advance(guildId, guild);
    },
    async skip(guildId) {
      advance(guildId, need(guildId));
    },
    async pause(guildId) {
      need(guildId).paused = true;
    },
    async resume(guildId) {
      need(guildId).paused = false;
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
      if (!players.delete(guildId)) return;
      emit((listener) => listener.playerDestroyed(guildId));
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
}

export function createFakePanels(): FakePanels {
  const messages = new Map<string, { channelId: string; message: PanelMessage }>();
  let next = 0;
  const panels: FakePanels = {
    messages,
    posts: [],
    edits: [],
    deletes: [],
    async post(channelId, message) {
      const id = `panel-${++next}`;
      messages.set(id, { channelId, message });
      panels.posts.push(id);
      return id;
    },
    async edit(channelId, messageId, message) {
      if (!messages.has(messageId)) throw new Error("Unknown Message");
      messages.set(messageId, { channelId, message });
      panels.edits.push(messageId);
    },
    async delete(_channelId, messageId) {
      messages.delete(messageId);
      panels.deletes.push(messageId);
    },
  };
  return panels;
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
