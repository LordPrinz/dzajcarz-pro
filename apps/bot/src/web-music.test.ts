import { describe, expect, test } from "bun:test";
import { silentLogger } from "@dzajcarz/core";
import { MAX_QUEUE_LENGTH, parseQuery } from "@dzajcarz/module-music";
import { createFakePlayer, track } from "@dzajcarz/module-music/testing";
import {
  COMMANDS,
  type CommandName,
  type EventName,
  type EventPayload,
  MAX_MUSIC_QUEUE_LENGTH,
  MUSIC_QUEUE_PAGE,
  type MusicRejection,
  trackKey,
} from "@dzajcarz/web-protocol";
import {
  createWebMusic,
  MAX_SEARCHES,
  type MusicHandlers,
  musicSnapshot,
  startMusicEvents,
  type VoiceDirectory,
} from "./web-music.ts";

const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000002";
const VOICE = "400000000000000004";
const OTHER_VOICE = "400000000000000005";
const FULL_VOICE = "400000000000000006";
const BOT = "100000000000000099";
const DEADLINE = { deadline: Number.MAX_SAFE_INTEGER };

function setup({
  now = (): number => 1_000_000,
  joinTimeoutMs,
}: {
  now?: () => number;
  joinTimeoutMs?: number;
} = {}) {
  const player = createFakePlayer();
  const voice: VoiceDirectory = {
    list: (guildId) =>
      guildId === GUILD
        ? {
            channels: [{ id: VOICE, name: "Gadu", parentId: null, listeners: 2, joinable: true }],
            truncated: false,
          }
        : null,
    check: (_guildId, channelId) =>
      channelId === FULL_VOICE
        ? "no_connect"
        : [VOICE, OTHER_VOICE].includes(channelId)
          ? "ok"
          : "unknown_channel",
  };
  const music = createWebMusic({
    player,
    voice,
    botUserId: () => BOT,
    parseQuery,
    logger: silentLogger,
    now,
    joinTimeoutMs,
  });
  /** Runs a handler with the request checked against its schema, as the command server would. */
  async function call<N extends keyof MusicHandlers & CommandName>(
    name: N,
    request: Parameters<MusicHandlers[N]>[0],
  ) {
    const parsed = COMMANDS[name].request.parse(request) as Parameters<MusicHandlers[N]>[0];
    const handler = music[name] as (request: unknown, context: typeof DEADLINE) => Promise<unknown>;
    const answer = await handler(parsed, DEADLINE);
    // Whatever the bot answers must pass the panel's schema too.
    expect(COMMANDS[name].response.safeParse(answer).success).toBe(true);
    return answer as Awaited<ReturnType<MusicHandlers[N]>>;
  }
  /** A player in VOICE with `current` playing and `upcoming` queued. */
  async function playing(current = "A", upcoming: string[] = []) {
    await player.join(GUILD, VOICE, VOICE);
    await player.enqueue(GUILD, [track(current), ...upcoming.map((title) => track(title))]);
  }
  const keyOf = (title: string) => trackKey(track(title).id);
  return { player, music, call, playing, keyOf };
}

const rejected = (reason: MusicRejection) => ({ status: "rejected", reason }) as const;
const OK = { status: "ok" } as const;

