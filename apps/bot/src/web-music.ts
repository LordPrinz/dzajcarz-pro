/**
 * The music commands and events of the web panel (#148), on the same `MusicPlayer` the music module uses, so
 * both panels always show one state. The panel acts as the owner: it skips the module's member rules (being
 * in the bot's voice channel, the scheduled song's lock from DZAJ-123, which lives in the module and not in
 * the player) and may move the bot to another channel while people listen.
 */
import { type Logger, withTimeout } from "@dzajcarz/core";
import {
  MAX_QUEUE_LENGTH,
  type MusicPlayer,
  type MusicQuery,
  type MusicTrack,
} from "@dzajcarz/module-music";
import {
  type CommandHandlers,
  type CommandName,
  type CommandResponse,
  type EventName,
  type EventPayload,
  MAX_MUSIC_PICKS,
  MAX_MUSIC_RESULTS,
  MAX_PLAYLIST_NAME_LENGTH,
  MUSIC_QUEUE_PAGE,
  type MusicRejection,
  type MusicSnapshot,
  toMusicTrackInfo,
  trackKey,
} from "@dzajcarz/web-protocol";

export type MusicHandlers = Pick<CommandHandlers, Extract<CommandName, `music.${string}`>>;

/** Voice channels as Discord sees them; `apps/bot/src/discord/web-music.ts`. */
export interface VoiceDirectory {
  list(guildId: string): CommandResponse<"music.voice_channels">;
  /** Whether the bot can join `channelId` of the guild. */
  check(guildId: string, channelId: string): "ok" | "unknown_channel" | "no_connect";
}

export interface WebMusicOptions {
  player: MusicPlayer;
  voice: VoiceDirectory;
  /** Tracks the panel adds are the bot's: the owner has no member id here. Null before login. */
  botUserId: () => string | null;
  /** The module's own parser, so the panel accepts the links `/play` accepts and nothing else. */
  parseQuery: (input: string) => MusicQuery | { kind: "unsupported" } | null;
  logger: Logger;
  now?: () => number;
  /** How long search results wait for `music.enqueue`. */
  searchTtlMs?: number;
  /** How long a join or a move may hold the guild's chain; the panel waits 15 s in all. */
  joinTimeoutMs?: number;
}

export const SEARCH_TTL_MS = 10 * 60_000;
/** Searches kept at once; the oldest goes first. */
export const MAX_SEARCHES = 50;
/** Searches running at once per guild: each one is a YouTube lookup through the node. */
export const MAX_SEARCHES_IN_FLIGHT = 2;
/** Under the panel's 15 s wait for a join, so the panel hears the failure. */
export const JOIN_TIMEOUT_MS = 12_000;

interface SavedSearch {
  guildId: string;
  tracks: MusicTrack[];
  expiresAt: number;
}

type Answer = { status: "ok" } | { status: "rejected"; reason: MusicRejection };

const ok = { status: "ok" } as const;
const rejected = (reason: MusicRejection) => ({ status: "rejected", reason }) as const;

/** A guild's player for the panel, with one page of the upcoming tracks from `offset`. */
export function musicSnapshot(
  player: MusicPlayer,
  guildId: string,
  offset = 0,
  now: () => number = Date.now,
): MusicSnapshot {
  const state = player.state(guildId);
  const base = { guildId, available: player.available(), at: new Date(now()).toISOString() };
  if (!state) return { ...base, player: null };
  return {
    ...base,
    player: {
      voiceChannelId: state.voiceChannelId,
      current: state.current ? toMusicTrackInfo(state.current) : null,
      positionMs: Math.max(0, Math.round(state.positionMs)),
      paused: state.paused,
      loop: state.loop,
      volume: Math.round(state.volume),
      filter: state.filter,
      queue: {
        offset,
        total: state.upcoming.length,
        totalDurationMs: state.upcoming.reduce(
          (sum, track) => sum + Math.max(0, Math.round(track.durationMs)),
          0,
        ),
        tracks: state.upcoming.slice(offset, offset + MUSIC_QUEUE_PAGE).map(toMusicTrackInfo),
      },
    },
  };
}

