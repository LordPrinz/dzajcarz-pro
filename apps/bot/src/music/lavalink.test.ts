import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type LogFields, type Logger, silentLogger } from "@dzajcarz/core";
import type { MusicListener, MusicTrack } from "@dzajcarz/module-music";
import type { Client } from "discord.js";
import { EQList, FilterManager, type LavalinkManager } from "lavalink-client";
import { createLavalinkMusicPlayer } from "./lavalink.ts";
import { FAST_RETRIES, FAST_RETRY_MS, SLOW_RETRY_MS } from "./mapping.ts";

const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000002";
const VOICE = "400000000000000004";
const TEXT = "300000000000000003";
const CALLER = "200000000000000002";

interface StubTrack {
  encoded: string;
  info: {
    identifier: string;
    title: string;
    author: string;
    duration: number;
    uri: string | null;
    artworkUrl: string | null;
    isStream: boolean;
    isSeekable: boolean;
    sourceName: string;
    isrc: null;
  };
  pluginInfo: Record<string, never>;
  requester?: { id: string; byBot?: true };
}

function song(title: string, duration = 200_000): StubTrack {
  return {
    encoded: `enc-${title}`,
    info: {
      identifier: title,
      title,
      author: "Autor",
      duration,
      uri: `https://www.youtube.com/watch?v=${title}`,
      artworkUrl: null,
      isStream: false,
      isSeekable: true,
      sourceName: "youtube",
      isrc: null,
    },
    pluginInfo: {},
    requester: { id: CALLER },
  };
}

interface StubPlayerOptions {
  guildId: string;
  voiceChannelId?: string;
  textChannelId?: string;
  volume?: number;
}

/** Stands in for a lavalink-client Player: records what the adapter asks of it. */
class StubPlayer {
  readonly guildId: string;
  voiceChannelId: string | null = null;
  textChannelId: string | null;
  options: StubPlayerOptions;
  paused = false;
  playing = false;
  position = 0;
  connected = false;
  repeatMode: "off" | "track" | "queue" = "off";
  volume = 100;
  readonly ping = { lavalink: 0, ws: 0 };
  readonly calls: string[] = [];
  /** Runs while the player joins, before Discord answers (a member's /play landing meanwhile). */
  duringConnect: (() => Promise<void>) | null = null;
  readonly queue = {
    current: null as StubTrack | null,
    tracks: [] as StubTrack[],
    /** Newest first, like the client's history. */
    previous: [] as StubTrack[],
    add: async (tracks: StubTrack | StubTrack[], index?: number) => {
      const added = [tracks].flat();
      if (index !== undefined && index < this.queue.tracks.length) {
        this.queue.tracks.splice(index, 0, ...added);
      } else this.queue.tracks.push(...added);
    },
    splice: async (index: number, amount: number) => {
      const removed = this.queue.tracks.splice(index, amount);
      return removed.length === 1 ? removed[0] : removed;
    },
    shiftPrevious: async () => this.queue.previous.shift() ?? null,
    shuffle: async () => {
      this.queue.tracks.reverse();
    },
  };
  /** The client's real filter manager: what it sends goes to the stub node's `updatePlayer`. */
  readonly filterManager: FilterManager;

  constructor(
    private readonly manager: StubManager,
    options: StubPlayerOptions,
  ) {
    this.guildId = options.guildId;
    this.options = { ...options };
    this.voiceChannelId = options.voiceChannelId ?? null;
    this.textChannelId = options.textChannelId ?? null;
    this.filterManager = new FilterManager(this as never);
  }

  triggerPlayerClientUpdate() {}

  get node() {
    return this.manager.node;
  }

  async connect() {
    this.calls.push(`connect ${this.options.voiceChannelId}`);
    await this.duringConnect?.();
    this.voiceChannelId = this.options.voiceChannelId ?? null;
    this.connected = true;
  }

  /** Discord confirms the leave right away. */
  async disconnect() {
    this.calls.push("disconnect");
    this.voiceChannelId = null;
    this.connected = false;
    this.manager.emit("playerDisconnect", this, VOICE);
  }

  async play(options: { clientTrack?: StubTrack; position?: number; paused?: boolean } = {}) {
    if (this.manager.failPlay) throw new Error("Session not found");
    if (options.clientTrack) this.queue.current = options.clientTrack;
    else if (!this.queue.current) this.queue.current = this.queue.tracks.shift() ?? null;
    this.calls.push(
      `play ${this.queue.current?.info.title}${options.position === undefined ? "" : ` at ${options.position}`}`,
    );
    this.playing = true;
  }

  async skip(skipTo = 0) {
    this.calls.push(skipTo === 0 ? "skip" : `skip to ${skipTo}`);
  }

  async setRepeatMode(mode: "off" | "track" | "queue") {
    this.repeatMode = mode;
  }

  async seek(position: number) {
    this.calls.push(`seek ${position}`);
  }

  async pause() {
    this.paused = true;
  }

  async setVolume(volume: number) {
    this.volume = volume;
  }

  async resume() {
    this.paused = false;
  }

  /** Like the client: leave voice, drop the player, then ask the node, then emit. */
  async destroy(reason: string, disconnect = true) {
    this.calls.push(`destroy ${reason}${disconnect ? "" : " (stay)"}`);
    if (this.manager.destroyFailsEarly) throw new Error("socket closed");
    if (disconnect) {
      this.voiceChannelId = null;
      this.manager.leftVoice.push(this.guildId);
    }
    this.manager.players.delete(this.guildId);
    if (!this.manager.nodeUp) throw new Error("Unable to connect to the node");
    this.manager.emit("playerDestroy", this, reason);
  }
}

