import { describe, expect, test } from "bun:test";
import {
  type CronScheduler,
  createRegistry,
  executeCommand,
  type LogFields,
  type Logger,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext, replyText } from "@dzajcarz/core/testing";
import {
  createScheduleModule,
  pickChannel,
  type ScheduledSongPlayer,
  type ScheduleSettings,
  type ScheduleVoice,
  type VoiceCrowd,
} from "./index.ts";

const MANAGE_GUILD = 1n << 5n;
const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000002";
const LOUNGE = "400000000000000004";
const GAMES = "400000000000000005";
const QUIET = "400000000000000006";

const SONGS = [
  { name: "lato_z_radiem", title: "Lato z Radiem" },
  { name: "icona_pop", title: "Icona Pop" },
] as const;

/** 9:00 on 1 July in Warsaw (summer time, UTC+2). */
const NINE_WARSAW = new Date("2026-07-01T07:00:00Z");

interface PlayCall {
  guildId: string;
  voiceChannelId: string;
  song: string;
}

function setup(
  options: {
    crowds?: Record<string, VoiceCrowd[]>;
    disabled?: string[];
    playing?: string[];
    available?: boolean;
    failFor?: string[];
    busy?: string[];
    afk?: Record<string, string>;
    /** Delays the first settings read, so a test can fire a second run in between. */
    slowSettings?: Promise<void>;
    /** Server time zones (`/timezone`); others use Warsaw time. */
    zones?: Record<string, string>;
    /** When the tick fires; 9:00 in Warsaw unless set. */
    now?: Date;
  } = {},
) {
  let current = options.now ?? NINE_WARSAW;
  const crowds = options.crowds ?? {};
  const songChoice = new Map<string, string>();
  const excluded = new Map<string, string[]>();
  const settings: ScheduleSettings = {
    getSong: async (guildId) => songChoice.get(guildId) ?? null,
    setSong: async (guildId, song) => void songChoice.set(guildId, song),
    clearSong: async (guildId) => songChoice.delete(guildId),
    listExcluded: async (guildId) => {
      await options.slowSettings;
      return excluded.get(guildId) ?? [];
    },
    addExcluded: async (guildId, channelId) => {
      const list = excluded.get(guildId) ?? [];
      if (list.includes(channelId)) return false;
      excluded.set(guildId, [...list, channelId]);
      return true;
    },
    removeExcluded: async (guildId, channelId) => {
      const list = excluded.get(guildId) ?? [];
      excluded.set(
        guildId,
        list.filter((id) => id !== channelId),
      );
      return list.includes(channelId);
    },
  };
  const voice: ScheduleVoice = {
    guildIds: () => Object.keys(crowds),
    crowds: async (guildId) => crowds[guildId] ?? [],
    afkChannelId: (guildId) => options.afk?.[guildId] ?? null,
    isVoiceChannelOf: async (guildId, channelId) =>
      (crowds[guildId] ?? []).some((crowd) => crowd.channelId === channelId),
  };

  const playCalls: PlayCall[] = [];
  const leaves: string[] = [];
  const finishers = new Map<string, (queued: boolean) => void>();
  const player: ScheduledSongPlayer = {
    available: () => options.available ?? true,
    isPlaying: (guildId) => options.playing?.includes(guildId) ?? false,
    play(guildId, voiceChannelId, song) {
      if (options.failFor?.includes(guildId)) return Promise.reject(new Error("Join failed"));
      playCalls.push({ guildId, voiceChannelId, song });
      if (options.busy?.includes(guildId)) return Promise.resolve({ status: "busy" });
      return new Promise((resolve) => {
        finishers.set(guildId, (queued) => resolve({ status: "played", queued }));
      });
    },
    leave: async (guildId) => void leaves.push(guildId),
  };

  let task: (() => void | Promise<void>) | null = null;
  const cronCalls: { expression: string; timeZone: string }[] = [];
  let stopped = false;
  const cron: CronScheduler = {
    every(expression, timeZone, run) {
      cronCalls.push({ expression, timeZone });
      task = run;
      return () => {
        stopped = true;
      };
    },
  };

  const warnings: { message: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    ...silentLogger,
    warn: (message, fields) => void warnings.push({ message, fields }),
    child: () => logger,
  };

  const module = createScheduleModule({
    settings,
    voice,
    player,
    cron,
    moduleEnabled: async (_guildId, channelId) => !options.disabled?.includes(channelId),
    logger,
    songs: SONGS,
    expression: "0 9,21 * * *",
    timeZones: { of: async (guildId) => (guildId && options.zones?.[guildId]) || "Europe/Warsaw" },
    now: () => current,
  });
  const registry = createRegistry([module]);
  const command = registry.find("schedule");
  if (!command) throw new Error("schedule command missing");

  /** The cron fires; the returned promise settles once every server was handled. */
  const fire = async () => {
    if (!task) throw new Error("nothing scheduled");
    await task();
  };
  /** Lets the awaits inside a run reach `player.play`. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  const run = async (
    subcommand: string,
    args: Record<string, unknown> = {},
    memberPermissions: bigint = MANAGE_GUILD,
  ) => {
    const ctx = createFakeContext({ args, subcommand, memberPermissions });
    await executeCommand(command, ctx, silentLogger);
    return ctx.replies.map((reply) => replyText(reply));
  };

  return {
    module,
    fire,
    settle,
    run,
    playCalls,
    leaves,
    finishers,
    cronCalls,
    songChoice,
    excluded,
    warnings,
    isStopped: () => stopped,
    setNow: (date: Date) => {
      current = date;
    },
  };
}

/** Runs the schedule and lets every server start; the songs stay on until `finishers` end them. */
async function fireAndStart(s: ReturnType<typeof setup>) {
  const done = s.fire();
  await s.settle();
  return done;
}

describe("the schedule", () => {
  test("plays at 9:00 on each server's own clock", async () => {
    const crowd = (id: string) => [{ channelId: id, humans: 2 }];
    const s = setup({
      crowds: { [GUILD]: crowd("500000000000000001"), [OTHER_GUILD]: crowd("500000000000000002") },
      zones: { [OTHER_GUILD]: "Europe/London" },
    });
    void s.fire();
    await s.settle();
    expect(s.playCalls.map((call) => call.guildId)).toEqual([GUILD]);
    s.finishers.get(GUILD)?.(false);
    // An hour later it is 9:00 in London.
    s.setNow(new Date(NINE_WARSAW.getTime() + 3_600_000));
    void s.fire();
    await s.settle();
    expect(s.playCalls.map((call) => call.guildId)).toEqual([GUILD, OTHER_GUILD]);
  });

  test("nothing plays at a minute the expression does not fire on", async () => {
    const s = setup({ crowds: { [GUILD]: [{ channelId: "500000000000000001", humans: 2 }] } });
    s.setNow(new Date(NINE_WARSAW.getTime() + 60_000));
    await s.fire();
    expect(s.playCalls).toEqual([]);
  });

  test("a tick a few seconds early still counts as 9:00", async () => {
    const s = setup({
      crowds: { [GUILD]: [{ channelId: "500000000000000001", humans: 2 }] },
      now: new Date(NINE_WARSAW.getTime() - 2_000),
    });
    void s.fire();
    await s.settle();
    expect(s.playCalls).toHaveLength(1);
  });

  test("ticks every minute and stops on dispose", async () => {
    const s = setup();
    expect(s.cronCalls).toEqual([{ expression: "* * * * *", timeZone: "UTC" }]);
    await s.module.dispose?.();
    expect(s.isStopped()).toBe(true);
  });

  test("plays the default song in the most crowded channel", async () => {
    const s = setup({
      crowds: {
        [GUILD]: [
          { channelId: LOUNGE, humans: 2 },
          { channelId: GAMES, humans: 5 },
          { channelId: QUIET, humans: 0 },
        ],
      },
    });
    const done = fireAndStart(s);
    await s.settle();
    expect(s.playCalls).toEqual([{ guildId: GUILD, voiceChannelId: GAMES, song: "lato_z_radiem" }]);
    s.finishers.get(GUILD)?.(false);
    await done;
  });

  test("a tie goes to the older channel", () => {
    expect(
      pickChannel([
        { channelId: GAMES, humans: 3 },
        { channelId: LOUNGE, humans: 3 },
      ])?.channelId,
    ).toBe(LOUNGE);
  });

  test("uses the song the server chose", async () => {
    const s = setup({ crowds: { [GUILD]: [{ channelId: LOUNGE, humans: 1 }] } });
    s.songChoice.set(GUILD, "icona_pop");
    const done = fireAndStart(s);
    await s.settle();
    expect(s.playCalls[0]?.song).toBe("icona_pop");
    s.finishers.get(GUILD)?.(false);
    await done;
  });

  test("falls back to the default when the stored song is no longer in the list", async () => {
    const s = setup({ crowds: { [GUILD]: [{ channelId: LOUNGE, humans: 1 }] } });
    s.songChoice.set(GUILD, "removed_song");
    const done = fireAndStart(s);
    await s.settle();
    expect(s.playCalls[0]?.song).toBe("lato_z_radiem");
    s.finishers.get(GUILD)?.(false);
    await done;
  });

  test("skips excluded channels and takes the next busiest", async () => {
    const s = setup({
      crowds: {
        [GUILD]: [
          { channelId: GAMES, humans: 5 },
          { channelId: LOUNGE, humans: 2 },
        ],
      },
    });
    s.excluded.set(GUILD, [GAMES]);
    const done = fireAndStart(s);
    await s.settle();
    expect(s.playCalls.map((call) => call.voiceChannelId)).toEqual([LOUNGE]);
    s.finishers.get(GUILD)?.(false);
    await done;
  });

  test("skips channels where the module is switched off", async () => {
    const s = setup({
      crowds: {
        [GUILD]: [
          { channelId: GAMES, humans: 5 },
          { channelId: LOUNGE, humans: 2 },
        ],
      },
      disabled: [GAMES],
    });
    const done = fireAndStart(s);
    await s.settle();
    expect(s.playCalls.map((call) => call.voiceChannelId)).toEqual([LOUNGE]);
    s.finishers.get(GUILD)?.(false);
    await done;
  });

  test("plays nothing when only excluded or empty channels are left", async () => {
    const s = setup({
      crowds: {
        [GUILD]: [
          { channelId: GAMES, humans: 5 },
          { channelId: QUIET, humans: 0 },
        ],
      },
    });
    s.excluded.set(GUILD, [GAMES]);
    await s.fire();
    expect(s.playCalls).toEqual([]);
  });

  test("plays nothing when nobody is in voice", async () => {
    const s = setup({ crowds: { [GUILD]: [] } });
    await s.fire();
    expect(s.playCalls).toEqual([]);
  });

  test("does not interrupt music that is already playing", async () => {
    const s = setup({
      crowds: { [GUILD]: [{ channelId: LOUNGE, humans: 3 }] },
      playing: [GUILD],
    });
    await s.fire();
    expect(s.playCalls).toEqual([]);
    expect(s.leaves).toEqual([]);
  });

  test("handles every server on its own", async () => {
    const s = setup({
      crowds: {
        [GUILD]: [{ channelId: LOUNGE, humans: 1 }],
        [OTHER_GUILD]: [{ channelId: GAMES, humans: 4 }],
      },
      playing: [GUILD],
    });
    const done = fireAndStart(s);
    await s.settle();
    expect(s.playCalls).toEqual([
      { guildId: OTHER_GUILD, voiceChannelId: GAMES, song: "lato_z_radiem" },
    ]);
    s.finishers.get(OTHER_GUILD)?.(false);
    await done;
  });

  test("one server failing does not stop the others", async () => {
    const s = setup({
      crowds: {
        [GUILD]: [{ channelId: LOUNGE, humans: 1 }],
        [OTHER_GUILD]: [{ channelId: GAMES, humans: 1 }],
      },
      failFor: [GUILD],
    });
    const done = fireAndStart(s);
    await s.settle();
    expect(s.playCalls.map((call) => call.guildId)).toEqual([OTHER_GUILD]);
    s.finishers.get(OTHER_GUILD)?.(false);
    await done;
    expect(s.warnings.map((w) => w.message)).toEqual(["The scheduled song failed"]);
    expect(s.warnings[0]?.fields?.guildId).toBe(GUILD);
  });

  test("leaves after the song when nothing else is queued", async () => {
    const s = setup({ crowds: { [GUILD]: [{ channelId: LOUNGE, humans: 1 }] } });
    const done = fireAndStart(s);
    await s.settle();
    s.finishers.get(GUILD)?.(false);
    await done;
    expect(s.leaves).toEqual([GUILD]);
  });

  test("stays when a member queued something meanwhile", async () => {
    const s = setup({ crowds: { [GUILD]: [{ channelId: LOUNGE, humans: 1 }] } });
    const done = fireAndStart(s);
    await s.settle();
    s.finishers.get(GUILD)?.(true);
    await done;
    expect(s.leaves).toEqual([]);
  });

  test("does nothing while the audio node is down", async () => {
    const s = setup({
      crowds: { [GUILD]: [{ channelId: LOUNGE, humans: 1 }] },
      available: false,
    });
    await s.fire();
    expect(s.playCalls).toEqual([]);
    expect(s.warnings).toHaveLength(1);
  });

  test("never plays in the server's AFK channel, however full it is", async () => {
    const s = setup({
      crowds: {
        [GUILD]: [
          { channelId: QUIET, humans: 9 },
          { channelId: LOUNGE, humans: 1 },
        ],
      },
      afk: { [GUILD]: QUIET },
    });
    const done = fireAndStart(s);
    await s.settle();
    expect(s.playCalls.map((call) => call.voiceChannelId)).toEqual([LOUNGE]);
    s.finishers.get(GUILD)?.(false);
    await done;
  });

  test("skips the song without leaving when members' music got there first", async () => {
    const s = setup({ crowds: { [GUILD]: [{ channelId: LOUNGE, humans: 1 }] }, busy: [GUILD] });
    await s.fire();
    expect(s.playCalls).toHaveLength(1);
    expect(s.leaves).toEqual([]);
    expect(s.warnings).toEqual([]);
  });

  test("a second run during the first one's lookups does not play twice", async () => {
    let release = () => {};
    const slowSettings = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = setup({ crowds: { [GUILD]: [{ channelId: LOUNGE, humans: 1 }] }, slowSettings });
    const first = s.fire();
    await s.fire();
    release();
    await s.settle();
    expect(s.playCalls).toHaveLength(1);
    s.finishers.get(GUILD)?.(false);
    await first;
  });

  test("a run that starts while the song is still on does not start a second one", async () => {
    const s = setup({ crowds: { [GUILD]: [{ channelId: LOUNGE, humans: 1 }] } });
    const first = fireAndStart(s);
    await s.settle();
    await s.fire();
    expect(s.playCalls).toHaveLength(1);
    s.finishers.get(GUILD)?.(false);
    await first;
  });
});

describe("/schedule", () => {
  const crowds = { [GUILD]: [{ channelId: LOUNGE, humans: 1 }] };

  test("is limited to Manage Server", async () => {
    const { run, excluded } = setup({ crowds });
    const [reply] = await run("exclude", { channel: LOUNGE }, 0n);
    expect(reply).toContain("uprawnień");
    expect(excluded.size).toBe(0);
  });

  test("exclude, list and include a voice channel", async () => {
    const { run, excluded } = setup({ crowds });
    expect(await run("exclude", { channel: LOUNGE })).toEqual([
      `Kanał <#${LOUNGE}> jest wykluczony.`,
    ]);
    expect(excluded.get(GUILD)).toEqual([LOUNGE]);
    expect(await run("exclude", { channel: LOUNGE })).toEqual([
      `Kanał <#${LOUNGE}> był już wykluczony.`,
    ]);
    const [listing] = await run("list");
    expect(listing).toContain(`<#${LOUNGE}>`);
    expect(listing).toContain("Lato z Radiem");
    expect(listing).toContain("0 9,21 * * *");
    expect(await run("include", { channel: LOUNGE })).toEqual([
      `Kanał <#${LOUNGE}> nie jest już wykluczony.`,
    ]);
    expect(await run("include", { channel: LOUNGE })).toEqual([
      `Kanał <#${LOUNGE}> nie był wykluczony.`,
    ]);
  });

  test("refuses to exclude something that is not a voice channel of the server", async () => {
    const { run, excluded } = setup({ crowds });
    const [reply] = await run("exclude", { channel: "999000000000000009" });
    expect(reply).toContain("kanał głosowy");
    expect(excluded.size).toBe(0);
  });

  test("song picks from the fixed list and refuses anything else", async () => {
    const { run, songChoice } = setup({ crowds });
    expect(await run("song", { name: "icona_pop" })).toEqual(["Wybrana piosenka: **Icona Pop**."]);
    expect(songChoice.get(GUILD)).toBe("icona_pop");
    const [refused] = await run("song", { name: "/etc/passwd" });
    expect(refused).toContain("Nie znam piosenki");
    expect(songChoice.get(GUILD)).toBe("icona_pop");
    const [shown] = await run("song");
    expect(shown).toContain("Icona Pop");
    expect(shown).toContain("lato_z_radiem");
  });

  test("song reset goes back to the default song", async () => {
    const { run, songChoice } = setup({ crowds });
    songChoice.set(GUILD, "icona_pop");
    expect(await run("song", { name: "reset" })).toEqual([
      "Przywrócono domyślną piosenkę: **Lato z Radiem**.",
    ]);
    expect(songChoice.has(GUILD)).toBe(false);
    expect(await run("song", { name: "reset" })).toEqual([
      "Już gra domyślna piosenka: **Lato z Radiem**.",
    ]);
    const [shown] = await run("song");
    expect(shown).toContain("Teraz: **Lato z Radiem**");
  });

  test("a song may not be named like the reset value", () => {
    expect(() =>
      createScheduleModule({
        settings: {} as ScheduleSettings,
        voice: {} as ScheduleVoice,
        player: {} as ScheduledSongPlayer,
        cron: { every: () => () => {} },
        moduleEnabled: async () => true,
        logger: silentLogger,
        songs: [{ name: "reset", title: "Reset" }],
        expression: "0 9 * * *",
        timeZones: { of: async () => "Europe/Warsaw" },
        now: () => NINE_WARSAW,
      }),
    ).toThrow("reserved");
  });
});