export function createWebMusic({
  player,
  voice,
  botUserId,
  parseQuery,
  logger,
  now = Date.now,
  searchTtlMs = SEARCH_TTL_MS,
  joinTimeoutMs = JOIN_TIMEOUT_MS,
}: WebMusicOptions): MusicHandlers {
  /**
   * Puts the bot in `channelId`: joins, or moves an existing player. A join that never answers (Discord, a
   * stuck recovery) fails after `joinTimeoutMs`, so the commands queued behind it in the chain go on.
   */
  function enterChannel(guildId: string, channelId: string, moving: boolean): Promise<void> {
    const entering = moving
      ? player.moveToChannel(guildId, channelId)
      : // The voice channel's own chat holds the Discord panel for music started from the web.
        player.join(guildId, channelId, channelId);
    return withTimeout(entering, joinTimeoutMs);
  }

  /** Changes run one at a time per guild, each reading the state it acts on inside the chain. */
  const chains = new Map<string, Promise<unknown>>();
  function inChain<T>(guildId: string, task: () => Promise<T>): Promise<T> {
    const result = (chains.get(guildId) ?? Promise.resolve()).then(task);
    const settled = result.catch(() => {});
    chains.set(guildId, settled);
    void settled.then(() => {
      if (chains.get(guildId) === settled) chains.delete(guildId);
    });
    return result;
  }

  const searches = new Map<string, SavedSearch>();
  /** Searches running now, per guild. */
  const searching = new Map<string, number>();
  function keep(search: SavedSearch): string {
    for (const [id, saved] of searches) if (saved.expiresAt <= now()) searches.delete(id);
    while (searches.size >= MAX_SEARCHES) {
      const oldest = searches.keys().next().value;
      if (oldest === undefined) break;
      searches.delete(oldest);
    }
    const id = crypto.randomUUID();
    searches.set(id, search);
    return id;
  }

  /** A change to an existing player; the node must be there. */
  const change = (
    guildId: string,
    task: (state: NonNullable<ReturnType<MusicPlayer["state"]>>) => Promise<Answer>,
  ): Promise<Answer> => {
    if (!player.available()) return Promise.resolve(rejected("unavailable"));
    return inChain(guildId, async () => {
      const state = player.state(guildId);
      return state ? task(state) : rejected("no_player");
    });
  };

  /** Whether `key` still names the track at `index` of the upcoming ones. */
  const isAt = (upcoming: readonly MusicTrack[], index: number, key: string) => {
    const track = upcoming[index];
    return track !== undefined && trackKey(track.id) === key ? track : null;
  };

  return {
    "music.state": async ({ guildId, offset }) => musicSnapshot(player, guildId, offset, now),

    "music.voice_channels": async ({ guildId }) => voice.list(guildId),

    "music.join": async ({ guildId, channelId }) => {
      if (!player.available()) return rejected("unavailable");
      return inChain(guildId, async () => {
        const access = voice.check(guildId, channelId);
        if (access !== "ok") return rejected(access);
        const state = player.state(guildId);
        // The panel acts as the owner: it moves the bot even while people listen.
        if (!state || state.voiceChannelId !== channelId) {
          await enterChannel(guildId, channelId, state !== null);
        }
        return ok;
      });
    },

    "music.search": async ({ guildId, query }) => {
      if (!player.available()) return rejected("unavailable");
      const parsed = parseQuery(query);
      if (parsed === null) return rejected("not_found");
      if (parsed.kind === "unsupported") return rejected("unsupported_link");
      const requesterId = botUserId();
      if (requesterId === null) throw new Error("The bot is not logged in yet");
      const running = searching.get(guildId) ?? 0;
      if (running >= MAX_SEARCHES_IN_FLIGHT) return rejected("search_busy");
      searching.set(guildId, running + 1);
      let result: Awaited<ReturnType<MusicPlayer["search"]>>;
      try {
        result = await player.search(parsed, requesterId);
      } finally {
        const left = (searching.get(guildId) ?? 1) - 1;
        if (left > 0) searching.set(guildId, left);
        else searching.delete(guildId);
      }
      if (result.kind === "error") {
        logger.info("Panel search failed", { kind: parsed.kind, message: result.message });
        return rejected("load_failed");
      }
      if (result.kind === "empty" || result.tracks.length === 0) return rejected("not_found");
      const tracks =
        result.kind === "playlist"
          ? result.tracks.slice(0, MAX_MUSIC_PICKS)
          : result.tracks.slice(0, MAX_MUSIC_RESULTS);
      const searchId = keep({ guildId, tracks, expiresAt: now() + searchTtlMs });
      return {
        status: "ok",
        searchId,
        kind: result.kind,
        name: result.kind === "playlist" ? result.name.slice(0, MAX_PLAYLIST_NAME_LENGTH) : null,
        total: tracks.length,
        tracks: tracks.slice(0, MAX_MUSIC_RESULTS).map(toMusicTrackInfo),
      };
    },

    "music.enqueue": async ({ guildId, searchId, picks, channelId }) => {
      if (!player.available()) return rejected("unavailable");
      const saved = searches.get(searchId);
      // Results belong to the server they were searched for.
      if (!saved || saved.guildId !== guildId || saved.expiresAt <= now()) {
        return rejected("search_expired");
      }
      const picked = [...new Set(picks)]
        .map((index) => saved.tracks[index])
        .filter((track): track is MusicTrack => track !== undefined);
      if (picked.length === 0) return rejected("search_expired");
      return inChain(guildId, async () => {
        let state = player.state(guildId);
        // Adding never moves the bot: that is `music.join`'s call, made on purpose.
        if (state && channelId && state.voiceChannelId !== channelId) {
          return rejected("other_channel");
        }
        if (!state) {
          if (!channelId) return rejected("no_player");
          const access = voice.check(guildId, channelId);
          if (access !== "ok") return rejected(access);
          await enterChannel(guildId, channelId, false);
          state = player.state(guildId);
        }
        const queued = state ? state.upcoming.length + (state.current ? 1 : 0) : 0;
        const room = MAX_QUEUE_LENGTH - queued;
        if (room <= 0) return rejected("queue_full");
        const accepted = picked.slice(0, room);
        await player.enqueue(guildId, accepted);
        return { status: "ok", added: accepted.length, skipped: picked.length - accepted.length };
      });
    },

    "music.queue.remove": ({ guildId, index, key }) =>
      change(guildId, async (state) => {
        const wanted = isAt(state.upcoming, index, key);
        if (!wanted || !(await player.remove(guildId, index, wanted.id))) {
          return rejected("queue_changed");
        }
        return ok;
      }),

    "music.queue.move": ({ guildId, from, to, key }) =>
      change(guildId, async (state) => {
        const wanted = isAt(state.upcoming, from, key);
        if (!wanted || to >= state.upcoming.length) return rejected("queue_changed");
        return (await player.moveTrack(guildId, from, to, wanted.id))
          ? ok
          : rejected("queue_changed");
      }),

    "music.queue.shuffle": ({ guildId }) =>
      change(guildId, async (state) => {
        if (state.upcoming.length < 2) return rejected("too_few_tracks");
        await player.shuffle(guildId);
        return ok;
      }),

    "music.queue.clear": ({ guildId }) =>
      change(guildId, async (state) => {
        if (state.upcoming.length === 0) return rejected("empty_queue");
        await player.clear(guildId);
        return ok;
      }),

    "music.control": async ({ guildId, control }) => {
      // Like /stop: leaving works while the node is away.
      if (control.action === "disconnect") {
        return inChain(guildId, async () => {
          if (!player.state(guildId)) return rejected("no_player");
          await player.leave(guildId);
          return ok;
        });
      }
      return change(guildId, async (state) => {
        switch (control.action) {
          case "loop":
            await player.setLoop(guildId, control.mode);
            return ok;
          case "volume":
            await player.setVolume(guildId, control.percent);
            return ok;
          case "filter":
            await player.setFilter(guildId, control.filter);
            return ok;
        }
        const current = state.current;
        if (!current) return rejected("nothing_playing");
        switch (control.action) {
          case "pause":
            await player.pause(guildId);
            return ok;
          case "resume":
            await player.resume(guildId);
            return ok;
          case "skip":
            if (trackKey(current.id) !== control.key) return rejected("track_changed");
            await player.skip(guildId, current.id);
            return ok;
          case "seek":
            if (trackKey(current.id) !== control.key) return rejected("track_changed");
            if (current.isStream || !current.isSeekable) return rejected("not_seekable");
            if (control.positionMs > current.durationMs) return rejected("past_end");
            return (await player.seek(guildId, control.positionMs, current.id))
              ? ok
              : rejected("track_changed");
        }
      });
    },
  };
}

