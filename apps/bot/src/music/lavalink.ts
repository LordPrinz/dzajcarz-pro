/** `MusicPlayer` on top of lavalink-client (ADR 4): one node, one player per guild. */
import { type Logger, withTimeout } from "@dzajcarz/core";
import type {
  LoopMode,
  MusicFilter,
  MusicListener,
  MusicPlayer,
  MusicTrack,
} from "@dzajcarz/module-music";
import type { ScheduledPlayResult } from "@dzajcarz/module-schedule";
import { type Client, Events } from "discord.js";
import {
  EQList,
  LavalinkManager,
  type ManagerOptions,
  type Player,
  type Track,
  type UnresolvedTrack,
} from "lavalink-client";
import {
  nodeOptions,
  type RawLoadResult,
  rawTracksOf,
  resumePosition,
  retryDelayAfter,
  toIdentifier,
  toMusicTrack,
  toPlayerState,
  toSearchResult,
} from "./mapping.ts";
import { LAVALINK_MUSIC_DIR } from "./scheduled-songs.ts";

export interface LavalinkMusicPlayer extends MusicPlayer {
  /**
   * Plays a file of the node's local source in the voice channel, moving an idle player of the guild
   * there. The track is marked `byBot`, so the music module shows no panel for it. Resolves `busy` at once
   * when the guild already has music playing or queued; otherwise when the file is over, `queued` telling
   * whether other tracks follow it. `file` must be a song file of `LAVALINK_MUSIC_DIR`, which the bot's
   * own configuration lists: the node opens whatever path it gets.
   *
   * The file plays at the player's volume and with its effect: an idle player keeps what members set, a new
   * one starts at the source's own volume with none. It never repeats: the members' loop mode is held back
   * while it plays and applies again to the tracks after it.
   */
  playLocalFile(
    guildId: string,
    voiceChannelId: string,
    file: string,
  ): Promise<ScheduledPlayResult>;
  /**
   * Whether the guild's player has a current or queued track, read from the client's queue, so a player
   * that is rejoining after a node restart counts too.
   */
  isPlaying(guildId: string): boolean;
  /** Leaves every voice channel and closes the node connection. */
  destroy(): Promise<void>;
}

export interface LavalinkPlayerOptions {
  client: Client;
  url: string;
  password: string;
  logger: Logger;
  /** Builds the client library's manager; the tests pass a stub. */
  createManager?: (options: ManagerOptions) => LavalinkManager;
  /** How long past its length a local file may play before it counts as over without an end event. */
  localFileGraceMs?: number;
}

/** Searched tracks kept to enqueue without asking the node again; older ones are decoded on demand. */
const TRACK_CACHE_SIZE = 2000;
/** Lavalink's 100 is the source's own level (the client's volumeDecrementer stays at 1). */
const VOLUME = 100;
/** How long a recovery waits for Discord to confirm that the bot left voice before joining again. */
const REJOIN_TIMEOUT_MS = 5000;

/** How long a join or enqueue waits for a recovery of its guild; after that it goes ahead on its own. */
const RECOVERY_WAIT_MS = 10_000;
/** setTimeout fires at once above this (2^31 - 1 ms), so a longer wait is split into several checks. */
const MAX_TIMER_MS = 2_147_483_647;
/** A song file name in the music directory: no separators, so no way out of it. */
const LOCAL_FILE_NAME = /^[a-z0-9_]+\.mp3$/;

/** The client's own presets (toggleNightcore, toggleVaporwave, toggleRotation), written out. */
const NIGHTCORE = { speed: 1.29, pitch: 1.29, rate: 0.9366 };
const VAPORWAVE = { speed: 0.85, pitch: 0.8, rate: 1 };
const UNCHANGED_TIMESCALE = { speed: 1, pitch: 1, rate: 1 };
const ROTATION_HZ = 0.2;

/**
 * Writes `filter` into the client's filter data in place of whatever effect was there; nothing goes to the
 * node yet. The client's toggle* helpers flip state and send one request each, so a repeated or
 * interrupted change could switch an effect off; writing the data and sending it once
 * (`applyPlayerFilters`, a single update with every filter) gives the same result however often it runs.
 */