describe("web music", () => {
  describe("state", () => {
    test("no player is a snapshot without one", async () => {
      const { call } = setup();
      expect(await call("music.state", { guildId: GUILD, offset: 0 })).toEqual({
        guildId: GUILD,
        available: true,
        at: new Date(1_000_000).toISOString(),
        player: null,
      });
    });

    test("pages the queue and says how long all of it is", async () => {
      const { call, playing } = setup();
      const titles = Array.from({ length: 45 }, (_, i) => `T${i}`);
      await playing("A", titles);
      const first = await call("music.state", { guildId: GUILD, offset: 0 });
      expect(first.player?.current?.title).toBe("A");
      expect(first.player?.queue.total).toBe(45);
      expect(first.player?.queue.totalDurationMs).toBe(45 * 200_000);
      expect(first.player?.queue.tracks).toHaveLength(MUSIC_QUEUE_PAGE);
      const last = await call("music.state", { guildId: GUILD, offset: 40 });
      expect(last.player?.queue.tracks.map((t) => t.title)).toEqual([
        "T40",
        "T41",
        "T42",
        "T43",
        "T44",
      ]);
    });
  });

  test("voice channels come from the directory; another server is null", async () => {
    const { call } = setup();
    expect((await call("music.voice_channels", { guildId: GUILD }))?.channels).toHaveLength(1);
    expect(await call("music.voice_channels", { guildId: OTHER_GUILD })).toBeNull();
  });

  describe("join", () => {
    test("joins with the voice channel's chat as the Discord panel's channel", async () => {
      const { call, player } = setup();
      expect(await call("music.join", { guildId: GUILD, channelId: VOICE })).toEqual(OK);
      expect(player.joins).toEqual([
        { guildId: GUILD, voiceChannelId: VOICE, textChannelId: VOICE },
      ]);
    });

    test("moves the bot to another channel while people listen", async () => {
      const { call, player, playing } = setup();
      await playing("A", ["B"]);
      expect(await call("music.join", { guildId: GUILD, channelId: OTHER_VOICE })).toEqual(OK);
      expect(player.moves).toEqual([{ guildId: GUILD, voiceChannelId: OTHER_VOICE }]);
      expect(player.state(GUILD)?.current?.title).toBe("A");
      expect(player.state(GUILD)?.voiceChannelId).toBe(OTHER_VOICE);
    });

    test("the channel the bot is in already changes nothing", async () => {
      const { call, player, playing } = setup();
      await playing();
      expect(await call("music.join", { guildId: GUILD, channelId: VOICE })).toEqual(OK);
      expect(player.moves).toEqual([]);
    });

    test("refuses a channel the bot cannot use, and while the node is away", async () => {
      const { call, player } = setup();
      expect(await call("music.join", { guildId: GUILD, channelId: FULL_VOICE })).toEqual(
        rejected("no_connect"),
      );
      expect(await call("music.join", { guildId: GUILD, channelId: "400000000000000777" })).toEqual(
        rejected("unknown_channel"),
      );
      player.up = false;
      expect(await call("music.join", { guildId: GUILD, channelId: VOICE })).toEqual(
        rejected("unavailable"),
      );
      expect(player.joins).toEqual([]);
    });
  });

  test("a join that never answers fails without holding up the server's other commands", async () => {
    const { call, player, music } = setup({ joinTimeoutMs: 20 });
    player.join = () => new Promise(() => {});
    const join = music["music.join"]({ guildId: GUILD, channelId: VOICE }, DEADLINE);
    expect(await call("music.queue.clear", { guildId: GUILD })).toEqual(rejected("no_player"));
    await expect(join).rejects.toThrow("Timed out");
  });

  test("the panel's queue cap is the music module's", () => {
    expect(MAX_MUSIC_QUEUE_LENGTH).toBe(MAX_QUEUE_LENGTH);
  });

  describe("search and enqueue", () => {
    test("adding to a player in another channel is refused, the bot stays", async () => {
      const { call, player, playing } = setup();
      await playing();
      const found = await call("music.search", { guildId: GUILD, query: "x" });
      if (found.status !== "ok") throw new Error("search failed");
      expect(
        await call("music.enqueue", {
          guildId: GUILD,
          searchId: found.searchId,
          picks: [0],
          channelId: OTHER_VOICE,
        }),
      ).toEqual(rejected("other_channel"));
      expect(player.moves).toEqual([]);
      expect(
        await call("music.enqueue", {
          guildId: GUILD,
          searchId: found.searchId,
          picks: [0],
          channelId: VOICE,
        }),
      ).toEqual({ status: "ok", added: 1, skipped: 0 });
    });

    test("at most two searches run at once per server", async () => {
      const { call, player } = setup();
      const pending: (() => void)[] = [];
      const search = player.search.bind(player);
      player.search = (query, requesterId) =>
        new Promise((resolve) => {
          pending.push(() => resolve(search(query, requesterId)));
        });
      const first = call("music.search", { guildId: GUILD, query: "a" });
      const second = call("music.search", { guildId: GUILD, query: "b" });
      expect(await call("music.search", { guildId: GUILD, query: "c" })).toEqual(
        rejected("search_busy"),
      );
      for (const release of pending.splice(0)) release();
      await Promise.all([first, second]);
      player.search = search;
      expect((await call("music.search", { guildId: GUILD, query: "d" })).status).toBe("ok");
      expect((await call("music.search", { guildId: OTHER_GUILD, query: "e" })).status).toBe("ok");
    });

    test("search results are added as the bot's tracks, joining the chosen channel", async () => {
      const { call, player } = setup();
      player.nextResult = { kind: "tracks", tracks: [track("A"), track("B"), track("C")] };
      const found = await call("music.search", { guildId: GUILD, query: "lato" });
      if (found.status !== "ok") throw new Error("search failed");
      expect(found.tracks.map((t) => t.title)).toEqual(["A", "B", "C"]);
      expect(player.searches).toEqual([
        { query: { kind: "search", text: "lato" }, requesterId: BOT },
      ]);
      expect(
        await call("music.enqueue", {
          guildId: GUILD,
          searchId: found.searchId,
          picks: [2, 0, 2],
          channelId: VOICE,
        }),
      ).toEqual({ status: "ok", added: 2, skipped: 0 });
      expect(player.state(GUILD)?.current?.title).toBe("C");
      expect(player.state(GUILD)?.upcoming.map((t) => t.title)).toEqual(["A"]);
    });

    test("a playlist can be added up to the queue's room", async () => {
      const { call, player, playing } = setup();
      await playing(
        "X",
        Array.from({ length: MAX_QUEUE_LENGTH - 3 }, (_, i) => `Q${i}`),
      );
      player.nextResult = {
        kind: "playlist",
        name: "Lista",
        tracks: Array.from({ length: 150 }, (_, i) => track(`P${i}`)),
      };
      const found = await call("music.search", {
        guildId: GUILD,
        query: "https://www.youtube.com/playlist?list=PL1",
      });
      if (found.status !== "ok") throw new Error("search failed");
      expect(found).toMatchObject({ kind: "playlist", name: "Lista", total: 100 });
      expect(found.tracks).toHaveLength(20);
      const picks = Array.from({ length: 100 }, (_, i) => i);
      expect(
        await call("music.enqueue", { guildId: GUILD, searchId: found.searchId, picks }),
      ).toEqual({
        status: "ok",
        added: 2,
        skipped: 98,
      });
      expect(
        await call("music.enqueue", { guildId: GUILD, searchId: found.searchId, picks }),
      ).toEqual(rejected("queue_full"));
    });

    test("refuses links /play refuses, nothing found and failed loads", async () => {
      const { call, player } = setup();
      expect(
        await call("music.search", { guildId: GUILD, query: "https://evil.example/x" }),
      ).toEqual(rejected("unsupported_link"));
      player.nextResult = { kind: "empty" };
      expect(await call("music.search", { guildId: GUILD, query: "nic" })).toEqual(
        rejected("not_found"),
      );
      player.nextResult = { kind: "error", message: "blocked" };
      expect(await call("music.search", { guildId: GUILD, query: "x" })).toEqual(
        rejected("load_failed"),
      );
    });

    test("enqueue needs a channel without a player, a fresh search of the same server", async () => {
      let time = 1_000_000;
      const { call } = setup({ now: () => time });
      const found = await call("music.search", { guildId: GUILD, query: "x" });
      if (found.status !== "ok") throw new Error("search failed");
      const request = { guildId: GUILD, searchId: found.searchId, picks: [0] };
      expect(await call("music.enqueue", request)).toEqual(rejected("no_player"));
      expect(await call("music.enqueue", { ...request, channelId: FULL_VOICE })).toEqual(
        rejected("no_connect"),
      );
      expect(
        await call("music.enqueue", { ...request, guildId: OTHER_GUILD, channelId: VOICE }),
      ).toEqual(rejected("search_expired"));
      expect(await call("music.enqueue", { ...request, picks: [5], channelId: VOICE })).toEqual(
        rejected("search_expired"),
      );
      time += 11 * 60_000;
      expect(await call("music.enqueue", { ...request, channelId: VOICE })).toEqual(
        rejected("search_expired"),
      );
    });

    test("keeps at most MAX_SEARCHES searches, dropping the oldest", async () => {
      const { call } = setup();
      const first = await call("music.search", { guildId: GUILD, query: "x" });
      if (first.status !== "ok") throw new Error("search failed");
      for (let i = 0; i < MAX_SEARCHES; i++)
        await call("music.search", { guildId: GUILD, query: "y" });
      expect(
        await call("music.enqueue", {
          guildId: GUILD,
          searchId: first.searchId,
          picks: [0],
          channelId: VOICE,
        }),
      ).toEqual(rejected("search_expired"));
    });
  });

  describe("queue", () => {
    test("remove and move act on the track the panel saw", async () => {
      const { call, player, playing, keyOf } = setup();
      await playing("A", ["B", "C", "D"]);
      expect(
        await call("music.queue.move", { guildId: GUILD, from: 0, to: 2, key: keyOf("B") }),
      ).toEqual(OK);
      expect(player.state(GUILD)?.upcoming.map((t) => t.title)).toEqual(["C", "D", "B"]);
      expect(
        await call("music.queue.remove", { guildId: GUILD, index: 0, key: keyOf("C") }),
      ).toEqual(OK);
      expect(player.state(GUILD)?.upcoming.map((t) => t.title)).toEqual(["D", "B"]);
    });

    test("a queue that moved meanwhile is left alone", async () => {
      const { call, player, playing, keyOf } = setup();
      await playing("A", ["B", "C"]);
      expect(
        await call("music.queue.remove", { guildId: GUILD, index: 0, key: keyOf("C") }),
      ).toEqual(rejected("queue_changed"));
      expect(
        await call("music.queue.move", { guildId: GUILD, from: 0, to: 2, key: keyOf("B") }),
      ).toEqual(rejected("queue_changed"));
      expect(player.state(GUILD)?.upcoming.map((t) => t.title)).toEqual(["B", "C"]);
    });

    test("shuffle needs two tracks, clear needs one, and both need a player", async () => {
      const { call, player, playing } = setup();
      expect(await call("music.queue.shuffle", { guildId: GUILD })).toEqual(rejected("no_player"));
      await playing("A", ["B"]);
      expect(await call("music.queue.shuffle", { guildId: GUILD })).toEqual(
        rejected("too_few_tracks"),
      );
      expect(await call("music.queue.clear", { guildId: GUILD })).toEqual(OK);
      expect(await call("music.queue.clear", { guildId: GUILD })).toEqual(rejected("empty_queue"));
      await player.enqueue(GUILD, [track("C"), track("D")]);
      expect(await call("music.queue.shuffle", { guildId: GUILD })).toEqual(OK);
      expect(player.shuffles).toEqual([GUILD]);
    });
  });

  describe("controls", () => {
    test("pause, resume, loop, volume and filter change the shared player", async () => {
      const { call, player, playing } = setup();
      await playing();
      const control = (c: Parameters<MusicHandlers["music.control"]>[0]["control"]) =>
        call("music.control", { guildId: GUILD, control: c });
      expect(await control({ action: "pause" })).toEqual(OK);
      expect(player.state(GUILD)?.paused).toBe(true);
      expect(await control({ action: "resume" })).toEqual(OK);
      expect(await control({ action: "loop", mode: "queue" })).toEqual(OK);
      expect(await control({ action: "volume", percent: 40 })).toEqual(OK);
      expect(await control({ action: "filter", filter: "nightcore" })).toEqual(OK);
      expect(player.state(GUILD)).toMatchObject({
        paused: false,
        loop: "queue",
        volume: 40,
        filter: "nightcore",
      });
    });

    test("skip and seek act only on the track the panel saw", async () => {
      const { call, player, playing, keyOf } = setup();
      await playing("A", ["B"]);
      const control = (c: Parameters<MusicHandlers["music.control"]>[0]["control"]) =>
        call("music.control", { guildId: GUILD, control: c });
      expect(await control({ action: "seek", key: keyOf("B"), positionMs: 1000 })).toEqual(
        rejected("track_changed"),
      );
      expect(await control({ action: "seek", key: keyOf("A"), positionMs: 300_000 })).toEqual(
        rejected("past_end"),
      );
      expect(await control({ action: "seek", key: keyOf("A"), positionMs: 60_000 })).toEqual(OK);
      expect(player.state(GUILD)?.positionMs).toBe(60_000);
      expect(await control({ action: "skip", key: keyOf("B") })).toEqual(rejected("track_changed"));
      expect(await control({ action: "skip", key: keyOf("A") })).toEqual(OK);
      expect(player.state(GUILD)?.current?.title).toBe("B");
    });

    test("a stream cannot be sought", async () => {
      const { call, player } = setup();
      await player.join(GUILD, VOICE, VOICE);
      await player.enqueue(GUILD, [track("Radio", { isStream: true, durationMs: 0 })]);
      expect(
        await call("music.control", {
          guildId: GUILD,
          control: { action: "seek", key: trackKey(track("Radio").id), positionMs: 0 },
        }),
      ).toEqual(rejected("not_seekable"));
    });

    test("the panel overrides the scheduled song's lock: pause, seek, loop, skip and disconnect work", async () => {
      const { call, player } = setup();
      player.playByBot(GUILD, VOICE, "Lato z Radiem");
      const key = trackKey(track("Lato z Radiem").id);
      const control = (c: Parameters<MusicHandlers["music.control"]>[0]["control"]) =>
        call("music.control", { guildId: GUILD, control: c });
      expect(await control({ action: "pause" })).toEqual(OK);
      expect(player.state(GUILD)?.paused).toBe(true);
      expect(await control({ action: "seek", key, positionMs: 10_000 })).toEqual(OK);
      expect(await control({ action: "loop", mode: "track" })).toEqual(OK);
      expect(await control({ action: "skip", key })).toEqual(OK);
      expect(player.skips).toEqual([
        { guildId: GUILD, expectedTrackId: track("Lato z Radiem").id },
      ]);
      player.playByBot(GUILD, VOICE, "Lato z Radiem");
      expect(await control({ action: "disconnect" })).toEqual(OK);
      expect(player.state(GUILD)).toBeNull();
    });

    test("the scheduled song's player can be moved while it plays", async () => {
      const { call, player } = setup();
      player.playByBot(GUILD, VOICE, "Lato z Radiem");
      expect(await call("music.join", { guildId: GUILD, channelId: OTHER_VOICE })).toEqual(OK);
      expect(player.state(GUILD)?.voiceChannelId).toBe(OTHER_VOICE);
      expect(player.state(GUILD)?.current?.title).toBe("Lato z Radiem");
    });

    test("with the node away every control is refused but disconnect still leaves", async () => {
      const { call, player, playing, keyOf } = setup();
      await playing("A", ["B"]);
      player.up = false;
      for (const control of [
        { action: "pause" },
        { action: "skip", key: keyOf("A") },
        { action: "volume", percent: 10 },
      ] as const) {
        expect(await call("music.control", { guildId: GUILD, control })).toEqual(
          rejected("unavailable"),
        );
      }
      expect(await call("music.queue.clear", { guildId: GUILD })).toEqual(rejected("unavailable"));
      expect(await call("music.search", { guildId: GUILD, query: "x" })).toEqual(
        rejected("unavailable"),
      );
      expect(player.state(GUILD)?.paused).toBe(false);
      expect(
        await call("music.control", { guildId: GUILD, control: { action: "disconnect" } }),
      ).toEqual(OK);
      expect(player.state(GUILD)).toBeNull();
    });

    test("controls without a player or without a track say so", async () => {
      const { call, player } = setup();
      expect(await call("music.control", { guildId: GUILD, control: { action: "pause" } })).toEqual(
        rejected("no_player"),
      );
      expect(
        await call("music.control", { guildId: GUILD, control: { action: "disconnect" } }),
      ).toEqual(rejected("no_player"));
      await player.join(GUILD, VOICE, VOICE);
      expect(await call("music.control", { guildId: GUILD, control: { action: "pause" } })).toEqual(
        rejected("nothing_playing"),
      );
    });
  });
});