export interface MusicEventsOptions {
  player: MusicPlayer;
  /** Fire and forget; the bridge's `publishEvent`. */
  publish<N extends EventName>(name: N, payload: EventPayload<N>): Promise<void>;
  /** At most one `music.state` per guild within this; the last change of a burst always goes out. */
  intervalMs?: number;
  /** How often `available()` is read to notice the node going away or coming back. */
  pollMs?: number;
  now?: () => number;
}

export const MUSIC_EVENT_INTERVAL_MS = 500;
export const MUSIC_STATUS_POLL_MS = 2_000;

/**
 * Publishes `music.state` for a guild after every change of its player, coalesced to one per interval (the
 * page moves the position on itself), and `music.status` when the node comes or goes.
 */
export function startMusicEvents({
  player,
  publish,
  intervalMs = MUSIC_EVENT_INTERVAL_MS,
  pollMs = MUSIC_STATUS_POLL_MS,
  now = Date.now,
}: MusicEventsOptions): { stop(): void } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastSent = new Map<string, number>();

  function send(guildId: string): void {
    timers.delete(guildId);
    const snapshot = musicSnapshot(player, guildId, 0, now);
    // A guild without a player sends its last state and is forgotten until it plays again.
    if (snapshot.player) lastSent.set(guildId, now());
    else lastSent.delete(guildId);
    void publish("music.state", snapshot);
  }

  function changed(guildId: string): void {
    if (timers.has(guildId)) return;
    const wait = Math.max(0, (lastSent.get(guildId) ?? -Infinity) + intervalMs - now());
    const timer = setTimeout(() => send(guildId), wait);
    timer.unref?.();
    timers.set(guildId, timer);
  }

  const unsubscribe = player.subscribe({
    trackStart: changed,
    queueEnd: changed,
    playerDestroyed: changed,
    trackFailed: changed,
    stateChanged: changed,
  });

  let available = player.available();
  const poll = setInterval(() => {
    const current = player.available();
    if (current === available) return;
    available = current;
    void publish("music.status", { available });
  }, pollMs);
  poll.unref?.();

  return {
    stop() {
      unsubscribe();
      clearInterval(poll);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
