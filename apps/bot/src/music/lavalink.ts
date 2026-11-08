/** `MusicPlayer` on top of lavalink-client (ADR 4): one node, one player per guild. */
import type { Logger } from "@dzajcarz/core";
import type { MusicListener, MusicPlayer, MusicTrack } from "@dzajcarz/module-music";
import { type Client, Events } from "discord.js";
import {
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
  /**
   * Plays a file of the node's local source in the voice channel, replacing an idle player of the guild.
   * Resolves when the file is over; `queued` tells whether other tracks follow it. `file` is a path the
   * bot's own configuration lists, never member input: the node reads whatever path it gets.
   */
  playLocalFile(
    guildId: string,
    voiceChannelId: string,
    file: string,
  ): Promise<{ queued: boolean }>;
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
const VOLUME = 50;
/** How long a recovery waits for Discord to confirm that the bot left voice before joining again. */
const REJOIN_TIMEOUT_MS = 5000;

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

  /** Local files being played: settled by the track's end, the queue's end or the player's end. */
  const localPlays = new Map<
    string,
    { encoded: string; done: (result: { queued: boolean }) => void }
  >();
  function finishLocal(guildId: string, queued: boolean): void {
    localPlays.get(guildId)?.done({ queued });
    localPlays.delete(guildId);
  }

  function playerGone(guildId: string, reason: unknown): void {
    finishLocal(guildId, false);
    resumeAt.delete(guildId);
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
  // Emitted only when another track follows; the end of the last one is queueEnd.
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
      if (!current) return;
      const at = resumePosition(current.info, position);
      if (at !== null) {
        await player.play({ clientTrack: current, position: at, paused });
        return;
      }
      // The track would have ended during the outage.
      player.queue.current = null;
      if (player.queue.tracks.length > 0) await player.play({ paused });
      else emit("queueEnd", (listener) => listener.queueEnd(guildId));
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

  async function joinVoice(
    guildId: string,
    voiceChannelId: string,
    textChannelId: string,
  ): Promise<void> {
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
        return { kind: "error", message: error instanceof Error ? error.message : String(error) };
      }
    },

    state(guildId) {
      const player = manager.getPlayer(guildId);
      return player ? toPlayerState(player) : null;
    },

    join: joinVoice,

    async enqueue(guildId, tracks) {
      const player = playerOf(guildId);
      await player.queue.add(await Promise.all(tracks.map((track) => toTrack(player, track))));
      // `current` is set as soon as play() starts, unlike `playing`, which waits for the node.
      if (!player.queue.current) await player.play();
    },

    async playLocalFile(guildId, voiceChannelId, file) {
      const node = connectedNode();
      if (!node) throw new Error("No Lavalink node is connected");
      const result: RawLoadResult = await node.request(
        `/loadtracks?identifier=${encodeURIComponent(`local:${file}`)}`,
      );
      const [raw] = rawTracksOf(result);
      if (!raw) throw new Error(`Lavalink could not load ${file}`);
      const track = manager.utils.buildTrack(raw, { id: client.user?.id ?? "" });
      const stale = manager.getPlayer(guildId);
      if (stale) await destroyPlayer(stale, "scheduled song");
      await joinVoice(guildId, voiceChannelId, voiceChannelId);
      const player = playerOf(guildId);
      const finished = new Promise<{ queued: boolean }>((done) => {
        localPlays.set(guildId, { encoded: raw.encoded, done });
      });
      try {
        await player.queue.add(track);
        await player.play();
      } catch (error) {
        localPlays.delete(guildId);
        await destroyPlayer(player, "scheduled song failed");
        throw error;
      }
      return finished;
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
