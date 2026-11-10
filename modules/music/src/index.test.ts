import { describe, expect, test } from "bun:test";
import {
  type AnyCommand,
  type ButtonSpec,
  createRegistry,
  executeCommand,
  type Reply,
  type SelectSpec,
  silentLogger,
} from "@dzajcarz/core";
import {
  clickComponent,
  createFakeContext,
  createFakeScheduler,
  replyText,
} from "@dzajcarz/core/testing";
import type { Guild, VoiceState } from "discord.js";
import {
  createFakeDirectMessages,
  createFakePanels,
  createFakePlayer,
  createFakeVoice,
  createMemoryStorage,
  settle,
  track,
} from "./fakes.test-support.ts";
import {
  createMusicModule,
  EMPTY_QUEUE,
  IDLE_MS,
  MAX_PLAYLIST_TRACKS,
  MAX_QUEUE_LENGTH,
  NOT_IN_VOICE,
  NOTHING_PLAYING,
  otherChannel,
  queueChanged,
  trackFailedText,
  UNAVAILABLE,
  UNSUPPORTED_LINK,
} from "./index.ts";

const GUILD = "100000000000000001";
const TEXT = "300000000000000003";
const VOICE = "400000000000000004";
const OTHER_VOICE = "400000000000000005";
const CALLER = "200000000000000002";
const FRIEND = "200000000000000009";

function setup() {
  const player = createFakePlayer();
  const voice = createFakeVoice();
  const panels = createFakePanels();
  const directMessages = createFakeDirectMessages();
  const scheduler = createFakeScheduler();
  const module = createMusicModule({
    player,
    voice,
    panels,
    directMessages,
    scheduler,
    stateStorage: createMemoryStorage(),
    logger: silentLogger,
  });
  const registry = createRegistry([module]);
  voice.members.set(CALLER, VOICE);

  async function run(name: string, args: Record<string, unknown> = {}, userId = CALLER) {
    const command = registry.find(name) as AnyCommand;
    const ctx = createFakeContext({ args, userId, guildId: GUILD });
    await executeCommand(command, ctx, silentLogger);
    await settle();
    return ctx;
  }

  /** The last panel posted, as it looks now. */
  function panel() {
    const id = panels.posts.at(-1);
    return id === undefined ? undefined : panels.messages.get(id)?.message;
  }

  function panelButton(name: string): ButtonSpec {
    const button = panel()
      ?.components?.flat()
      .find((c): c is ButtonSpec => c.type === "button" && c.customId.startsWith(`music:${name}:`));
    if (!button) throw new Error(`No ${name} button on the panel`);
    return button;
  }

  async function click(customId: string, userId = CALLER, values: string[] = []) {
    const ctx = await clickComponent({ registry, customId, userId, guildId: GUILD, values });
    await settle();
    return ctx;
  }

  function guildDelete() {
    const handler = module.events?.find((event) => event.event === "guildDelete");
    return handler?.run({ id: GUILD } as Guild);
  }

  function voiceUpdate() {
    const handler = module.events?.find((event) => event.event === "voiceStateUpdate");
    const state = { guild: { id: GUILD } } as VoiceState;
    return handler?.run(state, state);
  }

  return {
    player,
    voice,
    panels,
    directMessages,
    scheduler,
    module,
    registry,
    run,
    panel,
    panelButton,
    click,
    voiceUpdate,
    guildDelete,
  };
}

const lastText = (ctx: { replies: Reply[] }) => replyText(ctx.replies.at(-1));