/** Stands in for LavalinkManager: the parts the adapter touches, with the node as a plain object. */
class StubManager extends EventEmitter {
  nodeUp = true;
  failPlay = false;
  /** `sendRawData` rejects while true, like a node that is down. */
  rawFails = false;
  destroyFailsEarly = false;
  /** The node refuses player updates (filters) while true. */
  failUpdate = false;
  /** Player updates sent to the node, in order. */
  readonly updates: { guildId: string; playerOptions: { filters?: Record<string, unknown> } }[] =
    [];
  /** What `/loadtracks` answers; an Error is thrown. */
  response: unknown = { loadType: "empty" };
  readonly leftVoice: string[] = [];
  /** Every `/loadtracks` path the adapter asked for. */
  readonly requests: string[] = [];
  readonly players = new Map<string, StubPlayer>();
  readonly node = {
    id: "main",
    options: { retryDelay: FAST_RETRY_MS },
    reconnectionAttemptCount: 0,
    sessionId: "session",
    updatePlayer: async (update: (typeof this.updates)[number]) => {
      if (this.failUpdate) throw new Error("Session not found");
      this.updates.push(update);
    },
    request: async (path: string) => {
      this.requests.push(path);
      if (this.response instanceof Error) throw this.response;
      return this.response;
    },
    decode: {
      singleTrack: async () => {
        throw new Error("not cached");
      },
    },
    destroy: () => {},
  };
  readonly nodeManager = Object.assign(new EventEmitter(), {
    nodes: new Map([["main", this.node]]),
    leastUsedNodes: () => (this.nodeUp ? [this.node] : []),
  });
  readonly utils = {
    buildTrack: (raw: StubTrack, requester: { id: string; byBot?: true }) => ({
      ...raw,
      requester,
    }),
  };

  get useable() {
    return this.nodeUp;
  }

  getPlayer(guildId: string) {
    return this.players.get(guildId);
  }

  createPlayer(options: StubPlayerOptions) {
    const existing = this.players.get(options.guildId);
    if (existing) return existing;
    const player = new StubPlayer(this, options);
    this.players.set(options.guildId, player);
    return player;
  }

  async init() {}
  async sendRawData() {
    if (this.rawFails) throw new Error("Lavalink node is down");
  }

  /** A player that already plays `current` with `upcoming` queued. */
  playing(guildId: string, current: StubTrack | null, upcoming: StubTrack[] = []): StubPlayer {
    const player = this.createPlayer({ guildId, voiceChannelId: VOICE, textChannelId: TEXT });
    player.connected = true;
    player.queue.current = current;
    player.queue.tracks.push(...upcoming);
    player.playing = current !== null;
    return player;
  }

  /** The node goes away and comes back (a container restart). */
  restart() {
    this.nodeUp = false;
    this.nodeManager.emit("disconnect", this.node, { code: 1006 });
    this.nodeUp = true;
    this.nodeManager.emit("connect", this.node);
  }
}

function setup({ localFileGraceMs }: { localFileGraceMs?: number } = {}) {
  const manager = new StubManager();
  const gateway: unknown[] = [];
  const shard = { send: (payload: unknown) => void gateway.push(payload) };
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const client = {
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler);
    },
    off() {},
    once() {},
    guilds: { cache: new Map([[GUILD, { shard }]]) },
  } as unknown as Client;
  const warnings: { message: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    ...silentLogger,
    warn: (message, fields) => void warnings.push({ message, fields }),
    child: () => logger,
  };
  const music = createLavalinkMusicPlayer({
    client,
    url: "http://localhost:2333",
    password: "pw",
    logger,
    createManager: () => manager as unknown as LavalinkManager,
    localFileGraceMs,
  });
  const events: string[] = [];
  const failed: MusicTrack[] = [];
  const changes: string[] = [];
  const listener: MusicListener = {
    trackStart: (guildId, track) => void events.push(`trackStart ${guildId} ${track.title}`),
    queueEnd: (guildId) => void events.push(`queueEnd ${guildId}`),
    playerDestroyed: (guildId) => void events.push(`playerDestroyed ${guildId}`),
    trackFailed: (_guildId, track) => void failed.push(track),
    stateChanged: (guildId) => void changes.push(guildId),
  };
  music.subscribe(listener);
  const forwardRaw = (packet: unknown) => handlers.get("raw")?.(packet);
  return { manager, music, gateway, events, failed, changes, warnings, forwardRaw };
}

