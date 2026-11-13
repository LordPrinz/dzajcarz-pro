import { describe, expect, test } from "bun:test";
import {
  type AnyCommand,
  type ButtonSpec,
  type ComponentRow,
  type CronScheduler,
  createRegistry,
  executeCommand,
  type Locale,
  type LocaleResolver,
  type LogFields,
  type Logger,
  silentLogger,
} from "@dzajcarz/core";
import {
  clickComponent,
  createFakeContext,
  fakeLocales,
  renderCatalog,
  replyText,
  submitModal,
} from "@dzajcarz/core/testing";
import {
  createMemoryStore,
  createStalledStore,
  createTimedStore,
  type KeyValueStore,
} from "@dzajcarz/kv";
import {
  createMessagesModule,
  MAX_ATTEMPTS_PER_DAY,
  MAX_CONTENT_LENGTH,
  MAX_DMS_PER_RECIPIENT,
  MAX_DUE_PER_TICK,
  MAX_MESSAGES_PER_GUILD,
  type MessageTarget,
  type ScheduledMessage,
  type ScheduledMessageSender,
  type ScheduledMessageStore,
} from "./index.ts";
import { localMinute } from "./local-minute.test-support.ts";
import { t } from "./messages.ts";

const MANAGE_GUILD = 1n << 5n;
const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000002";
const ADMIN = "200000000000000002";
const MEMBER = "200000000000000005";
const SECOND_MEMBER = "200000000000000006";
const STRANGER = "200000000000000007";
const BOT_USER = "200000000000000008";
const GENERAL = "400000000000000004";
const NEWS = "400000000000000005";
const VOICE = "400000000000000006";
const ZONE = "Europe/Warsaw";
/** 19:00 in Warsaw in summer (UTC+2). */
const SEVEN_PM = new Date("2026-07-01T17:00:00Z");

interface DmCall {
  guildId: string;
  userId: string;
  content: string;
  components: readonly ComponentRow[];
}

const sameTarget = (a: MessageTarget, b: MessageTarget) =>
  a.kind === "channel"
    ? b.kind === "channel" && a.channelId === b.channelId
    : b.kind === "dm" && a.userId === b.userId;

/** Server zones for the fake store and the module; servers not listed use Warsaw time. */
type Zones = Record<string, string>;

