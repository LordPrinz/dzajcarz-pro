import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { silentLogger } from "@dzajcarz/core";
import type { MusicListener, MusicTrack } from "@dzajcarz/module-music";
import type { Client } from "discord.js";
import type { LavalinkManager } from "lavalink-client";
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

/** Stands in for a lavalink-client Player: records what the adapter asks of it. */
class StubPlayer {
  readonly guildId: string;
  voiceChannelId: string | null = null;
  textChannelId: string | null;
  options: { guildId: string; voiceChannelId?: string; textChannelId?: string };
  paused = false;
  playing = false;
  position = 0;
  connected = false;
  readonly calls: string[] = [];
  /** Runs while the player joins, before Discord answers (a member's /play landing meanwhile). */
  duringConnect: (() => Promise<void>) | null = null;
  readonly queue = {
    current: null as StubTrack | null,
    tracks: [] as StubTrack[],
    add: async (tracks: StubTrack | StubTrack[], index?: number) => {
      this.queue.tracks.splice(index ?? this.queue.tracks.length, 0, ...[tracks].flat());
    },
  };

  constructor(
    private readonly manager: StubManager,
    options: { guildId: string; voiceChannelId?: string; textChannelId?: string },
  ) {
    this.guildId = options.guildId;
    this.options = { ...options };
    this.voiceChannelId = options.voiceChannelId ?? null;
    this.textChannelId = options.textChannelId ?? null;
  }

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

  async skip() {
    this.calls.push("skip");
  }

  async pause() {
    this.paused = true;
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
  destroyFailsEarly = false;
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

  createPlayer(options: { guildId: string; voiceChannelId?: string; textChannelId?: string }) {
    const existing = this.players.get(options.guildId);
    if (existing) return existing;
    const player = new StubPlayer(this, options);
    this.players.set(options.guildId, player);
    return player;
  }

  async init() {}
  async sendRawData() {}

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

function setup() {
  const manager = new StubManager();
  const gateway: unknown[] = [];
  const shard = { send: (payload: unknown) => void gateway.push(payload) };
  const client = {
    on() {},
    off() {},
    once() {},
    guilds: { cache: new Map([[GUILD, { shard }]]) },
  } as unknown as Client;
  const music = createLavalinkMusicPlayer({
    client,
    url: "http://localhost:2333",
    password: "pw",
    logger: silentLogger,
    createManager: () => manager as unknown as LavalinkManager,
  });
  const events: string[] = [];
  const failed: MusicTrack[] = [];
  const listener: MusicListener = {
    trackStart: (guildId, track) => void events.push(`trackStart ${guildId} ${track.title}`),
    queueEnd: (guildId) => void events.push(`queueEnd ${guildId}`),
    playerDestroyed: (guildId) => void events.push(`playerDestroyed ${guildId}`),
    trackFailed: (_guildId, track) => void failed.push(track),
  };
  music.subscribe(listener);
  return { manager, music, gateway, events, failed };
}

/** Lets fire-and-forget recovery work finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("lavalink music player", () => {
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
        requesterId: CALLER,
      };
      await expect(music.enqueue(GUILD, [forged])).rejects.toThrow("Local files cannot be queued");
      expect(manager.players.get(GUILD)?.queue.tracks).toEqual([]);
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

  describe("search", () => {
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
