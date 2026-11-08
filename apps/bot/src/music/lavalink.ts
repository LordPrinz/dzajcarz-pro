/** `MusicPlayer` on top of lavalink-client (ADR 4): one node, one player per guild. */
import type { Logger } from "@dzajcarz/core";
import type { MusicFilter, MusicListener, MusicPlayer, MusicTrack } from "@dzajcarz/module-music";
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

export interface LavalinkMusicPlayer extends MusicPlayer {
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
}

/** Searched tracks kept to enqueue without asking the node again; older ones are decoded on demand. */
const TRACK_CACHE_SIZE = 2000;
/** Lavalink's 100 is the source's own level (the client's volumeDecrementer stays at 1). */
const VOLUME = 100;
/** How long a recovery waits for Discord to confirm that the bot left voice before joining again. */
const REJOIN_TIMEOUT_MS = 5000;

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

  /** The track to queue, with the module's requester on it. */
  async function toTrack(player: Player, track: MusicTrack): Promise<Track> {
    const requester = { id: track.requesterId };
    const known =
      cache.get(track.id) ?? (await player.node.decode.singleTrack(track.id, requester));
    return manager.utils.buildTrack(known, requester);
  }

  // A restarted node forgets its sessions: the client keeps the players but nothing plays any more. Every
  // player is rejoined once the node is back, and its track replayed from where it was (spike DZAJ-10).
  const resumeAt = new Map<string, number>();
  /** The track a skip was sent for, until the next track starts: a second skip of it is a no-op. */
  const skipping = new Map<string, string>();
  /** Guilds whose bot leaves and rejoins voice on purpose (recovery); their disconnect is not a kick. */
  const rejoining = new Map<string, () => void>();

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
  manager.on("queueEnd", (player) => {
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
    const recovering = [...resumeAt];
    resumeAt.clear();
    for (const [guildId, position] of recovering) {
      const player = manager.getPlayer(guildId);
      if (player) void recover(player, position);
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

  const forwardVoice = (packet: unknown) => {
    void manager.sendRawData(packet as Parameters<typeof manager.sendRawData>[0]);
  };
  client.on(Events.Raw, forwardVoice);
  client.once(Events.ClientReady, (ready) => {
    manager
      .init({ id: ready.user.id, username: ready.user.username })
      .catch((error: unknown) => logger.error("Lavalink init failed", { error }));
  });

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
        return { kind: "error", message: error instanceof Error ? error.message : String(error) };
      }
    },

    state(guildId) {
      const player = manager.getPlayer(guildId);
      return player ? toPlayerState(player, filters.get(guildId) ?? "off") : null;
    },

    async join(guildId, voiceChannelId, textChannelId) {
      const player = manager.createPlayer({
        guildId,
        voiceChannelId,
        textChannelId,
        selfDeaf: true,
        volume: VOLUME,
      });
      // createPlayer returns an existing player as it is; one that lost its channel (a rejoin that never
      // finished) would otherwise connect to nothing.
      if (!player.voiceChannelId) {
        player.options.voiceChannelId = voiceChannelId;
        player.options.textChannelId = textChannelId;
        player.textChannelId = textChannelId;
      }
      if (!player.connected) await player.connect();
    },

    async enqueue(guildId, tracks) {
      const player = playerOf(guildId);
      await player.queue.add(await Promise.all(tracks.map((track) => toTrack(player, track))));
      // `current` is set as soon as play() starts, unlike `playing`, which waits for the node.
      if (!player.queue.current) await player.play();
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
      await playerOf(guildId).setRepeatMode(mode);
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
        if (player.repeatMode === "queue" && index > 0) {
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
      while (current?.encoded && player.queue.previous[0]?.encoded === current.encoded) {
        await player.queue.shiftPrevious();
      }
      const back = await player.queue.shiftPrevious();
      if (!back) return "none";
      if (player.repeatMode === "queue") {
        // The queue loop already put the back track at the end; playing it now must not add a second turn.
        const copy = player.queue.tracks.findLastIndex((track) => track.encoded === back.encoded);
        if (copy >= 0) await player.queue.splice(copy, 1);
      }
      // The track that was playing waits at the front of the queue, so the next skip returns to it.
      if (current) await player.queue.add(current, 0);
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
