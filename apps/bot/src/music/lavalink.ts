/** `MusicPlayer` on top of lavalink-client (ADR 4): one node, one player per guild. */
import type { Logger } from "@dzajcarz/core";
import type { MusicListener, MusicPlayer, MusicTrack } from "@dzajcarz/module-music";
import { type Client, Events } from "discord.js";
import { LavalinkManager, type Player, type Track } from "lavalink-client";
import {
  nodeOptions,
  type RawLoadResult,
  rawTracksOf,
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
}: LavalinkPlayerOptions): LavalinkMusicPlayer {
  const manager = new LavalinkManager({
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

  // A restarted node forgets its sessions: the client keeps the players but nothing plays any more. The
  // track is replayed from where it was when the node went away once the node is back (spike DZAJ-10).
  const resumeAt = new Map<string, number>();

  manager.on("trackStart", (player, track) => {
    if (track)
      emit("trackStart", (listener) => listener.trackStart(player.guildId, toMusicTrack(track)));
  });
  manager.on("queueEnd", (player) => {
    emit("queueEnd", (listener) => listener.queueEnd(player.guildId));
  });
  manager.on("playerDestroy", (player, reason) => {
    resumeAt.delete(player.guildId);
    logger.info("Music player destroyed", { guildId: player.guildId, reason });
    emit("playerDestroyed", (listener) => listener.playerDestroyed(player.guildId));
  });
  /** Guilds whose bot leaves and rejoins voice on purpose (recovery); their disconnect is not a kick. */
  const rejoining = new Map<string, () => void>();
  manager.on("playerDisconnect", (player) => {
    const resolve = rejoining.get(player.guildId);
    if (resolve) {
      resolve();
      return;
    }
    // Someone disconnected the bot: there is nothing left to play into.
    player
      .destroy("Disconnected", false)
      .catch((error: unknown) =>
        logger.warn("Destroying a disconnected player failed", { guildId: player.guildId, error }),
      );
  });

  /**
   * Plays the current track again from `position` after a node restart. The voice session died with the
   * old node (Discord answers a reused one with close code 4006), and re-sending the same channel does not
   * produce new credentials, so the bot leaves and joins the channel again first.
   */
  async function replay(player: Player, position: number): Promise<void> {
    const { guildId } = player;
    const channelId = player.voiceChannelId;
    const current = player.queue.current;
    if (!channelId || !current) return;
    const paused = player.paused;
    const left = new Promise<void>((resolve) => {
      rejoining.set(guildId, resolve);
      setTimeout(resolve, REJOIN_TIMEOUT_MS);
    });
    try {
      await player.disconnect(true);
      await left;
    } finally {
      rejoining.delete(guildId);
    }
    player.options.voiceChannelId = channelId;
    await player.connect();
    await player.play({ clientTrack: current, position, paused });
  }

  manager.on("trackError", (player, track, payload) => {
    logger.warn("Track failed", {
      guildId: player.guildId,
      title: track?.info.title,
      error: payload.exception?.message,
    });
  });
  manager.on("trackStuck", (player, track) => {
    logger.warn("Track stuck", { guildId: player.guildId, title: track?.info.title });
  });

  manager.nodeManager.on("disconnect", (node, reason) => {
    logger.warn("Lavalink node disconnected", { node: node.id, reason });
    for (const player of manager.players.values()) {
      if (player.queue.current && !resumeAt.has(player.guildId)) {
        resumeAt.set(player.guildId, player.position);
      }
    }
  });
  manager.nodeManager.on("connect", (node) => {
    logger.info("Lavalink node connected", { node: node.id });
    for (const [guildId, position] of resumeAt) {
      resumeAt.delete(guildId);
      const player = manager.getPlayer(guildId);
      if (player?.queue.current) {
        replay(player, position).catch((error: unknown) =>
          logger.warn("Resuming playback failed", { guildId, error }),
        );
      }
    }
  });
  manager.nodeManager.on("reconnecting", (node) => {
    logger.info("Lavalink node reconnecting", { node: node.id });
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
      let result: RawLoadResult;
      try {
        result = await node.request(`/loadtracks?identifier=${encodeURIComponent(identifier)}`);
      } catch (error) {
        return { kind: "error", message: error instanceof Error ? error.message : String(error) };
      }
      const requester = { id: requesterId };
      const tracks = rawTracksOf(result).map((raw) => manager.utils.buildTrack(raw, requester));
      for (const track of tracks) remember(track);
      return toSearchResult(result, tracks.map(toMusicTrack));
    },

    state(guildId) {
      const player = manager.getPlayer(guildId);
      return player ? toPlayerState(player) : null;
    },

    async join(guildId, voiceChannelId, textChannelId) {
      const player = manager.createPlayer({
        guildId,
        voiceChannelId,
        textChannelId,
        selfDeaf: true,
        volume: VOLUME,
      });
      if (!player.connected) await player.connect();
    },

    async enqueue(guildId, tracks) {
      const player = playerOf(guildId);
      await player.queue.add(await Promise.all(tracks.map((track) => toTrack(player, track))));
      if (!player.playing && !player.paused) await player.play();
    },

    async skip(guildId) {
      // With nothing queued this stops the track, which ends the queue (queueEnd).
      await playerOf(guildId).skip(0, false);
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
      await manager.getPlayer(guildId)?.destroy("left", true);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async destroy() {
      client.off(Events.Raw, forwardVoice);
      listeners.clear();
      for (const player of [...manager.players.values()]) {
        await player.destroy("shutdown", true).catch((error: unknown) => {
          logger.warn("Destroying a music player failed", { guildId: player.guildId, error });
        });
      }
      for (const node of manager.nodeManager.nodes.values()) node.destroy("shutdown", true);
    },
  };
}