function createStore(zones: Zones = {}): ScheduledMessageStore & {
  rows: ScheduledMessage[];
  optOuts: Set<string>;
  /** Stores a row without the caps, to set up a test. */
  insert(message: Omit<ScheduledMessage, "id">): ScheduledMessage;
  dueLimits: number[];
} {
  const rows: ScheduledMessage[] = [];
  const optOuts = new Set<string>();
  const dueLimits: number[] = [];
  const lastSent = new Map<number, string>();
  const key = (userId: string, guildId: string | null) => `${userId}|${guildId ?? "*"}`;
  let nextId = 1;
  const insert = (message: Omit<ScheduledMessage, "id">) => {
    const saved = { ...message, id: nextId++ };
    rows.push(saved);
    return saved;
  };
  return {
    rows,
    optOuts,
    insert,
    dueLimits,
    async add(message, limits) {
      const own = rows.filter((row) => row.guildId === message.guildId);
      if (own.some((row) => row.time === message.time && sameTarget(row.target, message.target))) {
        return { status: "duplicate" };
      }
      if (own.length >= limits.perGuild) return { status: "guild-full" };
      const { target } = message;
      if (
        target.kind === "dm" &&
        own.filter((row) => row.target.kind === "dm" && row.target.userId === target.userId)
          .length >= limits.perRecipient
      ) {
        return { status: "recipient-full" };
      }
      return { status: "added", message: insert(message) };
    },
    async list(guildId) {
      return rows
        .filter((row) => row.guildId === guildId)
        .sort((a, b) => a.time.localeCompare(b.time) || a.id - b.id);
    },
    async remove(guildId, id) {
      const index = rows.findIndex((row) => row.guildId === guildId && row.id === id);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
    async due(at, limit) {
      dueLimits.push(limit);
      return rows
        .map((row) => ({ row, minute: localMinute(at, zones[row.guildId] ?? ZONE) }))
        .filter(
          ({ row, minute }) =>
            minute.time >= row.time && (lastSent.get(row.id) ?? "") < minute.date,
        )
        .map(({ row, minute }) => ({ ...row, date: minute.date }))
        .slice(0, limit);
    },
    async claim(id, date) {
      if ((lastSent.get(id) ?? "") >= date) return false;
      lastSent.set(id, date);
      return true;
    },
    async release(id, date) {
      if (lastSent.get(id) === date) lastSent.delete(id);
    },
    async optOut(userId, guildId) {
      const had = optOuts.has(key(userId, guildId));
      optOuts.add(key(userId, guildId));
      return !had;
    },
    async optIn(userId, guildId) {
      return optOuts.delete(key(userId, guildId));
    },
    async isOptedOut(userId, guildId) {
      return optOuts.has(key(userId, guildId)) || optOuts.has(key(userId, null));
    },
  };
}

function setup(
  options: {
    disabledChannels?: string[];
    disabledGuilds?: string[];
    failChannels?: string[];
    /** Channels Discord no longer knows. */
    goneChannels?: string[];
    closedDms?: string[];
    botGuilds?: string[];
    failDue?: boolean;
    /** Channels where the bot may not post. */
    mutedChannels?: string[];
    /** Called when a message is sent, before it is recorded; a test can hold it there. */
    onSend?: () => Promise<void>;
    /** Server time zones (`/timezone`); others use Warsaw time. */
    zones?: Zones;
    failures?: KeyValueStore;
    /** Members' DM languages; Polish unless a test says otherwise. */
    locales?: LocaleResolver;
  } = {},
) {
  const zones = options.zones ?? {};
  const store = createStore(zones);
  if (options.failDue) {
    store.due = async () => {
      throw new Error("database is down");
    };
  }
  const channelSends: { guildId: string; channelId: string; content: string }[] = [];
  const dmSends: DmCall[] = [];
  const members: Record<string, Record<string, "member" | "bot">> = {
    [GUILD]: {
      [ADMIN]: "member",
      [MEMBER]: "member",
      [SECOND_MEMBER]: "member",
      [BOT_USER]: "bot",
    },
    [OTHER_GUILD]: { [MEMBER]: "member" },
  };
  const sender: ScheduledMessageSender = {
    async toChannel(guildId, channelId, content) {
      if (options.failChannels?.includes(channelId)) throw new Error("Missing Permissions");
      if (options.goneChannels?.includes(channelId)) return "gone";
      await options.onSend?.();
      channelSends.push({ guildId, channelId, content });
      return "sent";
    },
    async toMember(guildId, userId, content, components) {
      if (options.closedDms?.includes(userId)) return false;
      dmSends.push({ guildId, userId, content, components });
      return true;
    },
    async memberStatus(guildId, userId) {
      return members[guildId]?.[userId] ?? "absent";
    },
    async guildName(guildId) {
      return guildId === GUILD ? "Dżajcarnia" : guildId === OTHER_GUILD ? guildNames.other : null;
    },
  };
  const guildNames = { other: "Inny" };
  const textChannels: Record<string, string[]> = { [GUILD]: [GENERAL, NEWS] };

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

  let current = SEVEN_PM;
  let ready = true;
  const warnings: { message: string; fields?: LogFields }[] = [];
  const infos: { message: string; fields?: LogFields }[] = [];
  const errors: { message: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    ...silentLogger,
    info: (message, fields) => void infos.push({ message, fields }),
    warn: (message, fields) => void warnings.push({ message, fields }),
    error: (message, fields) => void errors.push({ message, fields }),
    child: () => logger,
  };

  const botGuilds = options.botGuilds ?? [GUILD, OTHER_GUILD];
  const module = createMessagesModule({
    store,
    sender,
    channels: {
      isTextChannelOf: async (guildId, channelId) =>
        textChannels[guildId]?.includes(channelId) ?? false,
      botCanPostIn: async (_guildId, channelId) => !options.mutedChannels?.includes(channelId),
    },
    cron,
    failures: options.failures ?? createMemoryStore(() => current.getTime()),
    clientReady: () => ready,
    botInGuild: (guildId) => botGuilds.includes(guildId),
    moduleEnabled: async (_guildId, channelId) => !options.disabledChannels?.includes(channelId),
    guildModuleEnabled: async (guildId) => !options.disabledGuilds?.includes(guildId),
    now: () => current,
    timeZones: { of: async (guildId) => (guildId !== null ? zones[guildId] : undefined) ?? ZONE },
    logger,
    locales: options.locales ?? fakeLocales("pl"),
  });
  const registry = createRegistry([module]);
  const find = (name: string): AnyCommand => {
    const command = registry.find(name);
    if (!command) throw new Error(`${name} command missing`);
    return command;
  };

  const fire = async () => {
    if (!task) throw new Error("nothing scheduled");
    await task();
  };

  const run = async (
    name: string,
    subcommand: string,
    args: Record<string, unknown> = {},
    context: {
      invocation?: "slash" | "prefix";
      guildId?: string | null;
      userId?: string;
      memberPermissions?: bigint;
      locale?: Locale;
    } = {},
  ) => {
    const ctx = createFakeContext({
      locale: context.locale,
      args,
      subcommand,
      invocation: context.invocation ?? "slash",
      guildId: context.guildId === undefined ? GUILD : context.guildId,
      userId: context.userId ?? ADMIN,
      memberPermissions: context.memberPermissions ?? MANAGE_GUILD,
    });
    await executeCommand(find(name), ctx, silentLogger);
    return ctx;
  };

  const prefixAdd = async (time: string, target: string, text: string) => {
    const ctx = await run("messages", "add", { time, target, text }, { invocation: "prefix" });
    return ctx.replies.map(replyText);
  };

  const openForm = async (locale?: Locale) => {
    const ctx = await run("messages", "add", {}, { locale });
    const modal = ctx.modals[0];
    if (!modal) throw new Error("no modal opened");
    return modal;
  };

  const submitForm = async (values: Record<string, string>, locale?: Locale) => {
    const modal = await openForm(locale);
    const ctx = await submitModal({
      registry,
      customId: modal.customId,
      values,
      memberPermissions: MANAGE_GUILD,
      locale,
    });
    return ctx.replies.map(replyText);
  };

  const schedule = (
    message: Omit<ScheduledMessage, "id" | "createdBy" | "guildId"> & { guildId?: string },
  ) => store.insert({ guildId: GUILD, createdBy: ADMIN, ...message });

  return {
    module,
    registry,
    store,
    channelSends,
    dmSends,
    cronCalls,
    warnings,
    infos,
    errors,
    fire,
    run,
    prefixAdd,
    openForm,
    submitForm,
    schedule,
    guildNames,
    setNow: (date: Date) => {
      current = date;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    isStopped: () => stopped,
  };
}

function optOutButtonOf(call: DmCall | undefined): ButtonSpec {
  const button = call?.components[0]?.[0];
  if (button?.type !== "button") throw new Error("no opt-out button");
  return button;
}

describe("sending", () => {
  test("ticks every minute and stops on dispose", async () => {
    const s = setup();
    expect(s.cronCalls).toEqual([{ expression: "* * * * *", timeZone: "UTC" }]);
    await s.module.dispose?.();
    expect(s.isStopped()).toBe(true);
  });

  test("a message due at 19:00 goes out at 19:00 Warsaw time, not at 18:59", async () => {
    const s = setup();
    await s.schedule({
      time: "19:00",
      content: "Bonżur!",
      target: { kind: "channel", channelId: GENERAL },
    });
    s.setNow(new Date("2026-07-01T16:59:00Z"));
    await s.fire();
    expect(s.channelSends).toEqual([]);
    s.setNow(SEVEN_PM);
    await s.fire();
    expect(s.channelSends).toEqual([{ guildId: GUILD, channelId: GENERAL, content: "Bonżur!" }]);
  });

  test("each server's messages follow its own time zone", async () => {
    const s = setup({ zones: { [OTHER_GUILD]: "Europe/London" } });
    await s.schedule({
      time: "19:00",
      content: "Warszawa",
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.schedule({
      guildId: OTHER_GUILD,
      time: "19:00",
      content: "Londyn",
      target: { kind: "channel", channelId: NEWS },
    });
    await s.fire();
    expect(s.channelSends.map((send) => send.content)).toEqual(["Warszawa"]);
    s.setNow(new Date(SEVEN_PM.getTime() + 3_600_000));
    await s.fire();
    expect(s.channelSends.map((send) => send.content)).toEqual(["Warszawa", "Londyn"]);
  });

  test("19:00 is 18:00 UTC in winter", async () => {
    const s = setup();
    await s.schedule({
      time: "19:00",
      content: "Zima",
      target: { kind: "channel", channelId: GENERAL },
    });
    s.setNow(new Date("2026-01-15T17:00:00Z"));
    await s.fire();
    expect(s.channelSends).toEqual([]);
    s.setNow(new Date("2026-01-15T18:00:00Z"));
    await s.fire();
    expect(s.channelSends).toHaveLength(1);
  });

  test("a tick delayed past half a minute still sends that minute, not the next one", async () => {
    const s = setup();
    await s.schedule({
      time: "19:00",
      content: "Teraz",
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.schedule({
      time: "19:01",
      content: "Za chwilę",
      target: { kind: "channel", channelId: GENERAL },
    });
    s.setNow(new Date(SEVEN_PM.getTime() + 31_000));
    await s.fire();
    expect(s.channelSends.map((send) => send.content)).toEqual(["Teraz"]);
  });

  test("a tick a couple of seconds early belongs to the coming minute", async () => {
    const s = setup();
    await s.schedule({
      time: "19:00",
      content: "Teraz",
      target: { kind: "channel", channelId: GENERAL },
    });
    s.setNow(new Date(SEVEN_PM.getTime() - 2_000));
    await s.fire();
    expect(s.channelSends.map((send) => send.content)).toEqual(["Teraz"]);
  });

  test("a second fire in the same minute sends nothing", async () => {
    const s = setup();
    await s.schedule({
      time: "19:00",
      content: "Raz",
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.fire();
    s.setNow(new Date(SEVEN_PM.getTime() + 30_000));
    await s.fire();
    expect(s.channelSends).toHaveLength(1);
  });

  test("it goes out again the next day", async () => {
    const s = setup();
    await s.schedule({
      time: "19:00",
      content: "Codziennie",
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.fire();
    s.setNow(new Date("2026-07-02T17:00:00Z"));
    await s.fire();
    expect(s.channelSends).toHaveLength(2);
  });

  test("the repeated 02:30 in October goes out once", async () => {
    const s = setup();
    await s.schedule({
      time: "02:30",
      content: "Noc",
      target: { kind: "channel", channelId: GENERAL },
    });
    s.setNow(new Date("2026-10-25T00:30:00Z"));
    await s.fire();
    s.setNow(new Date("2026-10-25T01:30:00Z"));
    await s.fire();
    expect(s.channelSends).toHaveLength(1);
  });

  test("02:30 goes out once, right after the clock jumps over it in March", async () => {
    const s = setup();
    await s.schedule({
      time: "02:30",
      content: "Noc",
      target: { kind: "channel", channelId: GENERAL },
    });
    s.setNow(new Date("2026-03-29T00:30:00Z"));
    await s.fire();
    expect(s.channelSends).toEqual([]);
    for (const instant of ["2026-03-29T01:00:00Z", "2026-03-29T01:30:00Z"]) {
      s.setNow(new Date(instant));
      await s.fire();
    }
    expect(s.channelSends).toHaveLength(1);
  });

  test("a message whose minute passed while the bot was down goes out when it is back, that day", async () => {
    const s = setup();
    await s.schedule({
      time: "19:00",
      content: "Spóźnione",
      target: { kind: "channel", channelId: GENERAL },
    });
    s.setNow(new Date(SEVEN_PM.getTime() + 3 * 3_600_000));
    await s.fire();
    expect(s.channelSends.map((send) => send.content)).toEqual(["Spóźnione"]);
    await s.fire();
    expect(s.channelSends).toHaveLength(1);
  });

  test("a message that failed is tried again the next minute and then not repeated", async () => {
    const failChannels = [GENERAL];
    const s = setup({ failChannels });
    const message = await s.schedule({
      time: "19:00",
      content: "Za drugim razem",
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.fire();
    expect(s.channelSends).toEqual([]);
    expect(s.warnings[0]?.fields).toMatchObject({ id: message.id, attempts: 1 });
    failChannels.length = 0;
    s.setNow(new Date(SEVEN_PM.getTime() + 60_000));
    await s.fire();
    expect(s.channelSends.map((send) => send.content)).toEqual(["Za drugim razem"]);
    s.setNow(new Date(SEVEN_PM.getTime() + 120_000));
    await s.fire();
    expect(s.channelSends).toHaveLength(1);
  });

  test("a failure counter that never answers does not hold the tick past the limit", async () => {
    const s = setup({
      failChannels: [GENERAL],
      failures: createTimedStore(createStalledStore(), 20),
    });
    const message = await s.schedule({
      time: "19:00",
      content: "Bez licznika",
      target: { kind: "channel", channelId: GENERAL },
    });
    const started = performance.now();
    await s.fire();
    expect(performance.now() - started).toBeLessThan(500);
    const retry = s.warnings.find((entry) => entry.message.includes("tried again"));
    expect(retry?.fields).toMatchObject({ id: message.id, attempts: 1 });
  });

  test("a message that keeps failing is given up for the day, logged, and tried again tomorrow", async () => {
    const failChannels = [GENERAL];
    const s = setup({ failChannels });
    const message = await s.schedule({
      time: "19:00",
      content: "Uparte",
      target: { kind: "channel", channelId: GENERAL },
    });
    for (let minute = 0; minute < MAX_ATTEMPTS_PER_DAY + 2; minute++) {
      s.setNow(new Date(SEVEN_PM.getTime() + minute * 60_000));
      await s.fire();
    }
    expect(s.warnings).toHaveLength(MAX_ATTEMPTS_PER_DAY - 1);
    expect(s.errors.map((entry) => entry.message)).toEqual([
      "Scheduled message given up for today after repeated failures",
    ]);
    expect(s.errors[0]?.fields).toMatchObject({
      id: message.id,
      attempts: MAX_ATTEMPTS_PER_DAY,
    });
    failChannels.length = 0;
    s.setNow(new Date("2026-07-02T17:00:00Z"));
    await s.fire();
    expect(s.channelSends.map((send) => send.content)).toEqual(["Uparte"]);
  });

  test("closing DMs or a missing member end the day's attempts without a retry", async () => {
    const s = setup({ closedDms: [MEMBER] });
    await s.schedule({ time: "19:00", content: "x", target: { kind: "dm", userId: MEMBER } });
    await s.fire();
    s.setNow(new Date(SEVEN_PM.getTime() + 60_000));
    await s.fire();
    expect(s.dmSends).toEqual([]);
    expect(s.infos).toHaveLength(1);
  });

  test("a /timezone change in mid-day neither repeats nor skips the day's message", async () => {
    const zones: Zones = {};
    const s = setup({ zones });
    await s.schedule({
      time: "10:00",
      content: "Rano",
      target: { kind: "channel", channelId: GENERAL },
    });
    // 10:30 in Warsaw: it goes out.
    s.setNow(new Date("2026-07-01T08:30:00Z"));
    await s.fire();
    expect(s.channelSends).toHaveLength(1);
    // The server moves to New York, where 10:00 comes six hours later, on the same date.
    zones[GUILD] = "America/New_York";
    s.setNow(new Date("2026-07-01T14:30:00Z"));
    await s.fire();
    expect(s.channelSends).toHaveLength(1);
    // Next day it goes out once more, on the new clock.
    s.setNow(new Date("2026-07-02T13:30:00Z"));
    await s.fire();
    expect(s.channelSends).toHaveLength(1);
    s.setNow(new Date("2026-07-02T14:00:00Z"));
    await s.fire();
    expect(s.channelSends).toHaveLength(2);
  });

  test("a tick before the client is ready sends and claims nothing, the next one sends", async () => {
    const s = setup();
    await s.schedule({
      time: "19:00",
      content: "Po starcie",
      target: { kind: "channel", channelId: GENERAL },
    });
    s.setReady(false);
    await s.fire();
    expect(s.channelSends).toEqual([]);
    s.setReady(true);
    s.setNow(new Date(SEVEN_PM.getTime() + 60_000));
    await s.fire();
    expect(s.channelSends.map((send) => send.content)).toEqual(["Po starcie"]);
  });

  test("a message claimed by another tick is not sent again by a slow one", async () => {
    const s = setup();
    const message = await s.schedule({
      time: "19:00",
      content: "Raz",
      target: { kind: "channel", channelId: GENERAL },
    });
    // Another instance took the day's date after this tick read the row.
    const due = s.store.due.bind(s.store);
    s.store.due = async (at, limit) => {
      const rows = await due(at, limit);
      await s.store.claim(message.id, "2026-07-01");
      return rows;
    };
    await s.fire();
    expect(s.channelSends).toEqual([]);
  });

  test("two ticks at once send a message once", async () => {
    let release = () => {};
    const s = setup({
      onSend: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    await s.schedule({
      time: "19:00",
      content: "Raz",
      target: { kind: "channel", channelId: GENERAL },
    });
    const first = s.fire();
    await new Promise((resolve) => setTimeout(resolve, 1));
    await s.fire();
    release();
    await first;
    expect(s.channelSends).toHaveLength(1);
  });

  test("two messages at the same minute both go out", async () => {
    const s = setup();
    await s.schedule({
      time: "19:00",
      content: "A",
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.schedule({
      time: "19:00",
      content: "B",
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.fire();
    expect(s.channelSends.map((send) => send.content).sort()).toEqual(["A", "B"]);
  });

  test("the channel toggle skips that channel only; the guild toggle skips DMs", async () => {
    const s = setup({ disabledChannels: [GENERAL], disabledGuilds: [OTHER_GUILD] });
    await s.schedule({
      time: "19:00",
      content: "off",
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.schedule({
      time: "19:00",
      content: "on",
      target: { kind: "channel", channelId: NEWS },
    });
    await s.schedule({ time: "19:00", content: "dm on", target: { kind: "dm", userId: MEMBER } });
    await s.schedule({
      guildId: OTHER_GUILD,
      time: "19:00",
      content: "dm off",
      target: { kind: "dm", userId: MEMBER },
    });
    await s.fire();
    expect(s.channelSends.map((send) => send.content)).toEqual(["on"]);
    expect(s.dmSends.map((send) => send.guildId)).toEqual([GUILD]);
  });

  test("a guild the bot left is skipped", async () => {
    const s = setup({ botGuilds: [OTHER_GUILD] });
    await s.schedule({
      time: "19:00",
      content: "x",
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.fire();
    expect(s.channelSends).toEqual([]);
  });

  test("a DM to someone who left the server, or to a bot, is skipped", async () => {
    const s = setup();
    await s.schedule({ time: "19:00", content: "x", target: { kind: "dm", userId: STRANGER } });
    await s.schedule({ time: "19:00", content: "x", target: { kind: "dm", userId: BOT_USER } });
    await s.fire();
    expect(s.dmSends).toEqual([]);
  });

  test("a member who opted out of this server or of every server gets nothing", async () => {
    const s = setup();
    await s.store.optOut(MEMBER, GUILD);
    await s.store.optOut(SECOND_MEMBER, null);
    await s.schedule({ time: "19:00", content: "x", target: { kind: "dm", userId: MEMBER } });
    await s.schedule({
      time: "19:00",
      content: "x",
      target: { kind: "dm", userId: SECOND_MEMBER },
    });
    await s.schedule({
      guildId: OTHER_GUILD,
      time: "19:00",
      content: "inny",
      target: { kind: "dm", userId: MEMBER },
    });
    await s.fire();
    // Opting out of one server leaves the others.
    expect(s.dmSends.map((send) => send.guildId)).toEqual([OTHER_GUILD]);
  });

  test("a DM fills {user}, adds the footer and the opt-out button; a channel keeps {user} as written", async () => {
    const s = setup();
    await s.schedule({
      time: "19:00",
      content: "Hej {user}! {user}",
      target: { kind: "dm", userId: MEMBER },
    });
    await s.schedule({
      time: "19:00",
      content: "Hej {user}!",
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.fire();
    expect(s.channelSends[0]?.content).toBe("Hej {user}!");
    const dm = s.dmSends[0];
    expect(dm?.content).toBe(
      `Hej <@${MEMBER}>! <@${MEMBER}>\n-# Zaplanowana wiadomość z serwera Dżajcarnia.`,
    );
    const button = optOutButtonOf(dm);
    expect(button).toMatchObject({
      label: "Nie wysyłaj mi więcej",
      style: "secondary",
      emoji: "🔕",
      customId: `messages:optout:${MEMBER}:${GUILD}`,
    });
  });

  test("closed DMs are logged at info", async () => {
    const s = setup({ closedDms: [MEMBER] });
    const saved = await s.schedule({
      time: "19:00",
      content: "x",
      target: { kind: "dm", userId: MEMBER },
    });
    await s.fire();
    expect(s.infos).toEqual([
      {
        message: "Scheduled DM not delivered: the member does not accept DMs",
        fields: { id: saved.id, guildId: GUILD },
      },
    ]);
    expect(s.warnings).toEqual([]);
  });

  test("a message whose channel is gone is deleted and logged at info", async () => {
    const s = setup({ goneChannels: [GENERAL] });
    const gone = await s.schedule({
      time: "19:00",
      content: "x",
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.schedule({ time: "19:00", content: "y", target: { kind: "channel", channelId: NEWS } });
    await s.fire();
    expect(s.channelSends.map((send) => send.content)).toEqual(["y"]);
    expect(s.warnings).toEqual([]);
    expect(s.infos[0]?.message).toBe("Scheduled message deleted: its channel no longer exists");
    expect(s.infos[0]?.fields).toMatchObject({ id: gone.id, guildId: GUILD });
    expect((await s.store.list(GUILD)).map((m) => m.id)).not.toContain(gone.id);
  });

  test("one failing message is logged and the others still go out", async () => {
    const s = setup({ failChannels: [GENERAL] });
    const broken = await s.schedule({
      time: "19:00",
      content: "x",
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.schedule({ time: "19:00", content: "y", target: { kind: "channel", channelId: NEWS } });
    await s.schedule({ time: "19:00", content: "z", target: { kind: "dm", userId: MEMBER } });
    await s.fire();
    expect(s.channelSends.map((send) => send.content)).toEqual(["y"]);
    expect(s.dmSends).toHaveLength(1);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]?.message).toBe(
      "Scheduled message not sent; it is tried again next minute",
    );
    expect(s.warnings[0]?.fields).toMatchObject({ id: broken.id, guildId: GUILD });
    // The row stays; the admin removes it.
    expect(s.store.rows).toHaveLength(3);
  });

  test("a failing store is logged and the tick does not throw", async () => {
    const s = setup({ failDue: true });
    await s.fire();
    expect(s.errors.map((entry) => entry.message)).toEqual(["Scheduled messages tick failed"]);
  });
});

describe("messages add", () => {
  test("the slash form opens the modal", async () => {
    const s = setup();
    const modal = await s.openForm();
    expect(modal.customId).toBe(`messages:add:${ADMIN}:`);
    expect(modal.fields.map((field) => field.customId)).toEqual([
      "time",
      "channel",
      "user",
      "text",
    ]);
  });

  test("needs Manage Server", async () => {
    const s = setup();
    const ctx = await s.run("messages", "add", {}, { memberPermissions: 0n });
    expect(ctx.modals).toEqual([]);
    expect(replyText(ctx.replies[0])).toBe("Nie masz uprawnień do tej komendy.");
  });

  test("the modal schedules a channel message", async () => {
    const s = setup();
    const replies = await s.submitForm({ time: "7:05", channel: GENERAL, text: "Dzień dobry" });
    expect(replies).toEqual([`Zaplanowano wiadomość #1 na 07:05 (Europe/Warsaw) → <#${GENERAL}>.`]);
    expect(s.store.rows).toEqual([
      {
        id: 1,
        guildId: GUILD,
        time: "07:05",
        content: "Dzień dobry",
        target: { kind: "channel", channelId: GENERAL },
        createdBy: ADMIN,
      },
    ]);
  });

  test("the modal schedules a DM", async () => {
    const s = setup();
    const replies = await s.submitForm({ time: "19:00", user: MEMBER, text: "Hej {user}" });
    expect(replies).toEqual([
      `Zaplanowano wiadomość #1 na 19:00 (Europe/Warsaw) → DM do <@${MEMBER}>.`,
    ]);
    expect(s.store.rows[0]?.target).toEqual({ kind: "dm", userId: MEMBER });
  });

  test("the reply does not reveal that the recipient opted out", async () => {
    const s = setup();
    await s.store.optOut(MEMBER, null);
    const replies = await s.submitForm({ time: "19:00", user: MEMBER, text: "Hej" });
    expect(replies).toEqual([
      `Zaplanowano wiadomość #1 na 19:00 (Europe/Warsaw) → DM do <@${MEMBER}>.`,
    ]);
  });

  test("every validation error, with the text handed back from the form", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ time: "24:00", channel: GENERAL, text: "Hej" }, "Podaj godzinę jako HH:MM, np. 19:00."],
      [{ time: "19.00", channel: GENERAL, text: "Hej" }, "Podaj godzinę jako HH:MM, np. 19:00."],
      [{ time: "19:00", text: "Hej" }, "Wybierz kanał albo osobę (jedno z dwóch)."],
      [
        { time: "19:00", channel: GENERAL, user: MEMBER, text: "Hej" },
        "Wybierz kanał albo osobę (jedno z dwóch).",
      ],
      [{ time: "19:00", channel: VOICE, text: "Hej" }, "Wybierz kanał tekstowy z tego serwera."],
      [
        { time: "19:00", user: STRANGER, text: "Hej" },
        "Wiadomości prywatne mogę wysyłać tylko członkom tego serwera (nie botom).",
      ],
      [
        { time: "19:00", user: BOT_USER, text: "Hej" },
        "Wiadomości prywatne mogę wysyłać tylko członkom tego serwera (nie botom).",
      ],
    ];
    for (const [values, message] of cases) {
      const s = setup();
      const replies = await s.submitForm(values);
      expect(replies).toEqual([message, "```\nHej\n```"]);
      expect(s.store.rows).toEqual([]);
    }
  });

  test("an empty text gets the length message and nothing to hand back", async () => {
    const s = setup();
    expect(await s.submitForm({ time: "19:00", channel: GENERAL, text: "   " })).toEqual([
      `Treść musi mieć od 1 do ${MAX_CONTENT_LENGTH} znaków.`,
    ]);
  });

  test("the prefix form refuses a text over 1900 characters", async () => {
    const s = setup();
    const replies = await s.prefixAdd("19:00", `<#${GENERAL}>`, "a".repeat(MAX_CONTENT_LENGTH + 1));
    expect(replies).toEqual([`Treść musi mieć od 1 do ${MAX_CONTENT_LENGTH} znaków.`]);
  });

  test("a DM that would pass 2000 characters once {user} and the footer are filled in is refused", async () => {
    const s = setup();
    // The footer with a 100-character server name, and how much each {user} grows.
    // The longest footer of any language, since the recipient's language is not known when it is added.
    const footer = [..."\n-# Scheduled message from the server ."].length + 100;
    const growth = `<@${MEMBER}>`.length - "{user}".length;
    const fits = "a".repeat(2000 - footer);
    expect(await s.prefixAdd("19:00", `<@${MEMBER}>`, fits)).toEqual([
      `Zaplanowano wiadomość #1 na 19:00 (Europe/Warsaw) → DM do <@${MEMBER}>.`,
    ]);
    const tooLong = `{user}${"a".repeat(2000 - footer - "{user}".length)}`;
    expect(await s.prefixAdd("19:00", `<@${MEMBER}>`, tooLong)).toEqual([
      `Po wstawieniu oznaczeń {user} i stopki z nazwą serwera wiadomość prywatna przekroczy 2000 znaków. Skróć ją o ${growth}.`,
    ]);
    // The same text is fine in a channel, where {user} stays as written, and the reply says so.
    expect(await s.prefixAdd("19:00", `<#${GENERAL}>`, tooLong)).toEqual([
      `Zaplanowano wiadomość #2 na 19:00 (Europe/Warsaw) → <#${GENERAL}>. \`{user}\` działa tylko w wiadomościach prywatnych, na kanale zostanie wpisane dosłownie.`,
    ]);
  });

  test(`a server keeps at most ${MAX_MESSAGES_PER_GUILD} messages`, async () => {
    const s = setup();
    for (let i = 0; i < MAX_MESSAGES_PER_GUILD; i++) {
      await s.schedule({
        time: "12:00",
        content: `${i}`,
        target: { kind: "channel", channelId: GENERAL },
      });
    }
    expect(await s.prefixAdd("19:00", `<#${GENERAL}>`, "jeszcze jedna")).toEqual([
      "Ten serwer ma już 25 zaplanowanych wiadomości. Usuń którąś przez `messages remove`.",
    ]);
    await s.store.remove(GUILD, 1);
    expect(await s.prefixAdd("19:00", `<#${GENERAL}>`, "teraz tak")).toHaveLength(1);
    expect(await s.store.list(GUILD)).toHaveLength(MAX_MESSAGES_PER_GUILD);
  });

  test(`a member gets at most ${MAX_DMS_PER_RECIPIENT} scheduled DMs from one server`, async () => {
    const s = setup();
    for (const time of ["10:00", "11:00", "12:00"]) {
      expect(await s.prefixAdd(time, `<@${MEMBER}>`, "Hej")).toHaveLength(1);
    }
    expect(await s.prefixAdd("13:00", `<@${MEMBER}>`, "Hej")).toEqual([
      "Ta osoba ma już 3 zaplanowane wiadomości prywatne z tego serwera. Usuń którąś przez `messages remove`.",
    ]);
    // Another member, and a channel, are not affected.
    expect(await s.prefixAdd("13:00", `<@${SECOND_MEMBER}>`, "Hej")).toEqual([
      `Zaplanowano wiadomość #4 na 13:00 (Europe/Warsaw) → DM do <@${SECOND_MEMBER}>.`,
    ]);
    expect(await s.prefixAdd("13:00", `<#${GENERAL}>`, "Hej")).toEqual([
      `Zaplanowano wiadomość #5 na 13:00 (Europe/Warsaw) → <#${GENERAL}>.`,
    ]);
  });

  test("the refusal at the DM cap is the same whether or not the member opted out", async () => {
    const answers: (string | undefined)[][] = [];
    for (const optedOut of [false, true]) {
      const s = setup();
      if (optedOut) await s.store.optOut(MEMBER, null);
      for (const time of ["10:00", "11:00", "12:00"])
        await s.prefixAdd(time, `<@${MEMBER}>`, "Hej");
      answers.push(await s.prefixAdd("13:00", `<@${MEMBER}>`, "Hej"));
    }
    expect(answers[0]).toEqual(answers[1]);
  });

  test("the same channel or member at the same time is refused", async () => {
    const s = setup();
    await s.prefixAdd("19:00", `<#${GENERAL}>`, "Pierwsza");
    await s.prefixAdd("19:00", `<@${MEMBER}>`, "Pierwsza");
    const duplicate =
      "Na ten kanał albo do tej osoby jest już zaplanowana wiadomość o tej godzinie.";
    expect(await s.prefixAdd("19:00", `<#${GENERAL}>`, "Druga")).toEqual([duplicate]);
    expect(await s.prefixAdd("19:00", `<@${MEMBER}>`, "Druga")).toEqual([duplicate]);
    // Another minute or another target is fine.
    expect(await s.prefixAdd("19:01", `<#${GENERAL}>`, "Druga")).toHaveLength(1);
    expect(await s.prefixAdd("19:00", `<#${NEWS}>`, "Druga")).toHaveLength(1);
    expect(s.store.rows).toHaveLength(4);
  });

  test("a channel where the bot cannot post is refused", async () => {
    const s = setup({ mutedChannels: [NEWS] });
    expect(await s.prefixAdd("19:00", `<#${NEWS}>`, "Hej")).toEqual([
      `Nie mogę pisać na <#${NEWS}>. Daj mi tam uprawnienia „Wyświetlanie kanałów” i „Wysyłanie wiadomości”.`,
    ]);
    expect(s.store.rows).toEqual([]);
  });

  test("{user} in a channel message gets a note in the reply; without it there is none", async () => {
    const s = setup();
    expect(await s.submitForm({ time: "19:00", channel: GENERAL, text: "Hej {user}" })).toEqual([
      `Zaplanowano wiadomość #1 na 19:00 (Europe/Warsaw) → <#${GENERAL}>. \`{user}\` działa tylko w wiadomościach prywatnych, na kanale zostanie wpisane dosłownie.`,
    ]);
    expect(await s.submitForm({ time: "20:00", user: MEMBER, text: "Hej {user}" })).toEqual([
      `Zaplanowano wiadomość #2 na 20:00 (Europe/Warsaw) → DM do <@${MEMBER}>.`,
    ]);
  });

  test("the prefix form takes <#channel>, <@user> and <@!user>", async () => {
    const s = setup();
    expect(await s.prefixAdd("9:00", `<#${GENERAL}>`, "Kanał")).toEqual([
      `Zaplanowano wiadomość #1 na 09:00 (Europe/Warsaw) → <#${GENERAL}>.`,
    ]);
    expect(await s.prefixAdd("9:00", `<@${MEMBER}>`, "Osoba")).toEqual([
      `Zaplanowano wiadomość #2 na 09:00 (Europe/Warsaw) → DM do <@${MEMBER}>.`,
    ]);
    expect(await s.prefixAdd("9:00", `<@!${SECOND_MEMBER}>`, "Nick")).toEqual([
      `Zaplanowano wiadomość #3 na 09:00 (Europe/Warsaw) → DM do <@${SECOND_MEMBER}>.`,
    ]);
    expect(s.store.rows.map((row) => row.target)).toEqual([
      { kind: "channel", channelId: GENERAL },
      { kind: "dm", userId: MEMBER },
      { kind: "dm", userId: SECOND_MEMBER },
    ]);
  });

  test("the prefix form refuses a target that is neither a channel nor a member mention", async () => {
    const s = setup();
    for (const target of [GENERAL, "kanał", `<@&${GENERAL}>`]) {
      expect(await s.prefixAdd("19:00", target, "Hej")).toEqual([
        "Wybierz kanał albo osobę (jedno z dwóch).",
      ]);
    }
  });
});

describe("messages list", () => {
  test("an empty server", async () => {
    const s = setup();
    const ctx = await s.run("messages", "list");
    expect(ctx.replies).toEqual([
      { content: "Brak zaplanowanych wiadomości. Dodaj przez `messages add`.", ephemeral: true },
    ]);
  });

  test("one line per message by time, the text cut to one short line", async () => {
    const s = setup();
    await s.schedule({
      time: "21:00",
      content: "Dobranoc",
      target: { kind: "dm", userId: MEMBER },
    });
    await s.schedule({
      time: "09:00",
      content: `Pierwsza linia\ndruga linia ${"x".repeat(60)}`,
      target: { kind: "channel", channelId: GENERAL },
    });
    await s.schedule({
      guildId: OTHER_GUILD,
      time: "10:00",
      content: "Obcy",
      target: { kind: "dm", userId: MEMBER },
    });
    const ctx = await s.run("messages", "list");
    expect(ctx.replies).toEqual([
      {
        content: [
          "Godziny w strefie Europe/Warsaw:",
          `#2 09:00 → <#${GENERAL}>: \`Pierwsza linia druga linia xxxxxxxxxxxx…\``,
          `#1 21:00 → DM <@${MEMBER}>: \`Dobranoc\``,
        ].join("\n"),
        ephemeral: true,
      },
    ]);
  });

  test("a long preview is exactly 40 characters, the ellipsis included", async () => {
    const s = setup();
    await s.schedule({
      time: "09:00",
      content: "😀".repeat(60),
      target: { kind: "channel", channelId: GENERAL },
    });
    const line = replyText((await s.run("messages", "list")).replies[0])?.split("\n")[1] ?? "";
    const preview = line.slice(line.indexOf("`") + 1, line.lastIndexOf("`"));
    expect([...preview]).toHaveLength(40);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("the preview shows markdown, mentions and backticks as typed", async () => {
    const s = setup();
    await s.schedule({
      time: "09:00",
      content: "**gruby** @everyone `kod` <@1>",
      target: { kind: "channel", channelId: GENERAL },
    });
    const content = replyText((await s.run("messages", "list")).replies[0]);
    expect(content?.split("\n")[1]).toBe(
      `#1 09:00 → <#${GENERAL}>: \`**gruby** @everyone \u02cbkod\u02cb <@1>\``,
    );
  });

  test("list and remove need Manage Server", async () => {
    const s = setup();
    const saved = await s.schedule({
      time: "09:00",
      content: "x",
      target: { kind: "channel", channelId: GENERAL },
    });
    const list = await s.run("messages", "list", {}, { memberPermissions: 0n });
    expect(list.replies).toEqual([
      { content: "Nie masz uprawnień do tej komendy.", ephemeral: true },
    ]);
    const remove = await s.run("messages", "remove", { id: saved.id }, { memberPermissions: 0n });
    expect(remove.replies).toEqual([
      { content: "Nie masz uprawnień do tej komendy.", ephemeral: true },
    ]);
    expect(s.store.rows).toHaveLength(1);
  });

  test(`${MAX_MESSAGES_PER_GUILD} long messages stay under 2000 characters`, async () => {
    const s = setup();
    for (let i = 0; i < MAX_MESSAGES_PER_GUILD; i++) {
      await s.schedule({
        time: "12:00",
        content: "ż".repeat(MAX_CONTENT_LENGTH),
        target: { kind: "dm", userId: MEMBER },
      });
    }
    const content = replyText((await s.run("messages", "list")).replies[0]) ?? "";
    expect([...content].length).toBeLessThanOrEqual(2000);
    const lines = content.split("\n");
    const more = lines.at(-1)?.match(/^… i jeszcze (\d+)$/);
    expect(more).not.toBeNull();
    // The first line names the time zone; the last one counts what did not fit.
    expect(lines.length - 2 + Number(more?.[1])).toBe(MAX_MESSAGES_PER_GUILD);
  });
});

describe("messages remove", () => {
  test("removes a message of this server only", async () => {
    const s = setup();
    const own = await s.schedule({
      time: "19:00",
      content: "x",
      target: { kind: "channel", channelId: GENERAL },
    });
    const foreign = await s.schedule({
      guildId: OTHER_GUILD,
      time: "19:00",
      content: "y",
      target: { kind: "dm", userId: MEMBER },
    });
    const removed = await s.run("messages", "remove", { id: own.id });
    expect(replyText(removed.replies[0])).toBe(`Usunięto wiadomość #${own.id}.`);
    const refused = await s.run("messages", "remove", { id: foreign.id });
    expect(replyText(refused.replies[0])).toBe(`Nie ma wiadomości #${foreign.id} na tym serwerze.`);
    expect(s.store.rows.map((row) => row.id)).toEqual([foreign.id]);
  });
});

describe("opting out", () => {
  const text = (ctx: { replies: unknown[] }) =>
    replyText(ctx.replies[0] as Parameters<typeof replyText>[0]);

  test("/dm off on a server opts out of that server; in a DM of every server", async () => {
    const s = setup();
    const guild = await s.run("dm", "off", {}, { userId: MEMBER, memberPermissions: 0n });
    expect(text(guild)).toBe("Nie dostaniesz już zaplanowanych wiadomości z tego serwera.");
    expect(await s.store.isOptedOut(MEMBER, GUILD)).toBe(true);
    expect(await s.store.isOptedOut(MEMBER, OTHER_GUILD)).toBe(false);

    const dm = await s.run("dm", "off", {}, { userId: MEMBER, guildId: null });
    expect(text(dm)).toBe("Nie dostaniesz już zaplanowanych wiadomości z żadnego serwera.");
    expect(await s.store.isOptedOut(MEMBER, OTHER_GUILD)).toBe(true);
  });

  test("/dm on on a server undoes that server's opt-out", async () => {
    const s = setup();
    await s.store.optOut(MEMBER, GUILD);
    const on = await s.run("dm", "on", {}, { userId: MEMBER, memberPermissions: 0n });
    expect(text(on)).toBe("Znowu dostaniesz zaplanowane wiadomości z tego serwera.");
    expect(await s.store.isOptedOut(MEMBER, GUILD)).toBe(false);
    const again = await s.run("dm", "on", {}, { userId: MEMBER, memberPermissions: 0n });
    expect(text(again)).toBe("Nie były wyłączone.");
  });

  test("/dm on on a server says when the every-server opt-out still applies", async () => {
    const s = setup();
    await s.store.optOut(MEMBER, GUILD);
    await s.store.optOut(MEMBER, null);
    const on = await s.run("dm", "on", {}, { userId: MEMBER, memberPermissions: 0n });
    expect(text(on)).toBe(
      "Włączono dla tego serwera, ale nadal masz wyłączone wiadomości ze wszystkich serwerów, więc stąd też nic nie przyjdzie. Wpisz `/dm on` w prywatnej wiadomości do bota, żeby to zmienić.",
    );
    const again = await s.run("dm", "on", {}, { userId: MEMBER, memberPermissions: 0n });
    expect(text(again)).toBe(
      "Nadal masz wyłączone wiadomości ze wszystkich serwerów, więc stąd też nic nie przyjdzie. Wpisz `/dm on` w prywatnej wiadomości do bota, żeby to zmienić.",
    );
  });

  test("/dm on in a DM clears only the every-server opt-out", async () => {
    const s = setup();
    await s.store.optOut(MEMBER, GUILD);
    await s.store.optOut(MEMBER, null);
    const on = await s.run("dm", "on", {}, { userId: MEMBER, guildId: null });
    expect(text(on)).toBe(
      "Włączone ponownie dla wszystkich serwerów, poza tymi wyłączonymi osobno.",
    );
    expect(await s.store.isOptedOut(MEMBER, OTHER_GUILD)).toBe(false);
    expect(await s.store.isOptedOut(MEMBER, GUILD)).toBe(true);
    // The per-server opt-out is still there, so "nothing was off" would be wrong.
    const again = await s.run("dm", "on", {}, { userId: MEMBER, guildId: null });
    expect(text(again)).toBe(
      "Nie masz wyłączenia dla wszystkich serwerów. Wyłączenie jednego serwera zdejmiesz przez `/dm on` na tym serwerze.",
    );
    expect(await s.store.isOptedOut(MEMBER, GUILD)).toBe(true);
  });

  test("the button under a DM opts the recipient out of that server, twice is fine", async () => {
    const s = setup();
    await s.schedule({ time: "19:00", content: "Hej", target: { kind: "dm", userId: MEMBER } });
    await s.fire();
    const button = optOutButtonOf(s.dmSends[0]);
    for (let i = 0; i < 2; i++) {
      const ctx = await clickComponent({
        registry: s.registry,
        customId: button.customId,
        guildId: null,
      });
      expect(ctx.replies).toEqual([
        {
          content:
            "Nie dostaniesz już zaplanowanych wiadomości z serwera Dżajcarnia. Włączysz je z powrotem przez `/dm on` na tym serwerze.",
          ephemeral: true,
        },
      ]);
    }
    expect(await s.store.isOptedOut(MEMBER, GUILD)).toBe(true);
    s.setNow(new Date("2026-07-02T17:00:00Z"));
    await s.fire();
    expect(s.dmSends).toHaveLength(1);
  });

  test("only the recipient can use the button", async () => {
    const s = setup();
    const ctx = await clickComponent({
      registry: s.registry,
      customId: `messages:optout:${MEMBER}:${GUILD}`,
      guildId: null,
      userId: SECOND_MEMBER,
    });
    expect(replyText(ctx.replies[0])).toBe("To nie Twoje menu.");
    expect(s.store.optOuts.size).toBe(0);
  });

  test("a forged guild id in the button is refused", async () => {
    const s = setup();
    const ctx = await clickComponent({
      registry: s.registry,
      customId: `messages:optout:${MEMBER}:not-a-guild`,
      guildId: null,
    });
    expect(replyText(ctx.replies[0])).toBe("Ten przycisk jest nieaktualny.");
    expect(s.store.optOuts.size).toBe(0);
  });
});

describe("sending, under load and at the edges", () => {
  test("a job that fires at 18:59:59.990 sends the 19:00 messages", async () => {
    const s = setup();
    await s.schedule({
      time: "19:00",
      content: "Na czas",
      target: { kind: "channel", channelId: GENERAL },
    });
    s.setNow(new Date("2026-07-01T16:59:59.990Z"));
    await s.fire();
    expect(s.channelSends.map((send) => send.content)).toEqual(["Na czas"]);
    // The same minute fired again just after 19:00 finds it already sent.
    s.setNow(new Date("2026-07-01T17:00:00.020Z"));
    await s.fire();
    expect(s.channelSends).toHaveLength(1);
  });

  test("sends at most five at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const s = setup({
      onSend: async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
      },
    });
    for (let i = 0; i < 12; i++) {
      await s.schedule({
        time: "19:00",
        content: `${i}`,
        target: { kind: "channel", channelId: GENERAL },
      });
    }
    await s.fire();
    expect(s.channelSends).toHaveLength(12);
    expect(most).toBe(5);
  });

  test(`reads at most ${MAX_DUE_PER_TICK} rows a minute and warns when it hits that`, async () => {
    const s = setup();
    for (let i = 0; i < MAX_DUE_PER_TICK + 1; i++) {
      s.store.insert({
        guildId: `1000000000000${String(i).padStart(5, "0")}`,
        time: "19:00",
        content: "x",
        target: { kind: "channel", channelId: GENERAL },
        createdBy: ADMIN,
      });
    }
    await s.fire();
    expect(s.store.dueLimits).toEqual([MAX_DUE_PER_TICK]);
    expect(s.warnings).toEqual([
      {
        message: "Too many scheduled messages due at once; the rest wait for the next minute",
        fields: { at: SEVEN_PM.toISOString(), limit: MAX_DUE_PER_TICK },
      },
    ]);
  });

  test("the server name in the DM footer loses markdown and mention characters", async () => {
    const s = setup();
    s.guildNames.other = "**Zły** @everyone <@1> `x` [link](http://a)";
    await s.schedule({
      guildId: OTHER_GUILD,
      time: "19:00",
      content: "Hej",
      target: { kind: "dm", userId: MEMBER },
    });
    await s.fire();
    expect(s.dmSends[0]?.content).toBe(
      "Hej\n-# Zaplanowana wiadomość z serwera Zły everyone 1 x linkhttp//a.",
    );
  });

  test("a server name with nothing left after that falls back to the id", async () => {
    const s = setup();
    s.guildNames.other = "***";
    await s.schedule({
      guildId: OTHER_GUILD,
      time: "19:00",
      content: "Hej",
      target: { kind: "dm", userId: MEMBER },
    });
    await s.fire();
    expect(s.dmSends[0]?.content).toBe(`Hej\n-# Zaplanowana wiadomość z serwera ${OTHER_GUILD}.`);
  });
});

describe("languages", () => {
  test("every text of the catalog is filled in every language", () => {
    for (const texts of Object.values(renderCatalog(t))) {
      for (const text of Object.values(texts)) expect(text.trim()).not.toBe("");
    }
  });

  test("the commands answer in the language of the context", async () => {
    const s = setup();
    expect(replyText((await s.run("messages", "list", {}, { locale: "en" })).replies[0])).toBe(
      "No scheduled messages. Add one with `messages add`.",
    );
    expect(replyText((await s.run("messages", "list", {}, { locale: "de" })).replies[0])).toBe(
      "Keine geplanten Nachrichten. Füge eine mit `messages add` hinzu.",
    );
    expect(
      replyText((await s.run("messages", "remove", { id: 9 }, { locale: "de" })).replies[0]),
    ).toBe("Auf diesem Server gibt es keine Nachricht #9.");
  });

  test("the list of a server in English", async () => {
    const s = setup();
    await s.schedule({
      time: "09:00",
      content: "Hi",
      target: { kind: "channel", channelId: GENERAL },
    });
    const reply = replyText((await s.run("messages", "list", {}, { locale: "en" })).replies[0]);
    expect(reply).toBe(`Times in the Europe/Warsaw zone:\n#1 09:00 → <#${GENERAL}>: \`Hi\``);
  });

  test("the form and the prefix form refuse and confirm in the language of the context", async () => {
    const s = setup();
    expect(await s.submitForm({ time: "x", channel: GENERAL, text: "Hi" }, "en")).toEqual([
      "Give the time as HH:MM, e.g. 19:00.",
      "```\nHi\n```",
    ]);
    expect(await s.submitForm({ time: "19:00", channel: GENERAL, text: "Hi" }, "de")).toEqual([
      `Nachricht #1 für 19:00 (Europe/Warsaw) geplant → <#${GENERAL}>.`,
    ]);
    const ctx = await s.run(
      "messages",
      "add",
      { time: "19:00", target: `<#${NEWS}>`, text: "{user}" },
      { invocation: "prefix", locale: "en" },
    );
    expect(replyText(ctx.replies[0])).toBe(
      `Scheduled message #2 for 19:00 (Europe/Warsaw) → <#${NEWS}>. \`{user}\` only works in direct messages; in a channel it is posted literally.`,
    );
  });

  test("the /dm command answers in English and German", async () => {
    const s = setup();
    const off = await s.run("dm", "off", {}, { locale: "en", memberPermissions: 0n });
    expect(replyText(off.replies[0])).toBe(
      "You won't get scheduled messages from this server anymore.",
    );
    const on = await s.run("dm", "on", {}, { locale: "de", memberPermissions: 0n });
    expect(replyText(on.replies[0])).toBe(
      "Du bekommst wieder geplante Nachrichten von diesem Server.",
    );
  });

  test("a DM gets its footer and button in the recipient's language, not the scheduler's", async () => {
    const s = setup({ locales: fakeLocales("pl", { users: { [MEMBER]: "de" } }) });
    await s.schedule({ time: "19:00", content: "Hallo", target: { kind: "dm", userId: MEMBER } });
    await s.fire();
    expect(s.dmSends[0]?.content).toBe("Hallo\n-# Geplante Nachricht vom Server Dżajcarnia.");
    expect(optOutButtonOf(s.dmSends[0]).label).toBe("Keine mehr senden");
  });

  test("the opt-out button answers in the language of the member", async () => {
    const s = setup();
    const ctx = await clickComponent({
      registry: s.registry,
      customId: `messages:optout:${MEMBER}:${GUILD}`,
      guildId: null,
      locale: "en",
    });
    expect(replyText(ctx.replies[0])).toBe(
      "You won't get scheduled messages from the server Dżajcarnia anymore. Turn them back on with `/dm on` on that server.",
    );
  });
});