describe("music events", () => {
  function events(intervalMs = 30) {
    const player = createFakePlayer();
    const sent: { name: EventName; payload: unknown }[] = [];
    const publish = async <N extends EventName>(name: N, payload: EventPayload<N>) =>
      void sent.push({ name, payload });
    const stream = startMusicEvents({ player, publish, intervalMs, pollMs: 10 });
    return { player, sent, stream };
  }

  test("a burst of changes goes out as one state, the last one, and later changes again", async () => {
    const { player, sent, stream } = events();
    await player.join(GUILD, VOICE, VOICE);
    await player.enqueue(GUILD, [track("A")]);
    await player.setVolume(GUILD, 40);
    await player.pause(GUILD);
    await Bun.sleep(5);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("music.state");
    expect(sent[0]?.payload).toMatchObject({
      guildId: GUILD,
      player: { volume: 40, paused: true, current: { title: "A" } },
    });
    await player.resume(GUILD);
    await Bun.sleep(5);
    expect(sent).toHaveLength(1);
    await Bun.sleep(40);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.payload).toMatchObject({ player: { paused: false } });
    stream.stop();
  });

  test("a player that goes away is sent as none", async () => {
    const { player, sent, stream } = events(0);
    await player.join(GUILD, VOICE, VOICE);
    await player.enqueue(GUILD, [track("A")]);
    await Bun.sleep(5);
    await player.leave(GUILD);
    await Bun.sleep(5);
    expect(sent.at(-1)?.payload).toMatchObject({ guildId: GUILD, player: null });
    stream.stop();
  });

  test("the node going away and coming back is announced once each", async () => {
    const { player, sent, stream } = events();
    player.up = false;
    await Bun.sleep(25);
    player.up = true;
    await Bun.sleep(25);
    expect(sent).toEqual([
      { name: "music.status", payload: { available: false } },
      { name: "music.status", payload: { available: true } },
    ]);
    stream.stop();
  });

  test("stop sends nothing more", async () => {
    const { player, sent, stream } = events();
    await player.join(GUILD, VOICE, VOICE);
    stream.stop();
    await player.enqueue(GUILD, [track("A")]);
    player.up = false;
    await Bun.sleep(30);
    expect(sent).toEqual([]);
  });

  test("the snapshot a guild sends fits the event schema", async () => {
    const player = createFakePlayer();
    await player.join(GUILD, VOICE, VOICE);
    await player.enqueue(GUILD, [track("A"), track("B")]);
    const { EVENTS } = await import("@dzajcarz/web-protocol");
    expect(EVENTS["music.state"].safeParse(musicSnapshot(player, GUILD)).success).toBe(true);
  });
});