function writeFilter(filterManager: Player["filterManager"], filter: MusicFilter): void {
  const timescale =
    filter === "nightcore" ? NIGHTCORE : filter === "vaporwave" ? VAPORWAVE : UNCHANGED_TIMESCALE;
  filterManager.data.timescale = { ...timescale };
  filterManager.data.rotation = { rotationHz: filter === "8d" ? ROTATION_HZ : 0 };
  filterManager.equalizerBands =
    filter === "bassboost" ? EQList.BassboostMedium.map((band) => ({ ...band })) : [];
  // The client's own flags, so its view of the player matches what was sent.
  filterManager.filters.nightcore = filter === "nightcore";
  filterManager.filters.vaporwave = filter === "vaporwave";
  filterManager.filters.rotation = filter === "8d";
  filterManager.filters.custom = false;
}

export function createLavalinkMusicPlayer({
  client,
  url,
  password,
  logger,
  createManager = (options) => new LavalinkManager(options),
  localFileGraceMs = 60_000,
}: LavalinkPlayerOptions): LavalinkMusicPlayer {
  const manager = createManager({
    nodes: [nodeOptions(url, password)],
    sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard.send(payload),
    autoSkip: true,
    playerOptions: {
      defaultSearchPlatform: "ytsearch",
      // The requester is stored as `{ id }`; the module only needs the member id.
      requesterTransformer: (requester) => requester,
      // Disconnects are handled below (playerDisconnect): a kick ends the player, a rejoin during
      // recovery does not. Leaving an idle channel is the module's job.
      onDisconnect: { autoReconnect: false, destroyPlayer: false },
    },
  });

  const listeners = new Set<MusicListener>();
  function emit(event: string, fn: (listener: MusicListener) => void): void {
    for (const listener of listeners) {
      try {
        fn(listener);
      } catch (error) {
        logger.error("Music listener failed", { event, error });
      }
    }
  }

  const cache = new Map<string, Track>();
  function remember(track: Track): void {
    if (!track.encoded) return;
    cache.delete(track.encoded);
    cache.set(track.encoded, track);
    if (cache.size > TRACK_CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  const connectedNode = () => manager.nodeManager.leastUsedNodes()[0];

  /** `Queue#splice` answers one track, an array, or null. */
  function tracksOf(spliced: Track | UnresolvedTrack | (Track | UnresolvedTrack)[] | null) {
    return spliced === null ? [] : [spliced].flat();
  }

  function playerOf(guildId: string): Player {
    const player = manager.getPlayer(guildId);
    if (!player) throw new Error(`No music player in guild ${guildId}`);
    return player;
  }

  /**
   * The track to queue, with the module's requester on it. A track id is an encoded track and may come
   * back from component state, so a decoded local file is refused: only `playLocalFile` plays those.
   */
  async function toTrack(player: Player, track: MusicTrack): Promise<Track> {
    const requester = { id: track.requesterId };
    const known =
      cache.get(track.id) ?? (await player.node.decode.singleTrack(track.id, requester));
    // SourceNames does not list Lavalink's own sources, `local` among them.
    if ((known.info.sourceName as string) === "local")
      throw new Error("Local files cannot be queued");
    return manager.utils.buildTrack(known, requester);
  }

  function isPlaying(guildId: string): boolean {
    const queue = manager.getPlayer(guildId)?.queue;
    return Boolean(queue && (queue.current || queue.tracks.length > 0));
  }

  // A restarted node forgets its sessions: the client keeps the players but nothing plays any more. Every
  // player is rejoined once the node is back, and its track replayed from where it was (spike DZAJ-10).
  const resumeAt = new Map<string, number>();
  /** The track a skip was sent for, until the next track starts: a second skip of it is a no-op. */
  const skipping = new Map<string, string>();
  /** Guilds whose bot leaves and rejoins voice on purpose (recovery); their disconnect is not a kick. */
  const rejoining = new Map<string, () => void>();
  /** Recoveries in progress; a join or enqueue waits for its guild's, as the player has no channel meanwhile. */
  const recovering = new Map<string, Promise<void>>();

  /**
   * Local files being played: settled by the track's end, the queue's end or the player's end. The player's
   * own loop mode stays off meanwhile, or the client would replay the file (track loop) or queue it again
   * (queue loop); `loop` is the members' mode, put back on the player when the file is over.
   */
  const localPlays = new Map<
    string,
    { encoded: string; loop: LoopMode; done: (result: { queued: boolean }) => void }
  >();
  function finishLocal(guildId: string, queued: boolean): void {
    const local = localPlays.get(guildId);
    if (!local) return;
    localPlays.delete(guildId);
    // The client emits trackEnd before it starts the next track, and setRepeatMode sets the mode before it
    // awaits anything, so the next track already plays under the members' mode.
    manager
      .getPlayer(guildId)
      ?.setRepeatMode(local.loop)
      .catch((error: unknown) => logger.warn("Restoring the loop mode failed", { guildId, error }));
    local.done({ queued });
  }
  /** The loop mode members chose, also while a local file holds the player's own mode off. */
  function loopOf(player: Player): LoopMode {
    return localPlays.get(player.guildId)?.loop ?? player.repeatMode;
  }
  /** Players started by `playLocalFile`; the first member to join one makes their channel its text channel. */
  const unclaimed = new Set<string>();

  /** The effect each player runs; the client only knows the individual switches. */
  const filters = new Map<string, MusicFilter>();

  /** Sends the guild's effect to a node that lost it (a restart). A failure leaves the player without one. */
  async function restoreFilter(player: Player): Promise<void> {
    const filter = filters.get(player.guildId) ?? "off";
    if (filter === "off") return;
    try {
      writeFilter(player.filterManager, filter);
      await player.filterManager.applyPlayerFilters();
    } catch (error) {
      filters.set(player.guildId, "off");
      logger.warn("Restoring the music filter failed", { guildId: player.guildId, filter, error });
    }
  }

  function playerGone(guildId: string, reason: unknown): void {
    finishLocal(guildId, false);
    unclaimed.delete(guildId);
    resumeAt.delete(guildId);
    filters.delete(guildId);
    skipping.delete(guildId);
    logger.info("Music player destroyed", { guildId, reason });
    emit("playerDestroyed", (listener) => listener.playerDestroyed(guildId));
  }

  /** The voice state update `Player#disconnect` sends, straight through the gateway. */
  async function leaveVoice(guildId: string): Promise<void> {
    await client.guilds.cache.get(guildId)?.shard.send({
      op: 4,
      d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false },
    });
  }

  /**
   * Destroys a player, also while the node is away. The client leaves voice and drops the player before it
   * asks the node to delete it; when that request fails the client never emits `playerDestroy`, so the
   * player is finished here: voice left through the gateway if it got no further, player forgotten,
   * listeners told. Never rejects.
   */
  async function destroyPlayer(player: Player, reason: string, disconnect = true): Promise<void> {
    const { guildId } = player;
    try {
      await player.destroy(reason, disconnect);
      return;
    } catch (error) {
      logger.warn("Destroying a music player on the node failed", { guildId, reason, error });
    }
    if (manager.getPlayer(guildId) === player) {
      if (disconnect) {
        await leaveVoice(guildId).catch((error: unknown) =>
          logger.warn("Leaving voice failed", { guildId, error }),
        );
      }
      manager.players.delete(guildId);
    }
    playerGone(guildId, reason);
  }

  manager.on("trackStart", (player, track) => {
    skipping.delete(player.guildId);
    if (track)
      emit("trackStart", (listener) => listener.trackStart(player.guildId, toMusicTrack(track)));
  });
  // Emitted when another track follows, and when play() replaces the track ("replaced"); the end of the
  // last one is queueEnd.
  manager.on("trackEnd", (player, track) => {
    if (track?.encoded === localPlays.get(player.guildId)?.encoded)
      finishLocal(player.guildId, true);
  });
  manager.on("queueEnd", (player) => {
    finishLocal(player.guildId, false);
    skipping.delete(player.guildId);
    emit("queueEnd", (listener) => listener.queueEnd(player.guildId));
  });
  manager.on("playerDestroy", (player, reason) => playerGone(player.guildId, reason));
  manager.on("playerDisconnect", (player) => {
    const resolve = rejoining.get(player.guildId);
    if (resolve) {
      resolve();
      return;
    }
    // Someone disconnected the bot: there is nothing left to play into.
    void destroyPlayer(player, "Disconnected", false);
  });

  /**
   * Brings a player back after a node restart. The voice session died with the old node (Discord answers
   * a reused one with close code 4006), and re-sending the same channel does not produce new credentials,
   * so the bot leaves and joins the channel again first. Then the current track plays from `position`, or
   * the next one when it would have ended meanwhile. A player that cannot be brought back is destroyed.
   */
  async function recover(player: Player, position: number): Promise<void> {
    const { guildId } = player;
    try {
      const channelId = player.voiceChannelId ?? player.options.voiceChannelId;
      if (!channelId) throw new Error("The player has no voice channel to rejoin");
      const current = player.queue.current;
      const paused = player.paused;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const left = new Promise<void>((resolve) => {
        rejoining.set(guildId, resolve);
        timer = setTimeout(resolve, REJOIN_TIMEOUT_MS);
      });
      try {
        await player.disconnect(true);
        await left;
      } finally {
        clearTimeout(timer);
        rejoining.delete(guildId);
      }
      player.options.voiceChannelId = channelId;
      await player.connect();
      const at = current ? resumePosition(current.info, position) : null;
      if (current && at !== null) {
        await player.play({ clientTrack: current, position: at, paused });
      } else if (current) {
        // The track would have ended during the outage.
        player.queue.current = null;
        if (player.queue.tracks.length > 0) await player.play({ paused });
        else emit("queueEnd", (listener) => listener.queueEnd(guildId));
      }
      // The new session starts without effects, and play() does not send them.
      await restoreFilter(player);
    } catch (error) {
      logger.warn("Recovering a music player failed", { guildId, error });
      await destroyPlayer(player, "RecoveryFailed");
    }
  }

  function trackFailed(
    player: Player,
    track: Track | UnresolvedTrack | null,
    log: string,
    error?: string,
  ): void {
    logger.warn(log, { guildId: player.guildId, title: track?.info.title, error });
    // The client skips to the next track by itself (autoSkip); members only get a note.
    if (track)
      emit("trackFailed", (listener) => listener.trackFailed(player.guildId, toMusicTrack(track)));
  }
  manager.on("trackError", (player, track, payload) => {
    trackFailed(player, track, "Track failed", payload.exception?.message);
  });
  manager.on("trackStuck", (player, track) => {
    trackFailed(player, track, "Track stuck");
  });

  manager.nodeManager.on("disconnect", (node, reason) => {
    logger.warn("Lavalink node disconnected", { node: node.id, reason });
    for (const player of manager.players.values()) {
      if (!resumeAt.has(player.guildId)) {
        resumeAt.set(player.guildId, player.queue.current ? player.position : 0);
      }
    }
  });
  manager.nodeManager.on("connect", (node) => {
    logger.info("Lavalink node connected", { node: node.id });
    node.options.retryDelay = retryDelayAfter(0);
    const pending = [...resumeAt];
    resumeAt.clear();
    for (const [guildId, position] of pending) {
      const player = manager.getPlayer(guildId);
      if (!player) continue;
      // A later recovery of the same guild may have replaced the entry; only remove our own.
      const done: Promise<void> = recover(player, position).finally(() => {
        if (recovering.get(guildId) === done) recovering.delete(guildId);
      });
      recovering.set(guildId, done);
    }
  });
  manager.nodeManager.on("reconnecting", (node) => {
    const attempts = node.reconnectionAttemptCount;
    const delay = retryDelayAfter(attempts);
    if (node.options.retryDelay !== delay) {
      node.options.retryDelay = delay;
      logger.warn("Lavalink node still down, retrying less often", { node: node.id, delay });
    }
    logger.info("Lavalink node reconnecting", { node: node.id, attempts });
  });
  manager.nodeManager.on("error", (node, error) => {
    logger.warn("Lavalink node error", { node: node.id, error });
  });

  // Voice packets keep arriving while the node is down; sendRawData then rejects.
  const forwardVoice = (packet: unknown) => {
    const guildId = (packet as { d?: { guild_id?: unknown } } | null)?.d?.guild_id;
    manager
      .sendRawData(packet as Parameters<typeof manager.sendRawData>[0])
      .catch((error: unknown) => logger.warn("Voice update not forwarded", { guildId, error }));
  };
  client.on(Events.Raw, forwardVoice);
  client.once(Events.ClientReady, (ready) => {
    manager
      .init({ id: ready.user.id, username: ready.user.username })
      .catch((error: unknown) => logger.error("Lavalink init failed", { error }));
  });

  /** Waits for the guild's recovery, at most RECOVERY_WAIT_MS: a stuck one must not hold `/play` forever. */
  async function afterRecovery(guildId: string): Promise<void> {
    const recovery = recovering.get(guildId);
    if (!recovery) return;
    try {
      await withTimeout(recovery, RECOVERY_WAIT_MS);
    } catch (error) {
      logger.warn("Recovery still running, not waiting any longer", { guildId, error });
    }
  }

  async function joinVoice(
    guildId: string,
    voiceChannelId: string,
    textChannelId: string,
  ): Promise<void> {
    await afterRecovery(guildId);
    const player = manager.createPlayer({
      guildId,
      voiceChannelId,
      textChannelId,
      selfDeaf: true,
      volume: VOLUME,
    });
    // createPlayer returns an existing player as it is; one that lost its channel (a rejoin that never
    // finished) would otherwise connect to nothing, and one the bot started has no text channel of its own.
    if (!player.voiceChannelId || unclaimed.delete(guildId)) {
      player.options.voiceChannelId = voiceChannelId;
      player.options.textChannelId = textChannelId;
      player.textChannelId = textChannelId;
    }
    if (!player.connected) await player.connect();
  }

  /**
   * The guild's player in `voiceChannelId`, for a file the bot plays. An idle player is moved with a plain
   * voice state update: destroying it and creating a new one would race Discord's "left voice" for the old
   * one, which the client then applies to the new player and kills it.
   */
  async function takeOver(guildId: string, voiceChannelId: string): Promise<Player> {
    await afterRecovery(guildId);
    const idle = manager.getPlayer(guildId);
    if (idle) {
      idle.options.voiceChannelId = voiceChannelId;
      idle.options.textChannelId = voiceChannelId;
      idle.textChannelId = voiceChannelId;
      if (!idle.connected || idle.voiceChannelId !== voiceChannelId) await idle.connect();
    } else {
      await joinVoice(guildId, voiceChannelId, voiceChannelId);
    }
    unclaimed.add(guildId);
    return playerOf(guildId);
  }

  return {
    available: () => manager.useable,

    async search(query, requesterId) {
      const node = connectedNode();
      if (!node) throw new Error("No Lavalink node is connected");
      const identifier = toIdentifier(query);
      // A failed request and a response of an unexpected shape both end as an error result.
      try {
        const result: RawLoadResult = await node.request(
          `/loadtracks?identifier=${encodeURIComponent(identifier)}`,
        );
        const requester = { id: requesterId };
        const tracks = rawTracksOf(result).map((raw) => manager.utils.buildTrack(raw, requester));
        const found = toSearchResult(result, tracks.map(toMusicTrack));
        for (const track of tracks) remember(track);
        return found;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The client's HTTP error message carries the request path, which holds what the member typed.
        return {
          kind: "error",
          message: message.replace(/identifier=[^&\s|]*/g, "identifier=<redacted>"),
        };
      }
    },

    state(guildId) {
      const player = manager.getPlayer(guildId);
      return player ? toPlayerState(player, filters.get(guildId) ?? "off", loopOf(player)) : null;
    },

    join: joinVoice,

    async enqueue(guildId, tracks) {
      await afterRecovery(guildId);
      const player = playerOf(guildId);
      await player.queue.add(await Promise.all(tracks.map((track) => toTrack(player, track))));
      // `current` is set as soon as play() starts, unlike `playing`, which waits for the node. While a
      // local file is being started, it plays first and these tracks follow it.
      if (!player.queue.current && !localPlays.has(guildId)) await player.play();
    },

    isPlaying,

    async playLocalFile(guildId, voiceChannelId, file) {
      const name = file.startsWith(`${LAVALINK_MUSIC_DIR}/`)
        ? file.slice(LAVALINK_MUSIC_DIR.length + 1)
        : "";
      if (!LOCAL_FILE_NAME.test(name))
        throw new Error(`${file} is not a song file of the music directory`);
      const node = connectedNode();
      if (!node) throw new Error("No Lavalink node is connected");
      // The local source takes the bare path (`new File(identifier)`); it has no prefix of its own.
      const result: RawLoadResult = await node.request(
        `/loadtracks?identifier=${encodeURIComponent(file)}`,
      );
      const [raw] = rawTracksOf(result);
      if (!raw) throw new Error(`Lavalink could not load ${file}`);
      // No await between this check and claiming the guild: members' music that got there first is
      // never interrupted, and tracks queued after the claim wait behind the file (enqueue).
      if (isPlaying(guildId) || localPlays.has(guildId) || rejoining.has(guildId)) {
        return { status: "busy" };
      }
      const loop = manager.getPlayer(guildId)?.repeatMode ?? "off";
      const finished = new Promise<{ queued: boolean }>((done) => {
        localPlays.set(guildId, { encoded: raw.encoded, loop, done });
      });
      const track = manager.utils.buildTrack(raw, { id: client.user?.id ?? "", byBot: true });
      try {
        const player = await takeOver(guildId, voiceChannelId);
        await player.setRepeatMode("off");
        // Ahead of anything a member queued while the bot was joining.
        await player.queue.add(track, 0);
        await player.play();
      } catch (error) {
        localPlays.delete(guildId);
        const player = manager.getPlayer(guildId);
        if (player) await destroyPlayer(player, "scheduled song failed");
        throw error;
      }
      // A lost end event (node restart, dropped socket) would keep the guild's scheduled song running until
      // the bot restarts, so past its length plus a margin it counts as over. Pausing holds the deadline; on
      // resume it restarts from where the file stopped. A dead node's position never moves, so it is read
      // only at that moment.
      const lengthMs = Number.isFinite(track.info.duration) ? Math.max(0, track.info.duration) : 0;
      let deadline = Date.now() + lengthMs + localFileGraceMs;
      let wasPaused = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const arm = (delayMs: number) => {
        watchdog = setTimeout(check, Math.min(Math.max(0, delayMs), MAX_TIMER_MS));
      };
      const check = () => {
        if (localPlays.get(guildId)?.encoded !== raw.encoded) return;
        const player = manager.getPlayer(guildId);
        if (player?.queue.current?.encoded === raw.encoded) {
          if (player.paused) {
            wasPaused = true;
            arm(localFileGraceMs);
            return;
          }
          if (wasPaused) {
            wasPaused = false;
            deadline = Date.now() + Math.max(0, lengthMs - player.position) + localFileGraceMs;
          }
          if (Date.now() < deadline) {
            arm(deadline - Date.now());
            return;
          }
        }
        logger.warn("Scheduled song got no end event; treating it as over", { guildId, file });
        finishLocal(guildId, (player?.queue.tracks.length ?? 0) > 0);
      };
      arm(deadline - Date.now());
      const { queued } = await finished.finally(() => clearTimeout(watchdog));
      return { status: "played", queued };
    },

    async skip(guildId, expectedTrackId) {
      const player = playerOf(guildId);
      const current = player.queue.current;
      if (current?.encoded !== expectedTrackId || skipping.get(guildId) === expectedTrackId) return;
      skipping.set(guildId, expectedTrackId);
      try {
        // With nothing queued this stops the track, which ends the queue (queueEnd).
        await player.skip(0, false);
      } catch (error) {
        skipping.delete(guildId);
        throw error;
      }
    },

    async pause(guildId) {
      const player = playerOf(guildId);
      if (!player.paused) await player.pause();
    },

    async resume(guildId) {
      const player = playerOf(guildId);
      if (player.paused) await player.resume();
    },

    async setLoop(guildId, mode) {
      const player = playerOf(guildId);
      const local = localPlays.get(guildId);
      // During a local file the mode waits for the tracks after it (finishLocal).
      if (local) local.loop = mode;
      else await player.setRepeatMode(mode);
    },

    async shuffle(guildId) {
      await playerOf(guildId).queue.shuffle();
    },

    async seek(guildId, positionMs, expectedTrackId) {
      const player = playerOf(guildId);
      if (player.queue.current?.encoded !== expectedTrackId || skipping.has(guildId)) return false;
      await player.seek(positionMs);
      return true;
    },

    async setVolume(guildId, percent) {
      await playerOf(guildId).setVolume(percent);
    },

    async setFilter(guildId, filter) {
      const { filterManager } = playerOf(guildId);
      writeFilter(filterManager, filter);
      // Until the node confirms, the footer claims no effect rather than one that may not be on.
      filters.set(guildId, "off");
      await filterManager.applyPlayerFilters();
      filters.set(guildId, filter);
    },

    async remove(guildId, index, expectedTrackId) {
      const player = playerOf(guildId);
      if (player.queue.tracks[index]?.encoded !== expectedTrackId) return null;
      const removed = await player.queue.splice(index, 1);
      const track = Array.isArray(removed) ? removed[0] : removed;
      return track ? toMusicTrack(track) : null;
    },

    async jump(guildId, index, expectedTrackId) {
      const player = playerOf(guildId);
      const current = player.queue.current;
      if (
        !current?.encoded ||
        skipping.has(guildId) ||
        player.queue.tracks[index]?.encoded !== expectedTrackId
      )
        return false;
      skipping.set(guildId, current.encoded);
      try {
        if (loopOf(player) === "queue" && index > 0) {
          // The loop keeps every track: the ones passed over wait at the end instead of being dropped.
          await player.queue.add(tracksOf(await player.queue.splice(0, index)));
          await player.skip(0, false);
        } else {
          // Skipping to place n drops the n - 1 tracks before it and ends the current one.
          await player.skip(index + 1, false);
        }
      } catch (error) {
        skipping.delete(guildId);
        throw error;
      }
      return true;
    },

    async previous(guildId) {
      const player = playerOf(guildId);
      if (skipping.has(guildId)) return "changed";
      const current = player.queue.current;
      // The track loop adds the current track to the history on every repeat; going back means before it.
      // A file the bot played is not the members' history either.
      const passOver = (track: Track) =>
        (current?.encoded ? track.encoded === current.encoded : false) ||
        toMusicTrack(track).byBot === true;
      while (player.queue.previous[0] && passOver(player.queue.previous[0])) {
        await player.queue.shiftPrevious();
      }
      const back = await player.queue.shiftPrevious();
      if (!back) return "none";
      if (loopOf(player) === "queue") {
        // The queue loop already put the back track at the end; playing it now must not add a second turn.
        const copy = player.queue.tracks.findLastIndex((track) => track.encoded === back.encoded);
        if (copy >= 0) await player.queue.splice(copy, 1);
      }
      // The track that was playing waits at the front of the queue, so the next skip returns to it. A file
      // the bot plays does not: going back ends it like a skip, and its trackEnd settles playLocalFile.
      if (current && !toMusicTrack(current).byBot) await player.queue.add(current, 0);
      await player.play({ clientTrack: back });
      return toMusicTrack(back);
    },

    async clear(guildId) {
      const player = playerOf(guildId);
      if (player.queue.tracks.length > 0) await player.queue.splice(0, player.queue.tracks.length);
    },

    async leave(guildId) {
      const player = manager.getPlayer(guildId);
      if (player) await destroyPlayer(player, "left");
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async destroy() {
      client.off(Events.Raw, forwardVoice);
      listeners.clear();
      for (const player of [...manager.players.values()]) await destroyPlayer(player, "shutdown");
      for (const node of manager.nodeManager.nodes.values()) node.destroy("shutdown", true);
    },
  };
}
