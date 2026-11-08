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
import type { VoiceState } from "discord.js";
import {
  createFakePanels,
  createFakePlayer,
  createFakeVoice,
  createMemoryStorage,
  settle,
  track,
} from "./fakes.test-support.ts";
import {
  createMusicModule,
  IDLE_MS,
  MAX_PLAYLIST_TRACKS,
  MAX_QUEUE_LENGTH,
  NOT_IN_VOICE,
  NOTHING_PLAYING,
  otherChannel,
  UNAVAILABLE,
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
  const scheduler = createFakeScheduler();
  const module = createMusicModule({
    player,
    voice,
    panels,
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

  function voiceUpdate() {
    const handler = module.events?.find((event) => event.event === "voiceStateUpdate");
    const state = { guild: { id: GUILD } } as VoiceState;
    return handler?.run(state, state);
  }

  return {
    player,
    voice,
    panels,
    scheduler,
    module,
    registry,
    run,
    panel,
    panelButton,
    click,
    voiceUpdate,
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
        await run("play", { query: "https://x.example/list" });
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
      await run("play", { query: "https://x.example/list" });
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
  });

  describe("node down", () => {
    test("every command answers that the player is unavailable", async () => {
      const { run, player } = setup();
      player.up = false;
      for (const name of ["play", "search"]) {
        expect(lastText(await run(name, { query: "a" }))).toBe(UNAVAILABLE);
      }
      for (const name of ["skip", "stop", "pause", "resume"]) {
        expect(lastText(await run(name))).toBe(UNAVAILABLE);
      }
      expect(player.searches).toHaveLength(0);
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
      expect(panel()?.embeds?.[0]?.footer).toBe("W kolejce: 1");

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