describe("music module", () => {
  test("registers in the registry with its commands and aliases", () => {
    const { registry } = setup();
    for (const name of [
      "play",
      "p",
      "search",
      "queue",
      "skip",
      "stop",
      "pause",
      "resume",
      "nowplaying",
      "np",
    ]) {
      expect(registry.find(name)).toBeDefined();
    }
  });

  describe("/play", () => {
    test("refuses a caller outside voice", async () => {
      const { run, voice, player } = setup();
      voice.members.delete(CALLER);
      expect(lastText(await run("play", { query: "abc" }))).toBe(NOT_IN_VOICE);
      expect(player.searches).toHaveLength(0);
    });

    test("refuses a caller in another channel than the bot", async () => {
      const { run, voice } = setup();
      await run("play", { query: "abc" });
      voice.members.set(FRIEND, OTHER_VOICE);
      expect(lastText(await run("play", { query: "abc" }, FRIEND))).toBe(otherChannel(VOICE));
    });

    test("joins the caller's channel, starts playing and posts the panel there", async () => {
      const { run, player, panel } = setup();
      const ctx = await run("play", { query: "never gonna" });
      expect(ctx.deferred).toBe(true);
      expect(player.joins).toEqual([
        { guildId: GUILD, voiceChannelId: VOICE, textChannelId: TEXT },
      ]);
      expect(lastText(ctx)).toBe("Gram: **Pierwszy** (3:20).");
      expect(panel()?.embeds?.[0]?.title).toBe("Pierwszy");
    });

    test("queues behind the current track", async () => {
      const { run, player } = setup();
      await run("play", { query: "a" });
      player.nextResult = { kind: "tracks", tracks: [track("Drugi"), track("Trzeci")] };
      const ctx = await run("p", { query: "b" });
      expect(lastText(ctx)).toBe("Dodano do kolejki na miejsce 1: **Drugi** (3:20).");
      expect(player.state(GUILD)?.upcoming.map((t) => t.title)).toEqual(["Drugi"]);
    });

    test("sends http(s) links as links and everything else as search text", async () => {
      const { run, player } = setup();
      await run("play", { query: "https://youtu.be/dQw4w9WgXcQ" });
      await run("play", { query: "<https://www.youtube.com/watch?v=x>" });
      await run("play", { query: "local:/etc/passwd" });
      await run("play", { query: "file:///etc/passwd" });
      await run("play", { query: "ytsearch:lofi" });
      expect(player.searches.map((s) => s.query)).toEqual([
        { kind: "url", url: "https://youtu.be/dQw4w9WgXcQ" },
        { kind: "url", url: "https://www.youtube.com/watch?v=x" },
        { kind: "search", text: "local:/etc/passwd" },
        { kind: "search", text: "file:///etc/passwd" },
        { kind: "search", text: "ytsearch:lofi" },
      ]);
      expect(player.searches[0]?.requesterId).toBe(CALLER);
    });

    test("refuses an empty query before searching", async () => {
      const { run, player } = setup();
      expect(lastText(await run("play", { query: "   " }))).toBe("Podaj link albo czego szukać.");
      expect(player.searches).toHaveLength(0);
    });

    test("refuses links to other sites before searching", async () => {
      const { run, player } = setup();
      for (const query of [
        "https://example.com/a.mp3",
        "https://youtube.com.evil.com/x",
        "https://soundcloud.com/a/b",
      ]) {
        expect(lastText(await run("play", { query }))).toBe(UNSUPPORTED_LINK);
        expect(lastText(await run("search", { query }))).toBe(UNSUPPORTED_LINK);
      }
      expect(player.searches).toHaveLength(0);
    });

    test("joins the channel the caller is in after the search, not before", async () => {
      const { run, player, voice, panel } = setup();
      player.duringSearch = () => voice.members.set(CALLER, OTHER_VOICE);
      await run("play", { query: "a" });
      expect(player.joins.map((join) => join.voiceChannelId)).toEqual([OTHER_VOICE]);
      expect(player.state(GUILD)?.voiceChannelId).toBe(OTHER_VOICE);
      expect(panel()?.embeds?.[0]?.title).toBe("Pierwszy");
    });

    test("two quick /play calls join once and only the first one says it plays", async () => {
      const { registry, player } = setup();
      player.nextResult = { kind: "tracks", tracks: [track("A")] };
      const command = registry.find("play") as AnyCommand;
      const first = createFakeContext({ args: { query: "a" }, userId: CALLER, guildId: GUILD });
      const second = createFakeContext({ args: { query: "a" }, userId: CALLER, guildId: GUILD });
      await Promise.all([
        executeCommand(command, first, silentLogger),
        executeCommand(command, second, silentLogger),
      ]);
      await settle();
      expect(player.joins).toHaveLength(1);
      expect(lastText(first)).toBe("Gram: **A** (3:20).");
      expect(lastText(second)).toBe("Dodano do kolejki na miejsce 1: **A** (3:20).");
      expect(player.state(GUILD)?.upcoming.map((t) => t.title)).toEqual(["A"]);
    });

    test("the queue cap holds for additions that overlap", async () => {
      const { registry, player, run } = setup();
      const tracks = (n: number) => Array.from({ length: n }, (_, i) => track(`T${i}`));
      for (let i = 0; i < 4; i++) {
        player.nextResult = { kind: "playlist", name: "Lista", tracks: tracks(100) };
        await run("play", { query: "https://www.youtube.com/playlist?list=x" });
      }
      player.nextResult = { kind: "playlist", name: "Lista", tracks: tracks(100) };
      const command = registry.find("play") as AnyCommand;
      const ctxs = [0, 1].map(() =>
        createFakeContext({
          args: { query: "https://www.youtube.com/playlist?list=x" },
          userId: CALLER,
          guildId: GUILD,
        }),
      );
      await Promise.all(ctxs.map((ctx) => executeCommand(command, ctx, silentLogger)));
      await settle();
      const state = player.state(GUILD);
      expect((state?.upcoming.length ?? 0) + 1).toBe(MAX_QUEUE_LENGTH);
      expect(lastText(ctxs[1] as { replies: Reply[] })).toBe(
        `Kolejka jest pełna (${MAX_QUEUE_LENGTH} utworów).`,
      );
    });

    test("adds a playlist up to the cap and says how many were left out", async () => {
      const { run, player } = setup();
      const tracks = Array.from({ length: 120 }, (_, i) => track(`T${i}`));
      player.nextResult = { kind: "playlist", name: "Lista", tracks };
      const ctx = await run("play", { query: "https://www.youtube.com/playlist?list=x" });
      const state = player.state(GUILD);
      expect((state?.upcoming.length ?? 0) + 1).toBe(MAX_PLAYLIST_TRACKS);
      expect(lastText(ctx)).toStartWith("Dodano 100 utworów z playlisty **Lista**. Pominięto 20");
    });

    test("stops at the queue limit", async () => {
      const { run, player } = setup();
      const tracks = (n: number) => Array.from({ length: n }, (_, i) => track(`T${i}`));
      for (let i = 0; i < MAX_QUEUE_LENGTH / MAX_PLAYLIST_TRACKS; i++) {
        player.nextResult = { kind: "playlist", name: "Lista", tracks: tracks(100) };
        await run("play", { query: "https://www.youtube.com/playlist?list=x" });
      }
      const ctx = await run("play", { query: "jeszcze" });
      expect(lastText(ctx)).toBe(`Kolejka jest pełna (${MAX_QUEUE_LENGTH} utworów).`);
    });

    test("answers when nothing was found or the source failed", async () => {
      const { run, player } = setup();
      player.nextResult = { kind: "empty" };
      expect(lastText(await run("play", { query: "zzz" }))).toBe("Nic nie znaleziono.");
      player.nextResult = { kind: "error", message: "This video is unavailable" };
      expect(lastText(await run("play", { query: "zzz" }))).toBe(
        "Nie udało się wczytać tego utworu.",
      );
      expect(player.joins).toHaveLength(0);
    });
  });

  describe("/search", () => {
    test("offers up to ten results to the caller only and queues the chosen one", async () => {
      const { run, player, click } = setup();
      player.nextResult = {
        kind: "tracks",
        tracks: Array.from({ length: 15 }, (_, i) => track(`Wynik ${i}`)),
      };
      const ctx = await run("search", { query: "lofi" });
      const reply = ctx.replies[0] as Exclude<Reply, string>;
      expect(reply.ephemeral).toBe(true);
      const select = reply.components?.[0]?.[0] as SelectSpec;
      expect(select.options).toHaveLength(10);
      expect(select.options[3]?.description).toBe("Autor · 3:20");

      const stranger = await click(select.customId, FRIEND, ["3"]);
      expect(replyText(stranger.replies[0])).toBe("To nie Twoje menu.");

      const picked = await click(select.customId, CALLER, ["3"]);
      expect(picked.deferred).toBe(true);
      expect(replyText(picked.updates[0])).toBe("Gram: **Wynik 3** (3:20).");
      expect(player.state(GUILD)?.current?.title).toBe("Wynik 3");
    });

    test("re-checks the voice channel when the result is picked", async () => {
      const { run, click, voice, player } = setup();
      const ctx = await run("search", { query: "lofi" });
      const select = (ctx.replies[0] as Exclude<Reply, string>).components?.[0]?.[0] as SelectSpec;
      voice.members.delete(CALLER);
      const picked = await click(select.customId, CALLER, ["0"]);
      expect(replyText(picked.replies[0])).toBe(NOT_IN_VOICE);
      expect(player.state(GUILD)).toBeNull();
    });

    test("ignores a forged option value", async () => {
      const { run, click } = setup();
      const ctx = await run("search", { query: "lofi" });
      const select = (ctx.replies[0] as Exclude<Reply, string>).components?.[0]?.[0] as SelectSpec;
      const picked = await click(select.customId, CALLER, ["7"]);
      expect(replyText(picked.replies[0])).toBe("Nie ma takiego wyniku.");
    });
  });

  describe("/queue", () => {
    test("pages through the upcoming tracks", async () => {
      const { run, player, click } = setup();
      player.nextResult = {
        kind: "playlist",
        name: "Lista",
        tracks: Array.from({ length: 26 }, (_, i) => track(`T${i}`)),
      };
      await run("play", { query: "https://www.youtube.com/playlist?list=x" });
      const ctx = await run("queue");
      const page = ctx.replies[0] as Exclude<Reply, string>;
      expect(page.ephemeral).toBe(true);
      expect(page.embeds?.[0]?.description).toContain("**Teraz:** T0");
      expect(page.embeds?.[0]?.description).toContain("`1.` [T1]");
      expect(page.embeds?.[0]?.footer).toBe("25 utworów · 1:23:20");
      const nav = page.components?.at(-1) as ButtonSpec[];
      expect(nav[1]?.label).toBe("Strona 1/3");
      const next = await click(nav[2]?.customId ?? "");
      const second = next.updates[0] as Exclude<Reply, string>;
      expect(second.embeds?.[0]?.description).toContain("`11.` [T11]");
    });

    test("says when nothing plays", async () => {
      const { run } = setup();
      expect(lastText(await run("queue"))).toBe(NOTHING_PLAYING);
    });
  });

  describe("controls", () => {
    test("skip, pause, resume and stop act for anyone in the bot's channel", async () => {
      const { run, player, voice } = setup();
      player.nextResult = { kind: "tracks", tracks: [track("A")] };
      await run("play", { query: "a" });
      player.nextResult = { kind: "tracks", tracks: [track("B")] };
      await run("play", { query: "b" });
      voice.members.set(FRIEND, VOICE);

      expect(lastText(await run("pause", {}, FRIEND))).toBe("Wstrzymano.");
      expect(player.state(GUILD)?.paused).toBe(true);
      expect(lastText(await run("pause"))).toBe("Muzyka już jest wstrzymana.");
      expect(lastText(await run("resume"))).toBe("Wznowiono.");
      expect(lastText(await run("resume"))).toBe("Muzyka nie jest wstrzymana.");
      expect(lastText(await run("skip", {}, FRIEND))).toBe("Pominięto: **A**.");
      expect(player.state(GUILD)?.current?.title).toBe("B");
      expect(lastText(await run("stop"))).toBe("Zatrzymano muzykę i wyczyszczono kolejkę.");
      expect(player.state(GUILD)).toBeNull();
    });

    test("refuse members outside the bot's channel", async () => {
      const { run, voice, player } = setup();
      await run("play", { query: "a" });
      voice.members.set(FRIEND, OTHER_VOICE);
      for (const name of ["skip", "pause", "stop"]) {
        expect(lastText(await run(name, {}, FRIEND))).toBe(otherChannel(VOICE));
      }
      voice.members.delete(FRIEND);
      expect(lastText(await run("skip", {}, FRIEND))).toBe(NOT_IN_VOICE);
      expect(player.state(GUILD)?.current?.title).toBe("Pierwszy");
    });

    test("/stop clears the queue and leaves", async () => {
      const { run, player, panels } = setup();
      player.nextResult = { kind: "tracks", tracks: [track("A")] };
      for (let i = 0; i < 3; i++) await run("play", { query: "a" });
      expect(player.state(GUILD)?.upcoming).toHaveLength(2);
      await run("stop");
      expect(player.state(GUILD)).toBeNull();
      expect(panels.messages.size).toBe(0);
      // A new /play starts from an empty queue in a fresh player.
      await run("play", { query: "a" });
      expect(player.state(GUILD)?.upcoming).toHaveLength(0);
      expect(player.joins).toHaveLength(2);
    });

    test("/skip passes the track it saw, so a second skip of it does nothing", async () => {
      const { run, player } = setup();
      player.nextResult = { kind: "tracks", tracks: [track("A")] };
      await run("play", { query: "a" });
      player.nextResult = { kind: "tracks", tracks: [track("B")] };
      await run("play", { query: "b" });
      await run("skip");
      expect(player.skips).toEqual([{ guildId: GUILD, expectedTrackId: "encoded-A" }]);
      expect(player.state(GUILD)?.current?.title).toBe("B");
    });

    test("say when nothing plays", async () => {
      const { run } = setup();
      for (const name of ["skip", "stop", "pause", "resume", "nowplaying"]) {
        expect(lastText(await run(name))).toBe(NOTHING_PLAYING);
      }
    });

    test("/nowplaying shows the track with progress", async () => {
      const { run, player } = setup();
      await run("play", { query: "a" });
      const guild = player.players.get(GUILD);
      if (guild) guild.positionMs = 100_000;
      const reply = (await run("np")).replies[0] as Exclude<Reply, string>;
      const embed = reply.embeds?.[0];
      expect(embed?.title).toBe("Pierwszy");
      expect(embed?.url).toBe("https://www.youtube.com/watch?v=Pierwszy");
      expect(embed?.thumbnail).toBe("https://i.ytimg.com/vi/x/hqdefault.jpg");
      expect(embed?.description).toContain(`<@${CALLER}>`);
      expect(embed?.description).toContain("🔘");
      expect(embed?.description).toContain("1:40 / 3:20");
    });

    test("/nowplaying keeps the queue length when paused", async () => {
      const { run, player } = setup();
      await run("play", { query: "a" });
      await run("play", { query: "b" });
      await run("pause");
      const reply = (await run("nowplaying")).replies[0] as Exclude<Reply, string>;
      expect(reply.embeds?.[0]?.footer).toBe(
        "Wstrzymane · W kolejce: 1 · Pętla: wył. · Głośność: 100% · Filtr: brak",
      );
      player.finishTrack(GUILD);
      await run("pause");
      const alone = (await run("nowplaying")).replies[0] as Exclude<Reply, string>;
      expect(alone.embeds?.[0]?.footer).toBe(
        "Wstrzymane · Kolejka jest pusta · Pętla: wył. · Głośność: 100% · Filtr: brak",
      );
    });
  });

  describe("node down", () => {
    test("every command but stop answers that the player is unavailable", async () => {
      const { run, player } = setup();
      player.up = false;
      for (const name of ["play", "search"]) {
        expect(lastText(await run(name, { query: "a" }))).toBe(UNAVAILABLE);
      }
      for (const name of ["skip", "pause", "resume"]) {
        expect(lastText(await run(name))).toBe(UNAVAILABLE);
      }
      expect(lastText(await run("stop"))).toBe(NOTHING_PLAYING);
      expect(player.searches).toHaveLength(0);
    });

    test("/stop and the stop button still make the bot leave", async () => {
      const first = setup();
      await first.run("play", { query: "a" });
      first.player.up = false;
      expect(lastText(await first.run("skip"))).toBe(UNAVAILABLE);
      expect(lastText(await first.run("stop"))).toBe("Zatrzymano muzykę i wyczyszczono kolejkę.");
      expect(first.player.state(GUILD)).toBeNull();

      const second = setup();
      await second.run("play", { query: "a" });
      const stop = second.panelButton("panel-stop").customId;
      second.player.up = false;
      await second.click(stop);
      expect(second.player.state(GUILD)).toBeNull();
      expect(second.panels.messages.size).toBe(0);
    });
  });

  describe("now playing panel", () => {
    test("is edited on every track change and removed when the queue ends", async () => {
      const { run, player, panels, panel } = setup();
      player.nextResult = { kind: "tracks", tracks: [track("A")] };
      await run("play", { query: "a" });
      player.nextResult = { kind: "tracks", tracks: [track("B")] };
      await run("play", { query: "b" });
      expect(panels.posts).toEqual(["panel-1"]);
      expect(panel()?.embeds?.[0]?.footer).toBe(
        "W kolejce: 1 · Pętla: wył. · Głośność: 100% · Filtr: brak",
      );

      player.finishTrack(GUILD);
      await settle();
      expect(panels.posts).toEqual(["panel-1"]);
      expect(panels.edits).toContain("panel-1");
      expect(panel()?.embeds?.[0]?.title).toBe("B");

      player.finishTrack(GUILD);
      await settle();
      expect(panels.deletes).toEqual(["panel-1"]);
      expect(panels.messages.size).toBe(0);
    });

    test("is posted again when someone deleted it", async () => {
      const { run, player, panels } = setup();
      player.nextResult = { kind: "tracks", tracks: [track("A"), track("B")] };
      await run("play", { query: "a" });
      await run("play", { query: "b" });
      panels.messages.clear();
      player.finishTrack(GUILD);
      await settle();
      expect(panels.posts).toEqual(["panel-1", "panel-2"]);
    });

    test("stays when an edit fails for another reason, and is edited again next time", async () => {
      const { run, player, panels } = setup();
      player.nextResult = { kind: "tracks", tracks: [track("A"), track("B")] };
      await run("play", { query: "a" });
      await run("play", { query: "b" });
      await run("play", { query: "b" });
      panels.editError = new Error("Service Unavailable");
      player.finishTrack(GUILD);
      await settle();
      expect(panels.posts).toEqual(["panel-1"]);
      panels.editError = null;
      player.finishTrack(GUILD);
      await settle();
      expect(panels.posts).toEqual(["panel-1"]);
      expect(panels.edits.at(-1)).toBe("panel-1");
    });

    test("is removed when the player goes away", async () => {
      const { run, player, panels } = setup();
      await run("play", { query: "a" });
      player.destroy(GUILD);
      await settle();
      expect(panels.messages.size).toBe(0);
    });

    test("buttons refuse members outside the bot's channel", async () => {
      const { run, voice, click, panelButton, player } = setup();
      await run("play", { query: "a" });
      voice.members.set(FRIEND, OTHER_VOICE);
      for (const name of ["panel-pause", "panel-skip", "panel-stop"]) {
        const ctx = await click(panelButton(name).customId, FRIEND);
        expect(replyText(ctx.replies[0])).toBe(otherChannel(VOICE));
      }
      expect(player.state(GUILD)?.paused).toBe(false);
      expect(player.state(GUILD)?.current?.title).toBe("Pierwszy");
    });

    test("pause toggles and redraws the panel for anyone in the channel", async () => {
      const { run, voice, click, panelButton, player } = setup();
      await run("play", { query: "a" });
      voice.members.set(FRIEND, VOICE);
      const paused = await click(panelButton("panel-pause").customId, FRIEND);
      expect(player.state(GUILD)?.paused).toBe(true);
      const redrawn = paused.updates[0] as Exclude<Reply, string>;
      expect((redrawn.components?.[0]?.[0] as ButtonSpec | undefined)?.label).toBe("Wznów");
      await click(panelButton("panel-pause").customId, CALLER);
      expect(player.state(GUILD)?.paused).toBe(false);
    });

    test("a double click on skip skips one track", async () => {
      const { run, click, panelButton, player } = setup();
      for (const title of ["A", "B", "C"]) {
        player.nextResult = { kind: "tracks", tracks: [track(title)] };
        await run("play", { query: title });
      }
      const skip = panelButton("panel-skip").customId;
      const clicks = await Promise.all([click(skip), click(skip)]);
      expect(clicks.every((ctx) => ctx.deferred)).toBe(true);
      expect(player.state(GUILD)?.current?.title).toBe("B");
      expect(player.state(GUILD)?.upcoming.map((t) => t.title)).toEqual(["C"]);
    });

    test("stop answers the click before the panel is deleted", async () => {
      const { run, click, panelButton, panels } = setup();
      await run("play", { query: "a" });
      const order: string[] = [];
      const remove = panels.delete;
      panels.delete = async (channelId, messageId) => {
        order.push("delete");
        await remove(channelId, messageId);
      };
      const ctx = await click(panelButton("panel-stop").customId);
      expect(ctx.deferred).toBe(true);
      expect(ctx.replies).toHaveLength(0);
      expect(order).toEqual(["delete"]);
    });

    test("skip and stop buttons control playback", async () => {
      const { run, click, panelButton, player, panels } = setup();
      player.nextResult = { kind: "tracks", tracks: [track("A"), track("B")] };
      await run("play", { query: "a" });
      await run("play", { query: "b" });
      const skip = await click(panelButton("panel-skip").customId);
      expect(skip.deferred).toBe(true);
      expect(player.state(GUILD)?.current?.title).toBe("A");
      await click(panelButton("panel-stop").customId);
      expect(player.state(GUILD)).toBeNull();
      expect(panels.messages.size).toBe(0);
    });

    test("is not posted for a song the bot plays on its own", async () => {
      const { player, panels } = setup();
      player.playByBot(GUILD, VOICE, "Lato z Radiem");
      await settle();
      player.finishTrack(GUILD);
      await settle();
      expect(panels.posts).toEqual([]);
    });

    test("a member's /play during the bot's song brings the panel to their channel", async () => {
      const { run, player, panels, panel } = setup();
      player.playByBot(GUILD, VOICE, "Lato z Radiem");
      await settle();
      player.nextResult = { kind: "tracks", tracks: [track("A")] };
      const ctx = await run("play", { query: "a" });
      expect(lastText(ctx)).toContain("Dodano do kolejki na miejsce 1");
      // Still the bot's song: no panel for it, even with a track queued behind it.
      expect(panels.posts).toEqual([]);
      expect(player.state(GUILD)?.textChannelId).toBe(TEXT);

      player.finishTrack(GUILD);
      await settle();
      expect(panels.posts).toEqual(["panel-1"]);
      expect(panels.messages.get("panel-1")?.channelId).toBe(TEXT);
      expect(panel()?.embeds?.[0]?.title).toBe("A");
    });

    test("queue button opens the queue for the clicker only", async () => {
      const { run, click, panelButton, voice } = setup();
      await run("play", { query: "a" });
      voice.members.delete(FRIEND);
      const ctx = await click(panelButton("panel-queue").customId, FRIEND);
      const reply = ctx.replies[0] as Exclude<Reply, string>;
      expect(reply.ephemeral).toBe(true);
      expect(reply.embeds?.[0]?.title).toBe("Kolejka");
      const nav = reply.components?.at(-1) as ButtonSpec[];
      expect(nav[0]?.customId).toContain(`:${FRIEND}:`);
    });
  });

  describe("player events", () => {
    test("a failed track gets a short note in the panel's channel", async () => {
      const { run, player, panels } = setup();
      player.nextResult = { kind: "tracks", tracks: [track("Zły *tytuł* @everyone")] };
      await run("play", { query: "a" });
      player.nextResult = { kind: "tracks", tracks: [track("B")] };
      await run("play", { query: "b" });
      player.failTrack(GUILD);
      await settle();
      const notes = [...panels.messages.values()].filter((m) => m.message.content);
      expect(notes).toEqual([
        { channelId: TEXT, message: { content: trackFailedText("Zły *tytuł* @everyone") } },
      ]);
      expect(trackFailedText("Zły *tytuł*")).toBe(
        "Nie udało się odtworzyć **Zły \\*tytuł\\***, gram dalej.",
      );
      expect(player.state(GUILD)?.current?.title).toBe("B");
    });

    test("a failed track the bot played on its own gets no note", async () => {
      const { player, panels } = setup();
      player.playByBot(GUILD, VOICE, "Lato z Radiem");
      player.failTrack(GUILD);
      await settle();
      expect(panels.posts).toEqual([]);
    });

    test("leaving a server destroys its player", async () => {
      const { run, player, guildDelete, panels } = setup();
      await run("play", { query: "a" });
      await guildDelete();
      await settle();
      expect(player.state(GUILD)).toBeNull();
      expect(panels.messages.size).toBe(0);
      expect(await guildDelete()).toBeUndefined();
    });
  });

  describe("idle timeout", () => {
    test("leaves three minutes after the queue ran out", async () => {
      const { run, player, scheduler } = setup();
      await run("play", { query: "a" });
      player.finishTrack(GUILD);
      await settle();
      scheduler.advance(IDLE_MS - 1);
      await settle();
      expect(player.state(GUILD)).not.toBeNull();
      scheduler.advance(1);
      await settle();
      expect(player.state(GUILD)).toBeNull();
    });

    test("stays when music starts again in time", async () => {
      const { run, player, scheduler } = setup();
      await run("play", { query: "a" });
      player.finishTrack(GUILD);
      await settle();
      scheduler.advance(IDLE_MS - 1000);
      await run("play", { query: "b" });
      scheduler.advance(IDLE_MS);
      await settle();
      expect(player.state(GUILD)?.current?.title).toBe("Pierwszy");
      expect(scheduler.pending).toBe(0);
    });

    test("leaves three minutes after the last person left the channel", async () => {
      const { run, player, scheduler, voice, voiceUpdate } = setup();
      await run("play", { query: "a" });
      voice.members.delete(CALLER);
      await voiceUpdate();
      scheduler.advance(IDLE_MS);
      await settle();
      expect(player.state(GUILD)).toBeNull();
    });

    test("stays when someone comes back", async () => {
      const { run, player, scheduler, voice, voiceUpdate } = setup();
      await run("play", { query: "a" });
      voice.members.delete(CALLER);
      await voiceUpdate();
      scheduler.advance(IDLE_MS / 2);
      voice.members.set(FRIEND, VOICE);
      await voiceUpdate();
      scheduler.advance(IDLE_MS);
      await settle();
      expect(player.state(GUILD)).not.toBeNull();
      expect(scheduler.pending).toBe(0);
    });

    test("forgets the timer when the player is gone", async () => {
      const { run, player, scheduler } = setup();
      await run("play", { query: "a" });
      player.finishTrack(GUILD);
      await settle();
      expect(scheduler.pending).toBe(1);
      await run("stop");
      expect(scheduler.pending).toBe(0);
    });
  });

  describe("controls", () => {
    /** Plays the titles in order: the first one starts, the rest wait in the queue. */
    async function playing(titles: string[]) {
      const ctx = setup();
      for (const title of titles) {
        ctx.player.nextResult = { kind: "tracks", tracks: [track(title)] };
        await ctx.run("play", { query: title });
      }
      return ctx;
    }
    const upcoming = (ctx: Awaited<ReturnType<typeof playing>>) =>
      ctx.player.state(GUILD)?.upcoming.map((t) => t.title);

    test("every control command is registered", () => {
      const { registry } = setup();
      for (const name of [
        "loop",
        "shuffle",
        "seek",
        "volume",
        "vol",
        "filter",
        "remove",
        "jump",
        "back",
        "clear",
        "save",
        "sv",
      ]) {
        expect(registry.find(name)).toBeDefined();
      }
    });

    test("they need a voice channel, the bot's channel and a player", async () => {
      const { run, voice, player } = setup();
      const commands: [string, Record<string, unknown>][] = [
        ["loop", { mode: "track" }],
        ["shuffle", {}],
        ["seek", { time: "10" }],
        ["volume", { percent: 80 }],
        ["filter", { name: "nightcore" }],
        ["remove", { place: 1 }],
        ["jump", { place: 1 }],
        ["back", {}],
        ["clear", {}],
      ];
      for (const [name, args] of commands) {
        expect(lastText(await run(name, args))).toBe(NOTHING_PLAYING);
      }
      await run("play", { query: "a" });
      voice.members.set(FRIEND, OTHER_VOICE);
      for (const [name, args] of commands) {
        expect(lastText(await run(name, args, FRIEND))).toBe(otherChannel(VOICE));
      }
      voice.members.delete(FRIEND);
      for (const [name, args] of commands) {
        expect(lastText(await run(name, args, FRIEND))).toBe(NOT_IN_VOICE);
      }
      player.up = false;
      for (const [name, args] of commands) {
        expect(lastText(await run(name, args))).toBe(UNAVAILABLE);
      }
    });

    describe("/loop", () => {
      test("sets the mode and shows it on the panel", async () => {
        const ctx = await playing(["A"]);
        expect(lastText(await ctx.run("loop", { mode: "track" }))).toBe("Powtarzanie: **utwór**.");
        expect(ctx.player.state(GUILD)?.loop).toBe("track");
        expect(ctx.panel()?.embeds?.[0]?.footer).toContain("Pętla: utwór");
        await ctx.run("loop", { mode: "queue" });
        expect(ctx.player.state(GUILD)?.loop).toBe("queue");
        await ctx.run("loop", { mode: "off" });
        expect(ctx.player.state(GUILD)?.loop).toBe("off");
      });

      test("reads Polish and English words, as the prefix form gets them", async () => {
        const ctx = await playing(["A"]);
        for (const [mode, loop] of [
          ["utwór", "track"],
          ["wyłącz", "off"],
          ["KOLEJKA", "queue"],
          ["wyłączona", "off"],
          [" track ", "track"],
          ["off", "off"],
          ["queue", "queue"],
        ] as const) {
          await ctx.run("loop", { mode });
          expect(ctx.player.state(GUILD)?.loop).toBe(loop);
        }
      });

      test("refuses an unknown mode", async () => {
        const ctx = await playing(["A"]);
        for (const mode of ["forever", "constructor", "toString"]) {
          expect(lastText(await ctx.run("loop", { mode }))).toContain("`wyłącz`");
        }
        expect(ctx.player.state(GUILD)?.loop).toBe("off");
      });
    });

    describe("/shuffle", () => {
      test("mixes the queue and keeps the current track", async () => {
        const ctx = await playing(["A", "B", "C", "D"]);
        expect(lastText(await ctx.run("shuffle"))).toBe("Pomieszano kolejkę.");
        expect(ctx.player.shuffles).toEqual([GUILD]);
        expect(ctx.player.state(GUILD)?.current?.title).toBe("A");
        expect(upcoming(ctx)).toEqual(["D", "C", "B"]);
      });

      test("needs at least two tracks waiting", async () => {
        const ctx = await playing(["A", "B"]);
        expect(lastText(await ctx.run("shuffle"))).toContain("za mało utworów");
        expect(ctx.player.shuffles).toEqual([]);
      });
    });

    describe("/seek", () => {
      test("moves within the track and accepts the three time forms", async () => {
        const ctx = await playing(["A"]);
        for (const [time, ms] of [
          ["1:30", 90_000],
          ["90", 90_000],
          ["1m30s", 90_000],
          ["0", 0],
        ] as const) {
          const reply = lastText(await ctx.run("seek", { time }));
          expect(reply).toContain("Przewinięto");
          expect(ctx.player.state(GUILD)?.positionMs).toBe(ms);
        }
      });

      test("refuses a time it cannot read", async () => {
        const ctx = await playing(["A"]);
        for (const time of ["", "abc", "-5", "1:75", "1.5"]) {
          expect(lastText(await ctx.run("seek", { time }))).toContain("Nie rozumiem czasu");
        }
        expect(ctx.player.state(GUILD)?.positionMs).toBe(0);
      });

      test("refuses a time past the end, but accepts the end itself", async () => {
        const ctx = await playing(["A"]);
        expect(lastText(await ctx.run("seek", { time: "3:21" }))).toBe(
          "Utwór trwa tylko 3:20, nie przewinę dalej.",
        );
        expect(ctx.player.state(GUILD)?.positionMs).toBe(0);
        await ctx.run("seek", { time: "3:20" });
        expect(ctx.player.state(GUILD)?.positionMs).toBe(200_000);
      });

      test("refuses a track whose source cannot seek", async () => {
        const ctx = setup();
        ctx.player.nextResult = { kind: "tracks", tracks: [track("A", { isSeekable: false })] };
        await ctx.run("play", { query: "a" });
        expect(lastText(await ctx.run("seek", { time: "10" }))).toBe(
          "Tego utworu nie da się przewijać.",
        );
      });

      test("leaves a track that changed meanwhile alone and asks to try again", async () => {
        const ctx = await playing(["A", "B"]);
        ctx.player.skipInFlight = true;
        expect(lastText(await ctx.run("seek", { time: "10" }))).toBe(
          "Utwór zmienił się w międzyczasie, spróbuj jeszcze raz.",
        );
        expect(ctx.player.state(GUILD)?.positionMs).toBe(0);
      });

      test("refuses a stream", async () => {
        const ctx = setup();
        ctx.player.nextResult = {
          kind: "tracks",
          tracks: [track("Radio", { isStream: true, durationMs: 0 })],
        };
        await ctx.run("play", { query: "radio" });
        expect(lastText(await ctx.run("seek", { time: "10" }))).toBe(
          "Transmisji na żywo nie da się przewijać.",
        );
      });
    });

    describe("/volume", () => {
      test("starts at 100%, the source's own level", async () => {
        const ctx = await playing(["A"]);
        expect(ctx.player.state(GUILD)?.volume).toBe(100);
        expect(ctx.panel()?.embeds?.[0]?.footer).toContain("Głośność: 100%");
      });

      test("sets the level and shows it on the panel", async () => {
        const ctx = await playing(["A"]);
        expect(lastText(await ctx.run("volume", { percent: 120 }))).toBe("Głośność: **120%**.");
        expect(ctx.player.state(GUILD)?.volume).toBe(120);
        expect(ctx.panel()?.embeds?.[0]?.footer).toContain("Głośność: 120%");
      });

      test("takes 0 and 150, refuses anything outside", async () => {
        const ctx = await playing(["A"]);
        await ctx.run("volume", { percent: 0 });
        expect(ctx.player.state(GUILD)?.volume).toBe(0);
        await ctx.run("volume", { percent: 150 });
        expect(ctx.player.state(GUILD)?.volume).toBe(150);
        for (const percent of [-1, 151, 10.5, Number.NaN]) {
          expect(lastText(await ctx.run("volume", { percent }))).toBe(
            "Głośność musi być liczbą od 0 do 150.",
          );
        }
        expect(ctx.player.state(GUILD)?.volume).toBe(150);
      });
    });

    describe("/filter", () => {
      test("switches between effects and off", async () => {
        const ctx = await playing(["A"]);
        for (const name of ["bassboost", "nightcore", "vaporwave", "8d"] as const) {
          expect(lastText(await ctx.run("filter", { name }))).toContain("Efekt:");
          expect(ctx.player.state(GUILD)?.filter).toBe(name);
        }
        expect(ctx.panel()?.embeds?.[0]?.footer).toContain("Filtr: 8D");
        expect(lastText(await ctx.run("filter", { name: "off" }))).toBe("Wyłączono efekty.");
        expect(ctx.player.state(GUILD)?.filter).toBe("off");
      });

      test("setting the active effect again keeps it on", async () => {
        const ctx = await playing(["A"]);
        await ctx.run("filter", { name: "nightcore" });
        await ctx.run("filter", { name: "nightcore" });
        expect(ctx.player.state(GUILD)?.filter).toBe("nightcore");
      });

      test("reads Polish and English words, as the prefix form gets them", async () => {
        const ctx = await playing(["A"]);
        for (const [name, filter] of [
          ["bas", "bassboost"],
          ["wyłącz", "off"],
          ["8D", "8d"],
          ["Vaporwave", "vaporwave"],
          ["off", "off"],
        ] as const) {
          await ctx.run("filter", { name });
          expect(ctx.player.state(GUILD)?.filter).toBe(filter);
        }
      });

      test("two changes at once run one after the other", async () => {
        const ctx = await playing(["A"]);
        const order: string[] = [];
        const setFilter = ctx.player.setFilter;
        ctx.player.setFilter = async (guildId, filter) => {
          order.push(`start ${filter}`);
          await settle();
          await setFilter(guildId, filter);
          order.push(`end ${filter}`);
        };
        await Promise.all([
          ctx.run("filter", { name: "nightcore" }),
          ctx.run("filter", { name: "8d" }),
        ]);
        expect(order).toEqual(["start nightcore", "end nightcore", "start 8d", "end 8d"]);
        expect(ctx.player.state(GUILD)?.filter).toBe("8d");
      });

      test("refuses an unknown effect", async () => {
        const ctx = await playing(["A"]);
        for (const name of ["reverb", "constructor"]) {
          expect(lastText(await ctx.run("filter", { name }))).toContain("`bassboost`");
        }
        expect(ctx.player.state(GUILD)?.filter).toBe("off");
      });
    });

    describe("/remove and /jump", () => {
      test("remove takes the track at that place of /queue", async () => {
        const ctx = await playing(["A", "B", "C", "D"]);
        expect(lastText(await ctx.run("remove", { place: 2 }))).toBe("Usunięto z kolejki: **C**.");
        expect(upcoming(ctx)).toEqual(["B", "D"]);
      });

      test("jump plays that track and drops the ones before it", async () => {
        const ctx = await playing(["A", "B", "C", "D"]);
        expect(lastText(await ctx.run("jump", { place: 2 }))).toBe("Przeskoczono do: **C**.");
        expect(ctx.player.state(GUILD)?.current?.title).toBe("C");
        expect(upcoming(ctx)).toEqual(["D"]);
        expect(ctx.panel()?.embeds?.[0]?.title).toBe("C");
      });

      test("jump with the queue loop moves the passed tracks to the end", async () => {
        const ctx = await playing(["A", "B", "C", "D"]);
        await ctx.run("loop", { mode: "queue" });
        expect(lastText(await ctx.run("jump", { place: 3 }))).toBe("Przeskoczono do: **D**.");
        expect(ctx.player.state(GUILD)?.current?.title).toBe("D");
        expect(upcoming(ctx)).toEqual(["B", "C"]);
      });

      test("jump while a skip is on its way asks to try again", async () => {
        const ctx = await playing(["A", "B", "C"]);
        ctx.player.skipInFlight = true;
        expect(lastText(await ctx.run("jump", { place: 2 }))).toBe(queueChanged);
        expect(ctx.player.state(GUILD)?.current?.title).toBe("A");
      });

      test("both refuse an empty queue and a place outside it", async () => {
        const ctx = await playing(["A"]);
        for (const name of ["remove", "jump"]) {
          expect(lastText(await ctx.run(name, { place: 1 }))).toBe(EMPTY_QUEUE);
        }
        await ctx.run("play", { query: "B" });
        for (const name of ["remove", "jump"]) {
          for (const place of [0, -2, 2, 1.5]) {
            expect(lastText(await ctx.run(name, { place }))).toContain("Nie ma utworu na miejscu");
          }
        }
        expect(upcoming(ctx)).toEqual(["A"]);
      });

      test("a track that moved since the check is left alone", async () => {
        const ctx = await playing(["A", "B", "C"]);
        // The queue changes between the module reading it and the player acting on it.
        const remove = ctx.player.remove;
        ctx.player.remove = async (guildId, index) => remove(guildId, index, "someone-else");
        expect(lastText(await ctx.run("remove", { place: 1 }))).toBe(queueChanged);
        expect(upcoming(ctx)).toEqual(["B", "C"]);
        const jump = ctx.player.jump;
        ctx.player.jump = async (guildId, index) => jump(guildId, index, "someone-else");
        expect(lastText(await ctx.run("jump", { place: 2 }))).toBe(queueChanged);
        expect(ctx.player.state(GUILD)?.current?.title).toBe("A");
      });

      test("two removals at once take two different tracks", async () => {
        const ctx = await playing(["A", "B", "C", "D"]);
        await Promise.all([ctx.run("remove", { place: 1 }), ctx.run("remove", { place: 1 })]);
        expect(upcoming(ctx)).toEqual(["D"]);
      });
    });

    describe("/back", () => {
      test("plays the previous track again and keeps the current one next", async () => {
        const ctx = await playing(["A", "B"]);
        ctx.player.finishTrack(GUILD);
        await settle();
        expect(ctx.player.state(GUILD)?.current?.title).toBe("B");
        expect(lastText(await ctx.run("back"))).toBe("Wracam do: **A**.");
        expect(ctx.player.state(GUILD)?.current?.title).toBe("A");
        expect(upcoming(ctx)).toEqual(["B"]);
        expect(ctx.panel()?.embeds?.[0]?.title).toBe("A");
      });

      test("says so when nothing played before", async () => {
        const ctx = await playing(["A"]);
        expect(lastText(await ctx.run("back"))).toBe("Nie ma poprzedniego utworu.");
        expect(ctx.player.state(GUILD)?.current?.title).toBe("A");
      });

      test("asks to try again while a skip is on its way", async () => {
        const ctx = await playing(["A", "B"]);
        ctx.player.finishTrack(GUILD);
        ctx.player.skipInFlight = true;
        expect(lastText(await ctx.run("back"))).toBe(queueChanged);
        expect(ctx.player.state(GUILD)?.current?.title).toBe("B");
      });
    });

    describe("/clear", () => {
      test("empties the queue and lets the current track play", async () => {
        const ctx = await playing(["A", "B", "C"]);
        expect(lastText(await ctx.run("clear"))).toBe("Wyczyszczono kolejkę (2 utwory).");
        expect(upcoming(ctx)).toEqual([]);
        expect(ctx.player.state(GUILD)?.current?.title).toBe("A");
        expect(ctx.panel()?.embeds?.[0]?.footer).toStartWith("Kolejka jest pusta");
      });

      test("refuses an empty queue", async () => {
        const ctx = await playing(["A"]);
        expect(lastText(await ctx.run("clear"))).toBe(EMPTY_QUEUE);
      });
    });

    describe("/save", () => {
      test("sends the track to the caller in a DM and confirms privately", async () => {
        const ctx = await playing(["A_b"]);
        const reply = (await ctx.run("save")).replies[0] as Exclude<Reply, string>;
        expect(reply.ephemeral).toBe(true);
        expect(reply.content).toBe("Wysłałem Ci ten utwór w wiadomości prywatnej.");
        expect(ctx.directMessages.sent).toHaveLength(1);
        const [dm] = ctx.directMessages.sent;
        expect(dm?.userId).toBe(CALLER);
        expect(dm?.message.content).toBe(
          "**A\\_b**\n**Autor:** Autor\n<https://www.youtube.com/watch?v=A_b>",
        );
      });

      test("works for anyone in the server, in voice or not", async () => {
        const ctx = await playing(["A"]);
        ctx.player.up = false;
        const reply = (await ctx.run("save", {}, FRIEND)).replies[0] as Exclude<Reply, string>;
        expect(reply.content).toBe("Wysłałem Ci ten utwór w wiadomości prywatnej.");
        expect(ctx.directMessages.sent.map((dm) => dm.userId)).toEqual([FRIEND]);
      });

      test("says nothing plays when nothing does", async () => {
        const ctx = setup();
        expect(lastText(await ctx.run("save", {}, FRIEND))).toBe(NOTHING_PLAYING);
        expect(ctx.directMessages.sent).toEqual([]);
      });

      test("works through the sv alias", async () => {
        const ctx = await playing(["A"]);
        await ctx.run("sv");
        expect(ctx.directMessages.sent).toHaveLength(1);
      });

      test("tells the caller privately when DMs are closed", async () => {
        const ctx = await playing(["A"]);
        ctx.directMessages.open = false;
        const reply = (await ctx.run("save")).replies[0] as Exclude<Reply, string>;
        expect(reply.ephemeral).toBe(true);
        expect(reply.content).toContain("Nie mogę Ci wysłać wiadomości prywatnej");
        expect(ctx.directMessages.sent).toHaveLength(0);
      });

      test("leaves out a link the source does not have", async () => {
        const ctx = setup();
        ctx.player.nextResult = { kind: "tracks", tracks: [track("A", { uri: null })] };
        await ctx.run("play", { query: "a" });
        await ctx.run("save");
        expect(ctx.directMessages.sent[0]?.message.content).toBe("**A**\n**Autor:** Autor");
      });
    });

    describe("panel buttons", () => {
      test("loop cycles off, track, queue and shows the mode on the button", async () => {
        const ctx = await playing(["A"]);
        const loop = ctx.panelButton("panel-loop");
        expect(loop.label).toBe("Pętla: wył.");
        const modes: string[] = [];
        const labels: (string | undefined)[] = [];
        for (let i = 0; i < 3; i++) {
          const clicked = await ctx.click(ctx.panelButton("panel-loop").customId, CALLER);
          modes.push(ctx.player.state(GUILD)?.loop ?? "");
          const redrawn = clicked.updates[0] as Exclude<Reply, string>;
          labels.push((redrawn.components?.[1]?.[0] as ButtonSpec | undefined)?.label);
        }
        expect(modes).toEqual(["track", "queue", "off"]);
        expect(labels).toEqual(["Pętla: utwór", "Pętla: kolejka", "Pętla: wył."]);
      });

      test("a double click on loop moves two steps, not one", async () => {
        const ctx = await playing(["A"]);
        const id = ctx.panelButton("panel-loop").customId;
        await Promise.all([ctx.click(id), ctx.click(id)]);
        expect(ctx.player.state(GUILD)?.loop).toBe("queue");
      });

      test("shuffle mixes the queue and redraws the panel", async () => {
        const ctx = await playing(["A", "B", "C"]);
        const clicked = await ctx.click(ctx.panelButton("panel-shuffle").customId);
        expect(upcoming(ctx)).toEqual(["C", "B"]);
        expect(clicked.updates).toHaveLength(1);
      });

      test("shuffle on a short queue answers privately and changes nothing", async () => {
        const ctx = await playing(["A", "B"]);
        const clicked = await ctx.click(ctx.panelButton("panel-shuffle").customId);
        expect(replyText(clicked.replies[0])).toContain("za mało utworów");
        expect(ctx.player.shuffles).toEqual([]);
      });

      test("both refuse members outside the bot's channel", async () => {
        const ctx = await playing(["A", "B", "C"]);
        ctx.voice.members.set(FRIEND, OTHER_VOICE);
        for (const name of ["panel-loop", "panel-shuffle"]) {
          const clicked = await ctx.click(ctx.panelButton(name).customId, FRIEND);
          expect(replyText(clicked.replies[0])).toBe(otherChannel(VOICE));
        }
        expect(ctx.player.state(GUILD)?.loop).toBe("off");
        expect(ctx.player.shuffles).toEqual([]);
      });

      test("both answer when nothing plays anymore", async () => {
        const ctx = await playing(["A", "B", "C"]);
        const ids = ["panel-loop", "panel-shuffle"].map((n) => ctx.panelButton(n).customId);
        ctx.player.destroy(GUILD);
        for (const id of ids) {
          expect(replyText((await ctx.click(id)).replies[0])).toBe(NOTHING_PLAYING);
        }
      });
    });
  });

  test("dispose cancels timers, removes panels and stops listening", async () => {
    const { run, player, scheduler, panels, module } = setup();
    player.nextResult = { kind: "tracks", tracks: [track("A")] };
    await run("play", { query: "a" });
    await module.dispose?.();
    expect(panels.messages.size).toBe(0);
    player.finishTrack(GUILD);
    await settle();
    expect(scheduler.pending).toBe(0);
    expect(panels.posts).toEqual(["panel-1"]);
  });
});