/** Lets fire-and-forget recovery work finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("lavalink music player", () => {
  describe("forwarding voice packets", () => {
    test("a rejection while the node is down is logged, not left unhandled", async () => {
      const { manager, warnings, forwardRaw } = setup();
      manager.rawFails = true;
      forwardRaw({ t: "VOICE_SERVER_UPDATE", d: { guild_id: GUILD } });
      await settle();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toBe("Voice update not forwarded");
      expect(warnings[0]?.fields).toMatchObject({ guildId: GUILD });
    });
  });

  describe("destroying a player", () => {
    test("leave during a node outage still drops the player and tells the module", async () => {
      const { manager, music, events } = setup();
      const player = manager.playing(GUILD, song("A"));
      manager.nodeUp = false;
      await music.leave(GUILD);
      expect(player.calls).toEqual(["destroy left"]);
      expect(manager.leftVoice).toEqual([GUILD]);
      expect(music.state(GUILD)).toBeNull();
      expect(events).toEqual([`playerDestroyed ${GUILD}`]);
    });

    test("a destroy that fails before leaving voice leaves through the gateway", async () => {
      const { manager, music, events, gateway } = setup();
      manager.playing(GUILD, song("A"));
      manager.destroyFailsEarly = true;
      await music.leave(GUILD);
      expect(gateway).toEqual([
        { op: 4, d: { guild_id: GUILD, channel_id: null, self_mute: false, self_deaf: false } },
      ]);
      expect(manager.players.size).toBe(0);
      expect(events).toEqual([`playerDestroyed ${GUILD}`]);
    });

    test("a destroy that works is reported once, by the client's event", async () => {
      const { manager, music, events } = setup();
      manager.playing(GUILD, song("A"));
      await music.leave(GUILD);
      await music.leave(GUILD);
      expect(events).toEqual([`playerDestroyed ${GUILD}`]);
    });

    test("a kick destroys the player without sending another leave", async () => {
      const { manager, events } = setup();
      const player = manager.playing(GUILD, song("A"));
      manager.emit("playerDisconnect", player, VOICE);
      await settle();
      expect(player.calls).toEqual(["destroy Disconnected (stay)"]);
      expect(manager.leftVoice).toEqual([]);
      expect(events).toEqual([`playerDestroyed ${GUILD}`]);
    });

    test("a destroyed player is not recovered after a restart", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"));
      manager.nodeManager.emit("disconnect", manager.node, { code: 1006 });
      await music.leave(GUILD);
      manager.nodeManager.emit("connect", manager.node);
      await settle();
      expect(player.calls).toEqual(["destroy left"]);
    });
  });

  describe("playing a local file", () => {
    const FILE = "/opt/Lavalink/music/lato_z_radiem.mp3";

    test("loads the file through the local source, joins and plays it", async () => {
      const { manager, music } = setup();
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      void music.playLocalFile(GUILD, VOICE, FILE);
      await settle();
      // The bare path: the local source opens `new File(identifier)` and knows no prefix.
      expect(manager.requests).toEqual([`/loadtracks?identifier=${encodeURIComponent(FILE)}`]);
      const player = manager.players.get(GUILD);
      expect(player?.calls).toEqual([`connect ${VOICE}`, "play Lato z Radiem"]);
      expect(music.state(GUILD)?.current).toMatchObject({ title: "Lato z Radiem", byBot: true });
    });

    test("refuses any path outside the music directory or not named like a song file", async () => {
      const { manager, music } = setup();
      for (const file of [
        "/etc/passwd",
        `local:${FILE}`,
        "/opt/Lavalink/music/../application.yml",
        "/opt/Lavalink/music/sub/song.mp3",
        "/opt/Lavalink/musicx/song.mp3",
        "/opt/Lavalink/music/Song.mp3",
        "/opt/Lavalink/music/.mp3",
      ]) {
        await expect(music.playLocalFile(GUILD, VOICE, file)).rejects.toThrow(
          "not a song file of the music directory",
        );
      }
      expect(manager.requests).toEqual([]);
    });

    test("is busy and touches nothing while members' music plays or waits", async () => {
      const { manager, music } = setup();
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      const playing = manager.playing(GUILD, song("A"));
      expect(await music.playLocalFile(GUILD, VOICE, FILE)).toEqual({ status: "busy" });
      playing.queue.current = null;
      playing.queue.tracks.push(song("B"));
      expect(await music.playLocalFile(GUILD, VOICE, FILE)).toEqual({ status: "busy" });
      expect(playing.calls).toEqual([]);
      expect(playing.queue.tracks.map((track) => track.info.title)).toEqual(["B"]);
    });

    test("a member's track queued while the bot joins plays after the file", async () => {
      const { manager, music } = setup();
      manager.response = { loadType: "search", data: [song("B")] };
      const found = await music.search({ kind: "search", text: "b" }, CALLER);
      const memberTrack = found.kind === "tracks" ? found.tracks[0] : undefined;
      const idle = manager.playing(GUILD, null);
      idle.duringConnect = async () => {
        idle.duringConnect = null;
        await music.enqueue(GUILD, [memberTrack as MusicTrack]);
      };
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      void music.playLocalFile(GUILD, "400000000000000009", FILE);
      await settle();
      expect(idle.calls).toEqual(["connect 400000000000000009", "play Lato z Radiem"]);
      expect(idle.queue.tracks.map((track) => track.info.title)).toEqual(["B"]);
    });

    test("resolves without a queue when the file was the last track", async () => {
      const { manager, music } = setup();
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      const done = music.playLocalFile(GUILD, VOICE, FILE);
      await settle();
      manager.emit("queueEnd", manager.players.get(GUILD));
      expect(await done).toEqual({ status: "played", queued: false });
    });

    test("resolves with a queue when another track follows the file", async () => {
      const { manager, music } = setup();
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      const done = music.playLocalFile(GUILD, VOICE, FILE);
      await settle();
      manager.emit("trackEnd", manager.players.get(GUILD), song("Lato z Radiem"), {});
      expect(await done).toEqual({ status: "played", queued: true });
    });

    test("an unrelated track ending does not finish it", async () => {
      const { manager, music } = setup();
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      let finished = false;
      void music.playLocalFile(GUILD, VOICE, FILE).then(() => {
        finished = true;
      });
      await settle();
      manager.emit("trackEnd", manager.players.get(GUILD), song("Other"), {});
      await settle();
      expect(finished).toBe(false);
    });

    test("resolves when the player is destroyed meanwhile", async () => {
      const { manager, music } = setup();
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      const done = music.playLocalFile(GUILD, VOICE, FILE);
      await settle();
      await music.leave(GUILD);
      expect(await done).toEqual({ status: "played", queued: false });
    });

    test("settles once the file's length and the margin pass without any end event", async () => {
      const { manager, music } = setup({ localFileGraceMs: 5 });
      manager.response = { loadType: "track", data: song("Lato z Radiem", 10) };
      const done = music.playLocalFile(GUILD, VOICE, FILE);
      await settle();
      manager.players.get(GUILD)?.queue.tracks.push(song("B"));
      expect(await done).toEqual({ status: "played", queued: true });
    });

    test("a paused scheduled song is not cut off by the watchdog", async () => {
      const { manager, music } = setup({ localFileGraceMs: 5 });
      manager.response = { loadType: "track", data: song("Lato z Radiem", 10) };
      let finished = false;
      void music.playLocalFile(GUILD, VOICE, FILE).then(() => {
        finished = true;
      });
      await settle();
      const player = manager.players.get(GUILD);
      if (!player) throw new Error("no player");
      player.paused = true;
      await Bun.sleep(40);
      expect(finished).toBe(false);
      player.paused = false;
      player.position = 10;
      await Bun.sleep(40);
      expect(finished).toBe(true);
    });

    test("an absurd length does not make the watchdog fire at once", async () => {
      const { manager, music } = setup({ localFileGraceMs: 5 });
      manager.response = {
        loadType: "track",
        data: song("Lato z Radiem", Number.MAX_SAFE_INTEGER),
      };
      let finished = false;
      void music.playLocalFile(GUILD, VOICE, FILE).then(() => {
        finished = true;
      });
      await settle();
      await Bun.sleep(30);
      expect(finished).toBe(false);
      manager.emit("queueEnd", manager.players.get(GUILD));
      await settle();
      expect(finished).toBe(true);
    });

    test("moves an idle player of the guild instead of recreating it", async () => {
      const { manager, music, events } = setup();
      const idle = manager.playing(GUILD, null);
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      void music.playLocalFile(GUILD, "400000000000000009", FILE);
      await settle();
      expect(manager.players.get(GUILD)).toBe(idle);
      expect(idle.calls).toEqual(["connect 400000000000000009", "play Lato z Radiem"]);
      expect(events).toEqual([]);
    });

    test("the first member to join the bot's player makes their channel its text channel", async () => {
      const { manager, music } = setup();
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      void music.playLocalFile(GUILD, VOICE, FILE);
      await settle();
      expect(music.state(GUILD)?.textChannelId).toBe(VOICE);
      await music.join(GUILD, VOICE, TEXT);
      await music.join(GUILD, VOICE, "300000000000000008");
      expect(music.state(GUILD)?.textChannelId).toBe(TEXT);
      expect(manager.players.get(GUILD)?.calls).toEqual([`connect ${VOICE}`, "play Lato z Radiem"]);
    });

    test("an encoded local track can never be queued by a member", async () => {
      const { manager, music } = setup();
      const local = { ...song("passwd"), info: { ...song("passwd").info, sourceName: "local" } };
      manager.node.decode.singleTrack = async () => local as never;
      await music.join(GUILD, VOICE, TEXT);
      const forged: MusicTrack = {
        id: local.encoded,
        title: "x",
        author: "",
        durationMs: 0,
        uri: null,
        artworkUrl: null,
        isStream: false,
        isSeekable: false,
        requesterId: CALLER,
      };
      await expect(music.enqueue(GUILD, [forged])).rejects.toThrow("Local files cannot be queued");
      expect(manager.players.get(GUILD)?.queue.tracks).toEqual([]);
    });

    test("a looped idle player does not repeat the file, and the loop is back after it", async () => {
      const { manager, music } = setup();
      const idle = manager.playing(GUILD, null);
      await idle.setRepeatMode("track");
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      const done = music.playLocalFile(GUILD, VOICE, FILE);
      await settle();
      expect(idle.repeatMode).toBe("off");
      expect(music.state(GUILD)?.loop).toBe("track");
      manager.emit("queueEnd", idle);
      expect(await done).toEqual({ status: "played", queued: false });
      expect(idle.repeatMode).toBe("track");
    });

    test("a loop set during the file applies to the tracks after it", async () => {
      const { manager, music } = setup();
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      const done = music.playLocalFile(GUILD, VOICE, FILE);
      await settle();
      const player = manager.players.get(GUILD) as StubPlayer;
      await music.setLoop(GUILD, "queue");
      expect(player.repeatMode).toBe("off");
      expect(music.state(GUILD)?.loop).toBe("queue");
      manager.emit("trackEnd", player, song("Lato z Radiem"), {});
      expect(await done).toEqual({ status: "played", queued: true });
      expect(player.repeatMode).toBe("queue");
    });

    test("back during the file ends it instead of queueing it again", async () => {
      const { manager, music } = setup();
      const idle = manager.playing(GUILD, null);
      idle.queue.previous.push(song("A"));
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      void music.playLocalFile(GUILD, VOICE, FILE);
      await settle();
      idle.queue.tracks.push(song("B"));
      expect(await music.previous(GUILD)).toMatchObject({ title: "A" });
      expect(idle.queue.current?.info.title).toBe("A");
      expect(idle.queue.tracks.map((track) => track.info.title)).toEqual(["B"]);
    });

    test("back passes over a file the bot played earlier", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("B"));
      const file = { ...song("Lato z Radiem"), requester: { id: "1", byBot: true as const } };
      player.queue.previous.push(file, song("A"));
      expect(await music.previous(GUILD)).toMatchObject({ title: "A" });
      expect(player.calls).toEqual(["play A"]);
    });

    test("jump during the file keeps the members' queue loop", async () => {
      const { manager, music } = setup();
      const idle = manager.playing(GUILD, null);
      idle.repeatMode = "queue";
      manager.response = { loadType: "track", data: song("Lato z Radiem") };
      void music.playLocalFile(GUILD, VOICE, FILE);
      await settle();
      idle.queue.tracks.push(song("B"), song("C"), song("D"));
      expect(await music.jump(GUILD, 2, "enc-D")).toBe(true);
      expect(idle.queue.tracks.map((track) => track.info.title)).toEqual(["D", "B", "C"]);
      expect(idle.calls.at(-1)).toBe("skip");
    });

    test("music counts as playing from the client's queue, also while the player rejoins", () => {
      const { manager, music } = setup();
      expect(music.isPlaying(GUILD)).toBe(false);
      const player = manager.playing(GUILD, song("A"));
      player.voiceChannelId = null;
      expect(music.state(GUILD)).toBeNull();
      expect(music.isPlaying(GUILD)).toBe(true);
      player.queue.current = null;
      expect(music.isPlaying(GUILD)).toBe(false);
      player.queue.tracks.push(song("B"));
      expect(music.isPlaying(GUILD)).toBe(true);
    });

    test("rejects and joins nothing when the node cannot load the file", async () => {
      const { manager, music } = setup();
      manager.response = { loadType: "empty" };
      await expect(music.playLocalFile(GUILD, VOICE, FILE)).rejects.toThrow("could not load");
      expect(manager.players.size).toBe(0);
    });

    test("a /play search typed like a local identifier or a path never selects the local source", async () => {
      const { manager, music } = setup();
      for (const text of [`local:${FILE}`, FILE, "../../etc/passwd", "file:///etc/passwd"]) {
        await music.search({ kind: "search", text }, CALLER);
      }
      expect(manager.requests).toEqual(
        [`local:${FILE}`, FILE, "../../etc/passwd", "file:///etc/passwd"].map(
          (text) => `/loadtracks?identifier=${encodeURIComponent(`ytsearch:${text}`)}`,
        ),
      );
    });
  });

  describe("node restart", () => {
    test("every player rejoins; those with a track replay it where it was", async () => {
      const { manager, events } = setup();
      const busy = manager.playing(GUILD, song("A"));
      busy.position = 60_000;
      busy.paused = true;
      const idle = manager.playing(OTHER_GUILD, null);
      manager.restart();
      await settle();
      expect(busy.calls).toEqual(["disconnect", `connect ${VOICE}`, "play A at 60000"]);
      expect(idle.calls).toEqual(["disconnect", `connect ${VOICE}`]);
      // The rejoin's own disconnect is not a kick.
      expect(manager.players.size).toBe(2);
      expect(events).toEqual([]);
    });

    test("a join during the recovery waits for it instead of connecting a second time", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"));
      manager.restart();
      await music.join(GUILD, "500000000000000005", TEXT);
      expect(player.calls).toEqual(["disconnect", `connect ${VOICE}`, "play A at 0"]);
    });

    test("an earlier recovery finishing does not release a join still waiting for a later one", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"));
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let connects = 0;
      player.duringConnect = async () => {
        if (++connects === 2) await gate;
      };
      manager.restart();
      manager.restart();
      // The first recovery is done by now, the second waits at the gate.
      await settle();
      let joined = false;
      const join = music.join(GUILD, "500000000000000005", TEXT).then(() => {
        joined = true;
      });
      await settle();
      expect(joined).toBe(false);
      release();
      await join;
      expect(joined).toBe(true);
    });

    test("a track that would have ended goes on with the next one", async () => {
      const { manager } = setup();
      const player = manager.playing(GUILD, song("A", 100_000), [song("B")]);
      player.position = 150_000;
      manager.restart();
      await settle();
      expect(player.calls).toEqual(["disconnect", `connect ${VOICE}`, "play B"]);
      expect(player.queue.current?.info.title).toBe("B");
    });

    test("with nothing after it the queue ends", async () => {
      const { manager, events } = setup();
      const player = manager.playing(GUILD, song("A", 100_000));
      player.position = 100_000;
      manager.restart();
      await settle();
      expect(player.calls).toEqual(["disconnect", `connect ${VOICE}`]);
      expect(player.queue.current).toBeNull();
      expect(events).toEqual([`queueEnd ${GUILD}`]);
    });

    test("the effect is sent again to the restarted node", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"));
      player.position = 60_000;
      await music.setFilter(GUILD, "nightcore");
      manager.updates.length = 0;
      manager.restart();
      await settle();
      expect(player.calls).toEqual(["disconnect", `connect ${VOICE}`, "play A at 60000"]);
      expect(manager.updates.map((update) => update.playerOptions.filters)).toEqual([
        { timescale: { speed: 1.29, pitch: 1.29, rate: 0.9366 } },
      ]);
      expect(music.state(GUILD)?.filter).toBe("nightcore");
    });

    test("an idle player gets its effect back too, and none is sent without one", async () => {
      const { manager, music } = setup();
      manager.playing(GUILD, null);
      manager.playing(OTHER_GUILD, song("B"));
      await music.setFilter(GUILD, "bassboost");
      manager.updates.length = 0;
      manager.restart();
      await settle();
      expect(manager.updates).toEqual([
        {
          guildId: GUILD,
          playerOptions: { filters: { equalizer: EQList.BassboostMedium } },
        },
      ]);
    });

    test("an effect the node refuses after a restart is dropped, the music goes on", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"));
      await music.setFilter(GUILD, "8d");
      manager.failUpdate = true;
      manager.restart();
      await settle();
      expect(player.calls.at(-1)).toBe("play A at 0");
      expect(manager.players.size).toBe(1);
      expect(music.state(GUILD)?.filter).toBe("off");
    });

    test("a replay that fails destroys the player", async () => {
      const { manager, events } = setup();
      const player = manager.playing(GUILD, song("A"));
      manager.failPlay = true;
      manager.restart();
      await settle();
      expect(player.calls.at(-1)).toBe("destroy RecoveryFailed");
      expect(manager.players.size).toBe(0);
      expect(events).toEqual([`playerDestroyed ${GUILD}`]);
    });

    test("a player without a voice channel cannot rejoin and is destroyed", async () => {
      const { manager, events } = setup();
      const player = manager.playing(GUILD, song("A"));
      player.voiceChannelId = null;
      player.options.voiceChannelId = undefined;
      manager.restart();
      await settle();
      expect(player.calls).toEqual(["destroy RecoveryFailed"]);
      expect(events).toEqual([`playerDestroyed ${GUILD}`]);
    });

    test("reconnects every 30 s after the fast retries, and fast again once connected", () => {
      const { manager } = setup();
      const { node, nodeManager } = manager;
      node.reconnectionAttemptCount = FAST_RETRIES - 1;
      nodeManager.emit("reconnecting", node);
      expect(node.options.retryDelay).toBe(FAST_RETRY_MS);
      node.reconnectionAttemptCount = FAST_RETRIES;
      nodeManager.emit("reconnecting", node);
      expect(node.options.retryDelay).toBe(SLOW_RETRY_MS);
      node.reconnectionAttemptCount = 500;
      nodeManager.emit("reconnecting", node);
      expect(node.options.retryDelay).toBe(SLOW_RETRY_MS);
      nodeManager.emit("connect", node);
      expect(node.options.retryDelay).toBe(FAST_RETRY_MS);
    });

    test("music is unavailable while the node is away and back once it reconnects", () => {
      const { manager, music } = setup();
      manager.nodeUp = false;
      expect(music.available()).toBe(false);
      manager.nodeUp = true;
      expect(music.available()).toBe(true);
    });
  });

  describe("playback", () => {
    test("two skips of the same track send one skip", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"), [song("B")]);
      await Promise.all([music.skip(GUILD, "enc-A"), music.skip(GUILD, "enc-A")]);
      expect(player.calls).toEqual(["skip"]);
      // The node moved on: B starts, and a skip of B goes through.
      player.queue.current = player.queue.tracks.shift() ?? null;
      manager.emit("trackStart", player, player.queue.current);
      await music.skip(GUILD, "enc-A");
      await music.skip(GUILD, "enc-B");
      expect(player.calls).toEqual(["skip", "skip"]);
    });

    test("a skip that failed can be tried again", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"));
      player.skip = async () => {
        throw new Error("node busy");
      };
      await expect(music.skip(GUILD, "enc-A")).rejects.toThrow("node busy");
      player.skip = async () => void player.calls.push("skip");
      await music.skip(GUILD, "enc-A");
      expect(player.calls).toEqual(["skip"]);
    });

    test("a new player starts at the source's own volume", async () => {
      const { manager, music } = setup();
      await music.join(GUILD, VOICE, TEXT);
      expect(manager.players.get(GUILD)?.options.volume).toBe(100);
    });

    test("enqueue starts playback only when nothing is current", async () => {
      const { manager, music } = setup();
      manager.response = { loadType: "search", data: [song("A"), song("B")] };
      const result = await music.search({ kind: "search", text: "a" }, CALLER);
      const tracks = result.kind === "tracks" ? result.tracks : [];
      await music.join(GUILD, VOICE, TEXT);
      await Promise.all([
        music.enqueue(GUILD, [tracks[0] as MusicTrack]),
        music.enqueue(GUILD, [tracks[1] as MusicTrack]),
      ]);
      const player = manager.players.get(GUILD);
      expect(player?.calls).toEqual([`connect ${VOICE}`, "play A"]);
      expect(music.state(GUILD)?.upcoming.map((track) => track.title)).toEqual(["B"]);
    });

    test("join gives a player that lost its channel the new one", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, null);
      player.voiceChannelId = null;
      player.connected = false;
      player.options.voiceChannelId = undefined;
      await music.join(GUILD, "400000000000000009", "300000000000000008");
      expect(player.calls).toEqual(["connect 400000000000000009"]);
      expect(music.state(GUILD)).toMatchObject({
        voiceChannelId: "400000000000000009",
        textChannelId: "300000000000000008",
      });
    });

    test("a failed or stuck track is reported to the module", () => {
      const { manager, failed } = setup();
      const player = manager.playing(GUILD, song("A"));
      manager.emit("trackError", player, song("A"), { exception: { message: "unavailable" } });
      manager.emit("trackStuck", player, song("B"), {});
      manager.emit("trackError", player, null, {});
      expect(failed.map((track) => track.title)).toEqual(["A", "B"]);
    });
  });

  describe("filters", () => {
    const sent = (manager: StubManager) =>
      manager.updates.map((update) => update.playerOptions.filters);

    test("each change is one update that names the whole effect", async () => {
      const { manager, music } = setup();
      manager.playing(GUILD, song("A"));
      await music.setFilter(GUILD, "nightcore");
      await music.setFilter(GUILD, "vaporwave");
      await music.setFilter(GUILD, "8d");
      await music.setFilter(GUILD, "bassboost");
      await music.setFilter(GUILD, "off");
      expect(sent(manager)).toEqual([
        { timescale: { speed: 1.29, pitch: 1.29, rate: 0.9366 } },
        { timescale: { speed: 0.85, pitch: 0.8, rate: 1 } },
        { rotation: { rotationHz: 0.2 } },
        { equalizer: EQList.BassboostMedium },
        // Lavalink replaces every filter with what an update carries, so nothing switches them all off.
        {},
      ]);
      expect(music.state(GUILD)?.filter).toBe("off");
    });

    test("setting the active effect again keeps it on", async () => {
      const { manager, music } = setup();
      manager.playing(GUILD, song("A"));
      for (const filter of [
        "nightcore",
        "nightcore",
        "8d",
        "8d",
        "bassboost",
        "bassboost",
      ] as const) {
        await music.setFilter(GUILD, filter);
        expect(music.state(GUILD)?.filter).toBe(filter);
      }
      expect(sent(manager)).toEqual([
        { timescale: { speed: 1.29, pitch: 1.29, rate: 0.9366 } },
        { timescale: { speed: 1.29, pitch: 1.29, rate: 0.9366 } },
        { rotation: { rotationHz: 0.2 } },
        { rotation: { rotationHz: 0.2 } },
        { equalizer: EQList.BassboostMedium },
        { equalizer: EQList.BassboostMedium },
      ]);
    });

    test("a refused change leaves no effect claimed", async () => {
      const { manager, music } = setup();
      manager.playing(GUILD, song("A"));
      await music.setFilter(GUILD, "nightcore");
      manager.failUpdate = true;
      await expect(music.setFilter(GUILD, "vaporwave")).rejects.toThrow("Session not found");
      expect(music.state(GUILD)?.filter).toBe("off");
    });
  });

  describe("queue controls", () => {
    test("back passes over the track loop's copies of the current track", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"), [song("C")]);
      player.repeatMode = "track";
      player.queue.previous.push(song("A"), song("A"), song("B"));
      const back = await music.previous(GUILD);
      expect(back).toMatchObject({ title: "B" });
      expect(player.calls).toEqual(["play B"]);
      expect(player.queue.tracks.map((track) => track.info.title)).toEqual(["A", "C"]);
      expect(player.queue.previous).toEqual([]);
    });

    test("back with only copies of the current track has nothing to go back to", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"));
      player.repeatMode = "track";
      player.queue.previous.push(song("A"), song("A"));
      expect(await music.previous(GUILD)).toBe("none");
      expect(player.calls).toEqual([]);
    });

    test("back with the queue loop takes the back track's turn at the end", async () => {
      const { manager, music } = setup();
      // A played and the loop queued it again at the end; B plays now.
      const player = manager.playing(GUILD, song("B"), [song("C"), song("A")]);
      player.repeatMode = "queue";
      player.queue.previous.push(song("A"));
      await music.previous(GUILD);
      expect(player.queue.current?.info.title).toBe("A");
      expect(player.queue.tracks.map((track) => track.info.title)).toEqual(["B", "C"]);
    });

    test("jump with the queue loop moves the passed tracks to the end", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"), [song("B"), song("C"), song("D")]);
      player.repeatMode = "queue";
      expect(await music.jump(GUILD, 2, "enc-D")).toBe(true);
      expect(player.queue.tracks.map((track) => track.info.title)).toEqual(["D", "B", "C"]);
      expect(player.calls).toEqual(["skip"]);
    });

    test("jump without the loop drops the passed tracks", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"), [song("B"), song("C"), song("D")]);
      expect(await music.jump(GUILD, 2, "enc-D")).toBe(true);
      expect(player.calls).toEqual(["skip to 3"]);
    });

    test("jump, back and seek wait until a skip that is on its way has landed", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"), [song("B"), song("C")]);
      player.queue.previous.push(song("Z"));
      await music.skip(GUILD, "enc-A");
      expect(await music.jump(GUILD, 1, "enc-C")).toBe(false);
      expect(await music.previous(GUILD)).toBe("changed");
      expect(await music.seek(GUILD, 1000, "enc-A")).toBe(false);
      expect(player.calls).toEqual(["skip"]);
      player.queue.current = player.queue.tracks.shift() ?? null;
      manager.emit("trackStart", player, player.queue.current);
      expect(await music.jump(GUILD, 0, "enc-C")).toBe(true);
    });

    test("seek moves only the track the module saw", async () => {
      const { manager, music } = setup();
      const player = manager.playing(GUILD, song("A"));
      expect(await music.seek(GUILD, 1000, "enc-B")).toBe(false);
      expect(await music.seek(GUILD, 2000, "enc-A")).toBe(true);
      expect(player.calls).toEqual(["seek 2000"]);
    });
  });

  describe("changes for the panels", () => {
    test("every control that changes the player tells the listeners", async () => {
      const { manager, music, changes } = setup();
      manager.playing(GUILD, song("A"), [song("B"), song("C")]);
      await music.pause(GUILD);
      await music.resume(GUILD);
      await music.setLoop(GUILD, "queue");
      await music.setVolume(GUILD, 50);
      await music.setFilter(GUILD, "nightcore");
      await music.shuffle(GUILD);
      await music.seek(GUILD, 1000, "enc-A");
      await music.enqueue(GUILD, []);
      expect(changes).toEqual(Array(8).fill(GUILD));
    });

    test("a seek or removal that changes nothing tells nobody", async () => {
      const { manager, music, changes } = setup();
      manager.playing(GUILD, song("A"), [song("B")]);
      expect(await music.seek(GUILD, 1000, "enc-B")).toBe(false);
      expect(await music.remove(GUILD, 0, "enc-A")).toBeNull();
      expect(changes).toEqual([]);
    });

    test("a fresh start is left to trackStart, not reported as a change", async () => {
      const { manager, music, changes } = setup();
      manager.response = { loadType: "search", data: [song("A"), song("B")] };
      const result = await music.search({ kind: "search", text: "a" }, CALLER);
      const tracks = result.kind === "tracks" ? result.tracks : [];
      await music.join(GUILD, VOICE, TEXT);
      await music.enqueue(GUILD, [tracks[0] as MusicTrack]);
      expect(changes).toEqual([]);
      await music.enqueue(GUILD, [tracks[1] as MusicTrack]);
      expect(changes).toEqual([GUILD]);
    });

    test("controls that change nothing tell nobody", async () => {
      const { manager, music, changes } = setup();
      const player = manager.playing(GUILD, song("A"));
      await music.resume(GUILD);
      player.paused = true;
      await music.pause(GUILD);
      await music.clear(GUILD);
      expect(changes).toEqual([]);
    });

    test("a move by someone else in Discord is reported too", () => {
      const { manager, changes } = setup();
      const player = manager.playing(GUILD, song("A"));
      manager.emit("playerMove", player, VOICE, "400000000000000009");
      expect(changes).toEqual([GUILD]);
    });
  });

  describe("moving", () => {
    test("moveTrack puts the track the caller saw at its new place", async () => {
      const { manager, music, changes } = setup();
      const player = manager.playing(GUILD, song("A"), [song("B"), song("C"), song("D")]);
      expect(await music.moveTrack(GUILD, 0, 2, "enc-B")).toBe(true);
      expect(player.queue.tracks.map((t) => t.info.title)).toEqual(["C", "D", "B"]);
      expect(await music.moveTrack(GUILD, 2, 0, "enc-B")).toBe(true);
      expect(player.queue.tracks.map((t) => t.info.title)).toEqual(["B", "C", "D"]);
      expect(changes).toEqual([GUILD, GUILD]);
    });

    test("moveTrack leaves a queue that moved meanwhile, or a place past the end, alone", async () => {
      const { manager, music, changes } = setup();
      const player = manager.playing(GUILD, song("A"), [song("B"), song("C")]);
      expect(await music.moveTrack(GUILD, 0, 1, "enc-C")).toBe(false);
      expect(await music.moveTrack(GUILD, 0, 2, "enc-B")).toBe(false);
      expect(await music.moveTrack(GUILD, 0, -1, "enc-B")).toBe(false);
      expect(player.queue.tracks.map((t) => t.info.title)).toEqual(["B", "C"]);
      expect(changes).toEqual([]);
    });

    test("moveToChannel moves a playing player with a voice state update, keeping its track", async () => {
      const { manager, music, changes } = setup();
      const player = manager.playing(GUILD, song("A"), [song("B")]);
      player.voiceChannelId = VOICE;
      const target = "400000000000000009";
      await music.moveToChannel(GUILD, target);
      expect(player.calls).toEqual([`connect ${target}`]);
      expect(music.state(GUILD)?.voiceChannelId).toBe(target);
      expect(music.state(GUILD)?.current?.title).toBe("A");
      expect(changes).toEqual([GUILD]);
    });

    test("moveToChannel to the channel the bot is in sends nothing", async () => {
      const { manager, music, changes } = setup();
      const player = manager.playing(GUILD, song("A"));
      player.voiceChannelId = VOICE;
      await music.moveToChannel(GUILD, VOICE);
      expect(player.calls).toEqual([]);
      expect(changes).toEqual([]);
    });

    test("moveToChannel without a player rejects", async () => {
      const { music } = setup();
      await expect(music.moveToChannel(GUILD, VOICE)).rejects.toThrow();
    });
  });

  describe("search", () => {
    test("an HTTP error does not carry the member's text into the error result", async () => {
      const { manager, music } = setup();
      manager.response = new Error(
        "Request failed | request-PATH: /v4/loadtracks?identifier=ytsearch%3Atajny%20tekst&x=1 | status: 500",
      );
      const result = await music.search({ kind: "search", text: "tajny tekst" }, "u1");
      expect(result.kind).toBe("error");
      const message = result.kind === "error" ? result.message : "";
      expect(message).toContain("identifier=<redacted>&x=1");
      expect(message).not.toContain("tajny");
    });

    test("a malformed or failed node answer is a result, never a throw", async () => {
      const { manager, music } = setup();
      for (const [response, kind] of [
        [null, "error"],
        [{ loadType: "playlist", data: null }, "error"],
        [new Error("ECONNRESET"), "error"],
        ["oops", "empty"],
        [{ loadType: "track" }, "empty"],
        [{ loadType: "search", data: "nope" }, "empty"],
      ] as const) {
        manager.response = response;
        expect((await music.search({ kind: "search", text: "a" }, CALLER)).kind).toBe(kind);
      }
    });

    test("tracks without a title are left out", async () => {
      const { manager, music } = setup();
      const broken = { ...song("A"), info: { ...song("A").info, title: undefined } };
      manager.response = { loadType: "search", data: [broken, song("B")] };
      const result = await music.search({ kind: "search", text: "a" }, CALLER);
      expect(result.kind === "tracks" && result.tracks.map((track) => track.title)).toEqual(["B"]);
    });
  });
});
