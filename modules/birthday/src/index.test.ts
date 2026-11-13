import { describe, expect, test } from "bun:test";
import {
  type CronScheduler,
  createRegistry,
  executeCommand,
  type Locale,
  type LogFields,
  type Logger,
  silentLogger,
} from "@dzajcarz/core";
import {
  createFakeContext,
  fakeLocales,
  renderCatalog,
  replyText,
  submitModal,
} from "@dzajcarz/core/testing";
import {
  type Birthday,
  type BirthdayConfig,
  type BirthdaySender,
  type BirthdayStore,
  celebratedDays,
  createBirthdayModule,
  isLeapYear,
  isValidBirthday,
  localTime,
  renderBirthday,
} from "./index.ts";
import { t } from "./messages.ts";

const MANAGE_GUILD = 1n << 5n;
const GUILD = "100000000000000001";
const NY_GUILD = "100000000000000002";
const CHANNEL = "400000000000000004";
const NY_CHANNEL = "400000000000000005";
const FOREIGN_CHANNEL = "900000000000000009";
const CALLER = "200000000000000002";
const OLA = "500000000000000005";
const JAN = "500000000000000006";
const ZONE = "Europe/Warsaw";

type ChannelResult = "sent" | "gone" | "fail";
type DmResult = "sent" | "closed" | "fail";

function setup({ locales = fakeLocales("pl") } = {}) {
  const birthdays = new Map<string, Birthday>();
  const configs = new Map<string, BirthdayConfig>();
  const wishes = new Set<string>();
  const key = (userId: string, target: string, year: number) => `${userId}|${target}|${year}`;
  const store: BirthdayStore = {
    get: async (userId) => birthdays.get(userId) ?? null,
    set: async (userId, birthday) => void birthdays.set(userId, birthday),
    remove: async (userId) => birthdays.delete(userId),
    unwished: async (target, year, month, days) =>
      [...birthdays.entries()]
        .filter(
          ([userId, b]) =>
            b.month === month && days.includes(b.day) && !wishes.has(key(userId, target, year)),
        )
        .map(([userId]) => userId)
        .sort(),
    claimWish: async (userId, target, year) => {
      const k = key(userId, target, year);
      if (wishes.has(k)) return false;
      wishes.add(k);
      return true;
    },
    releaseWish: async (userId, target, year) => void wishes.delete(key(userId, target, year)),
    getConfig: async (guildId) => configs.get(guildId) ?? null,
    setConfig: async (guildId, config) => void configs.set(guildId, config),
    deleteConfig: async (guildId) => configs.delete(guildId),
    configs: async () => [...configs.entries()].map(([guildId, c]) => ({ guildId, ...c })),
  };

  const posts: { guildId: string; channelId: string; text: string; memberId: string }[] = [];
  const dms: { userId: string; text: string }[] = [];
  const results = { channel: [] as ChannelResult[], dm: [] as DmResult[] };
  const sender: BirthdaySender = {
    async toChannel(guildId, channelId, text, memberId) {
      const result = results.channel.shift() ?? "sent";
      if (result === "fail") throw new Error("rate limited");
      if (result === "sent") posts.push({ guildId, channelId, text, memberId });
      return result;
    },
    async toUser(userId, text) {
      const result = results.dm.shift() ?? "sent";
      if (result === "fail") throw new Error("rate limited");
      if (result === "sent") dms.push({ userId, text });
      return result;
    },
  };
  const memberNames: Record<string, Record<string, string>> = {
    [GUILD]: { [OLA]: "Ola_*", [JAN]: "Jan", [CALLER]: "tester" },
    [NY_GUILD]: { [OLA]: "Ola NY" },
  };
  const guildNames: Record<string, string> = { [GUILD]: "Dżajsy", [NY_GUILD]: "New York" };
  const disabled = new Set<string>();
  const zones: Record<string, string> = { [NY_GUILD]: "America/New_York" };

  let clock = new Date("2027-03-12T07:00:00Z");
  let task: (() => void | Promise<void>) | undefined;
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

  const logs: { level: string; message: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    ...silentLogger,
    info: (message, fields) => void logs.push({ level: "info", message, fields }),
    warn: (message, fields) => void logs.push({ level: "warn", message, fields }),
    error: (message, fields) => void logs.push({ level: "error", message, fields }),
    child: () => logger,
  };

  const module = createBirthdayModule({
    store,
    sender,
    members: {
      displayName: async (guildId, userId) => memberNames[guildId]?.[userId] ?? null,
      guildName: async (guildId) => guildNames[guildId] ?? null,
    },
    channels: {
      isTextChannelOf: async (guildId, channelId) =>
        (guildId === GUILD && channelId === CHANNEL) ||
        (guildId === NY_GUILD && channelId === NY_CHANNEL),
    },
    cron,
    timeZones: { of: async (guildId) => (guildId !== null ? zones[guildId] : undefined) ?? ZONE },
    locales,
    moduleEnabled: async (_guildId, channelId) => !disabled.has(channelId),
    now: () => clock,
    logger,
  });
  const registry = createRegistry([module]);
  const command = registry.find("birthday");
  if (!command) throw new Error("birthday command missing");

  const run = async (
    subcommand: string,
    args: Record<string, unknown> = {},
    options: {
      permissions?: bigint;
      invocation?: "slash" | "prefix";
      guildId?: string | null;
      locale?: Locale;
    } = {},
  ) => {
    const ctx = createFakeContext({
      args,
      subcommand,
      memberPermissions: options.permissions ?? MANAGE_GUILD,
      invocation: options.invocation ?? "slash",
      guildId: options.guildId === undefined ? GUILD : options.guildId,
      locale: options.locale,
      userId: CALLER,
    });
    await executeCommand(command, ctx, silentLogger);
    return Object.assign(
      ctx.replies.map((r) => replyText(r) ?? ""),
      { replies: ctx.replies, modals: ctx.modals, deferred: ctx.deferred },
    );
  };

  const tickAt = async (iso: string) => {
    clock = new Date(iso);
    await task?.();
  };

  return {
    run,
    registry,
    birthdays,
    configs,
    wishes,
    posts,
    dms,
    results,
    disabled,
    memberNames,
    guildNames,
    logs,
    cronCalls,
    tickAt,
    module,
    store,
    isStopped: () => stopped,
  };
}

describe("calendar", () => {
  test("29 February is a valid birthday, 30 February and 31 April are not", () => {
    expect(isValidBirthday(29, 2)).toBe(true);
    expect(isValidBirthday(31, 12)).toBe(true);
    expect(isValidBirthday(30, 2)).toBe(false);
    expect(isValidBirthday(31, 4)).toBe(false);
    expect(isValidBirthday(0, 1)).toBe(false);
    expect(isValidBirthday(1, 13)).toBe(false);
    expect(isValidBirthday(1.5, 1)).toBe(false);
  });

  test("leap years", () => {
    expect([2024, 2028, 2000].map(isLeapYear)).toEqual([true, true, true]);
    expect([2027, 1900, 2100].map(isLeapYear)).toEqual([false, false, false]);
  });

  test("28 February of a common year also celebrates 29 February", () => {
    expect(celebratedDays({ year: 2027, month: 2, day: 28, hour: 9 })).toEqual([28, 29]);
    expect(celebratedDays({ year: 2028, month: 2, day: 28, hour: 9 })).toEqual([28]);
    expect(celebratedDays({ year: 2028, month: 2, day: 29, hour: 9 })).toEqual([29]);
    expect(celebratedDays({ year: 2027, month: 3, day: 1, hour: 9 })).toEqual([1]);
  });

  test("localTime reads the zone's wall clock", () => {
    expect(localTime(new Date("2027-12-31T23:30:00Z"), ZONE)).toEqual({
      year: 2028,
      month: 1,
      day: 1,
      hour: 0,
    });
    expect(localTime(new Date("2027-03-12T08:00:00Z"), "America/New_York")).toEqual({
      year: 2027,
      month: 3,
      day: 12,
      hour: 3,
    });
  });

  test("renderBirthday escapes names and leaves unknown placeholders", () => {
    expect(
      renderBirthday("{user} {username} {server} {memberCount}", {
        userId: OLA,
        username: "*Ola*",
        serverName: "@everyone",
      }),
    ).toBe(`<@${OLA}> \\*Ola\\* \\@everyone {memberCount}`);
  });
});

describe("/birthday set, remove, show", () => {
  test("set saves the day and month, also in a DM with the bot", async () => {
    const s = setup();
    const [reply] = await s.run("set", { day: 12, month: 3 });
    expect(s.birthdays.get(CALLER)).toEqual({ month: 3, day: 12 });
    expect(reply).toContain("12 marca");
    await s.run("set", { day: 1, month: 1 }, { guildId: null });
    expect(s.birthdays.get(CALLER)).toEqual({ month: 1, day: 1 });
  });

  test("set accepts 29 February and refuses days that do not exist", async () => {
    const s = setup();
    await s.run("set", { day: 29, month: 2 });
    expect(s.birthdays.get(CALLER)).toEqual({ month: 2, day: 29 });
    for (const [day, month] of [
      [30, 2],
      [31, 4],
      [31, 11],
    ]) {
      const [reply] = await s.run("set", { day, month });
      expect(reply).toBe("Nie ma takiego dnia. Podaj dzień i miesiąc, np. `birthday set 12 3`.");
    }
    expect(s.birthdays.get(CALLER)).toEqual({ month: 2, day: 29 });
  });

  test("set replies are ephemeral and localized", async () => {
    const s = setup();
    const en = await s.run("set", { day: 12, month: 3 }, { locale: "en" });
    expect(en[0]).toContain("12 March");
    expect(en.replies[0]).toMatchObject({ ephemeral: true });
    expect((await s.run("set", { day: 3, month: 10 }, { locale: "de" }))[0]).toContain(
      "3. Oktober",
    );
    expect((await s.run("set", { day: 31, month: 6 }, { locale: "en" }))[0]).toContain(
      "doesn't exist",
    );
  });

  test("remove deletes the birthday and says when there was none", async () => {
    const s = setup();
    s.birthdays.set(CALLER, { month: 3, day: 12 });
    expect((await s.run("remove"))[0]).toBe("Usunięto Twoje urodziny.");
    expect(s.birthdays.has(CALLER)).toBe(false);
    expect((await s.run("remove"))[0]).toBe("Nie masz zapisanych urodzin.");
    expect((await s.run("remove", {}, { locale: "de", guildId: null }))[0]).toBe(
      "Du hast keinen Geburtstag gespeichert.",
    );
  });

  test("show without a user shows your own birthday", async () => {
    const s = setup();
    expect((await s.run("show"))[0]).toContain("birthday set");
    s.birthdays.set(CALLER, { month: 3, day: 12 });
    expect((await s.run("show"))[0]).toBe("Twoje urodziny: 12 marca.");
    expect((await s.run("show", {}, { locale: "en" }))[0]).toBe("Your birthday: 12 March.");
  });

  test("show with a user shows theirs", async () => {
    const s = setup();
    expect((await s.run("show", { user: OLA }))[0]).toBe(`<@${OLA}> nie ma zapisanych urodzin.`);
    s.birthdays.set(OLA, { month: 2, day: 29 });
    expect((await s.run("show", { user: OLA }))[0]).toBe(`Urodziny <@${OLA}>: 29 lutego.`);
    expect((await s.run("show", { user: OLA }, { locale: "de" }))[0]).toBe(
      `Geburtstag von <@${OLA}>: 29. Februar.`,
    );
    expect((await s.run("show", { user: CALLER }))[0]).toContain("Nie masz");
  });

  test("show does not reveal the birthday of someone outside the server, or of anyone in a DM", async () => {
    const s = setup();
    s.birthdays.set(OLA, { month: 2, day: 29 });
    const none = `<@${OLA}> nie ma zapisanych urodzin.`;
    expect((await s.run("show", { user: OLA }, { guildId: null }))[0]).toBe(none);
    delete s.memberNames[GUILD]?.[OLA];
    expect((await s.run("show", { user: OLA }))[0]).toBe(none);
    s.birthdays.set(CALLER, { month: 3, day: 12 });
    expect((await s.run("show", {}, { guildId: null }))[0]).toBe("Twoje urodziny: 12 marca.");
  });
});

describe("/birthday channel", () => {
  test("slash opens the form, prefilled with the current settings", async () => {
    const s = setup();
    const first = await s.run("channel");
    expect(first).toHaveLength(0);
    const fields = first.modals[0]?.fields ?? [];
    expect(fields.map((f) => [f.customId, f.type])).toEqual([
      ["channel", "channel"],
      ["message", "paragraph"],
    ]);
    for (const placeholder of ["{user}", "{username}", "{server}"]) {
      expect(JSON.stringify(fields[1]?.description)).toContain(placeholder);
    }
    s.configs.set(GUILD, { channelId: CHANNEL, template: "Sto lat {user}" });
    const [spec] = (await s.run("channel")).modals;
    expect(spec?.fields.map((f) => f.value)).toEqual([CHANNEL, "Sto lat {user}"]);
    s.configs.set(GUILD, { channelId: FOREIGN_CHANNEL, template: "x" });
    const [stale] = (await s.run("channel")).modals;
    expect(stale?.fields.map((f) => f.value)).toEqual([undefined, "x"]);
  });

  async function submit(values: Record<string, string | string[]>, locale?: Locale) {
    const s = setup();
    const [spec] = (await s.run("channel")).modals;
    if (!spec) throw new Error("modal not opened");
    const ctx = await submitModal({
      registry: s.registry,
      customId: spec.customId,
      values,
      guildId: GUILD,
      memberPermissions: MANAGE_GUILD,
      locale,
    });
    return { s, ctx, texts: ctx.replies.map((r) => replyText(r) ?? "") };
  }

  test("a valid submit saves the trimmed template", async () => {
    const { s, ctx, texts } = await submit({ channel: [CHANNEL], message: "  Sto lat {user}  " });
    expect(s.configs.get(GUILD)).toEqual({ channelId: CHANNEL, template: "Sto lat {user}" });
    expect(texts[0]).toContain(`<#${CHANNEL}>`);
    expect(ctx.replies[0]).toMatchObject({ ephemeral: true });
  });

  test("the form refuses a foreign channel and an empty message", async () => {
    const foreign = await submit({ channel: [FOREIGN_CHANNEL], message: "x" });
    expect(foreign.texts[0]).toBe("Wybierz kanał tekstowy z tego serwera.");
    const empty = await submit({ channel: [CHANNEL], message: "  " }, "en");
    expect(empty.texts[0]).toBe("The message can't be empty.");
    expect(empty.s.configs.size).toBe(0);
  });

  test("a message over the limit is handed back in code blocks", async () => {
    const message = "a".repeat(2001);
    const { s, texts } = await submit({ channel: [CHANNEL], message }, "de");
    expect(texts[0]).toBe("Der Text darf höchstens 2000 Zeichen lang sein.");
    expect(texts.slice(1).join("")).toContain("a".repeat(100));
    expect(s.configs.size).toBe(0);
  });

  test("the prefix form takes the channel and the message as arguments", async () => {
    const s = setup();
    const [reply] = await s.run(
      "channel",
      { channel: CHANNEL, message: "Sto lat {user}" },
      { invocation: "prefix" },
    );
    expect(s.configs.get(GUILD)).toEqual({ channelId: CHANNEL, template: "Sto lat {user}" });
    expect(reply).toContain(`<#${CHANNEL}>`);
    expect((await s.run("channel", {}, { invocation: "prefix" }))[0]).toContain(
      "birthday channel <channel>",
    );
    expect(
      (
        await s.run(
          "channel",
          { channel: CHANNEL, message: "a".repeat(2001) },
          { invocation: "prefix" },
        )
      )[0],
    ).toContain("2000");
  });

  test("channel, test and disable need Manage Server and a server", async () => {
    const s = setup();
    for (const sub of ["channel", "test", "disable"]) {
      const [refused] = await s.run(sub, { channel: CHANNEL, message: "x" }, { permissions: 0n });
      expect(refused).toBe("Nie masz uprawnień do tej komendy.");
      const [dm] = await s.run(sub, {}, { guildId: null });
      expect(dm).toBe("Ta komenda działa tylko na serwerze.");
    }
    expect(s.configs.size).toBe(0);
  });
});

describe("/birthday test and disable", () => {
  test("test posts the rendered wishes for the caller", async () => {
    const s = setup();
    s.configs.set(GUILD, { channelId: CHANNEL, template: "{user} {username} {server}" });
    const result = await s.run("test");
    expect(result.deferred).toBe(true);
    expect(s.posts).toEqual([
      { guildId: GUILD, channelId: CHANNEL, text: `<@${CALLER}> tester Dżajsy`, memberId: CALLER },
    ]);
    expect(result[0]).toBe("Wysłano życzenia testowe.");
    expect((await s.run("test", {}, { locale: "en" }))[0]).toBe("Sent the test wishes.");
  });

  test("test explains a missing config, server or a channel it cannot post in", async () => {
    const s = setup();
    expect((await s.run("test"))[0]).toContain("birthday channel");
    s.configs.set(GUILD, { channelId: CHANNEL, template: "x" });
    s.results.channel.push("gone");
    expect((await s.run("test"))[0]).toContain(`<#${CHANNEL}>`);
    s.results.channel.push("fail");
    expect((await s.run("test", {}, { locale: "de" }))[0]).toContain("Ich kann nicht");
    expect(s.logs.some((log) => log.message === "Birthday test could not be sent")).toBe(true);
    delete s.guildNames[GUILD];
    expect((await s.run("test"))[0]).toBe("Nie mogę pobrać danych serwera.");
  });

  test("disable removes the config and says when there was none", async () => {
    const s = setup();
    expect((await s.run("disable"))[0]).toBe("Życzenia urodzinowe nie były ustawione.");
    s.configs.set(GUILD, { channelId: CHANNEL, template: "x" });
    expect((await s.run("disable", {}, { locale: "en" }))[0]).toBe("Birthday wishes are off.");
    expect(s.configs.size).toBe(0);
  });
});

describe("the daily run", () => {
  function withBirthdays(options?: Parameters<typeof setup>[0]) {
    const s = setup(options);
    s.configs.set(GUILD, {
      channelId: CHANNEL,
      template: "Sto lat {user} ({username}, {server})!",
    });
    s.birthdays.set(OLA, { month: 3, day: 12 });
    return s;
  }

  test("runs every 15 minutes of UTC and stops on dispose", async () => {
    const s = setup();
    expect(s.cronCalls).toEqual([{ expression: "*/15 * * * *", timeZone: "UTC" }]);
    await s.module.dispose?.();
    expect(s.isStopped()).toBe(true);
  });

  test("nothing before 9:00 on the server's clock; at 9:00 the member is wished and pinged", async () => {
    const s = withBirthdays();
    // 08:45 in Warsaw (UTC+1 in March before the clock change).
    await s.tickAt("2027-03-12T07:45:00Z");
    expect(s.posts).toEqual([]);
    expect(s.dms).toEqual([]);
    // A tick a few seconds early still counts as 9:00.
    await s.tickAt("2027-03-12T07:59:57Z");
    expect(s.posts).toEqual([
      {
        guildId: GUILD,
        channelId: CHANNEL,
        text: `Sto lat <@${OLA}> (Ola\\_\\*, Dżajsy)!`,
        memberId: OLA,
      },
    ]);
    expect(s.dms.map((dm) => dm.userId)).toEqual([OLA]);
  });

  test("each wish goes out once per server and year, the DM once per year", async () => {
    const s = withBirthdays();
    await s.tickAt("2027-03-12T08:00:00Z");
    await s.tickAt("2027-03-12T08:15:00Z");
    await s.tickAt("2027-03-12T20:00:00Z");
    expect(s.posts).toHaveLength(1);
    expect(s.dms).toHaveLength(1);
    await s.tickAt("2027-03-13T08:00:00Z");
    expect(s.posts).toHaveLength(1);
    await s.tickAt("2028-03-12T08:00:00Z");
    expect(s.posts).toHaveLength(2);
    expect(s.dms).toHaveLength(2);
  });

  test("a run after downtime catches up the same day", async () => {
    const s = withBirthdays();
    await s.tickAt("2027-03-12T21:30:00Z");
    expect(s.posts).toHaveLength(1);
    expect(s.dms).toHaveLength(1);
  });

  test("each server wishes at 9:00 on its own clock, and only its members", async () => {
    const s = withBirthdays();
    s.configs.set(NY_GUILD, { channelId: NY_CHANNEL, template: "Happy birthday {username}" });
    // Jan is no member of the New York server.
    s.birthdays.set(JAN, { month: 3, day: 12 });
    await s.tickAt("2027-03-12T08:00:00Z");
    expect(s.posts.map((p) => [p.guildId, p.memberId])).toEqual([
      [GUILD, OLA],
      [GUILD, JAN],
    ]);
    // 9:00 in New York (UTC-5 before 14 March).
    await s.tickAt("2027-03-12T13:45:00Z");
    expect(s.posts).toHaveLength(2);
    await s.tickAt("2027-03-12T14:00:00Z");
    expect(s.posts.slice(2)).toEqual([
      { guildId: NY_GUILD, channelId: NY_CHANNEL, text: "Happy birthday Ola NY", memberId: OLA },
    ]);
    expect([...s.wishes]).not.toContain(`${JAN}|${NY_GUILD}|2027`);
  });

  test("a member who is not on the server is not claimed, so joining later the same day counts", async () => {
    const s = withBirthdays();
    delete s.memberNames[GUILD]?.[OLA];
    await s.tickAt("2027-03-12T08:00:00Z");
    expect(s.posts).toEqual([]);
    (s.memberNames[GUILD] as Record<string, string>)[OLA] = "Ola";
    await s.tickAt("2027-03-12T08:15:00Z");
    expect(s.posts).toHaveLength(1);
  });

  test("29 February is wished on 28 February in a common year and on 29 February in a leap year", async () => {
    const s = setup();
    s.configs.set(GUILD, { channelId: CHANNEL, template: "{user}" });
    s.birthdays.set(JAN, { month: 2, day: 29 });
    s.birthdays.set(OLA, { month: 2, day: 28 });
    await s.tickAt("2027-02-28T08:00:00Z");
    expect(s.posts.map((p) => p.memberId).sort()).toEqual([JAN, OLA].sort());
    await s.tickAt("2027-03-01T08:00:00Z");
    expect(s.posts).toHaveLength(2);
    await s.tickAt("2028-02-28T08:00:00Z");
    expect(s.posts.slice(2).map((p) => p.memberId)).toEqual([OLA]);
    await s.tickAt("2028-02-29T08:00:00Z");
    expect(s.posts.slice(3).map((p) => p.memberId)).toEqual([JAN]);
    expect(s.dms.filter((dm) => dm.userId === JAN)).toHaveLength(2);
  });

  test("the module toggle on the channel stops the server's wishes, but not the DM", async () => {
    const s = withBirthdays();
    s.disabled.add(CHANNEL);
    await s.tickAt("2027-03-12T08:00:00Z");
    expect(s.posts).toEqual([]);
    expect(s.dms).toHaveLength(1);
    s.disabled.delete(CHANNEL);
    await s.tickAt("2027-03-12T08:15:00Z");
    expect(s.posts).toHaveLength(1);
  });

  test("a server the bot does not know is skipped without claiming", async () => {
    const s = withBirthdays();
    delete s.guildNames[GUILD];
    await s.tickAt("2027-03-12T08:00:00Z");
    expect(s.posts).toEqual([]);
    expect([...s.wishes]).toEqual([`${OLA}|dm|2027`]);
  });

  test("the DM is written in the member's own language", async () => {
    const s = withBirthdays({ locales: fakeLocales("pl", { users: { [OLA]: "en" } }) });
    s.birthdays.set(JAN, { month: 3, day: 12 });
    await s.tickAt("2027-03-12T08:00:00Z");
    expect(s.dms).toEqual([
      { userId: OLA, text: t("en").dmWish },
      { userId: JAN, text: t("pl").dmWish },
    ]);
  });

  test("the DM waits for 9:00 in the default zone, whatever the servers' zones", async () => {
    const s = setup();
    s.birthdays.set(OLA, { month: 3, day: 12 });
    await s.tickAt("2027-03-12T07:45:00Z");
    expect(s.dms).toEqual([]);
    await s.tickAt("2027-03-12T08:00:00Z");
    expect(s.dms).toHaveLength(1);
  });

  test("a transient failure gives the claim back, so a later run sends it", async () => {
    const s = withBirthdays();
    s.results.channel.push("fail");
    s.results.dm.push("fail");
    await s.tickAt("2027-03-12T08:00:00Z");
    expect(s.posts).toEqual([]);
    expect(s.dms).toEqual([]);
    expect(s.wishes.size).toBe(0);
    expect(s.logs.filter((log) => log.level === "warn")).toHaveLength(2);
    await s.tickAt("2027-03-12T08:15:00Z");
    expect(s.posts).toHaveLength(1);
    expect(s.dms).toHaveLength(1);
  });

  test("a gone channel or closed DMs keep the claim, so it is not retried", async () => {
    const s = withBirthdays();
    s.results.channel.push("gone");
    s.results.dm.push("closed");
    await s.tickAt("2027-03-12T08:00:00Z");
    await s.tickAt("2027-03-12T08:15:00Z");
    expect(s.posts).toEqual([]);
    expect(s.dms).toEqual([]);
    expect(s.wishes.size).toBe(2);
    expect(
      s.logs.filter((log) => log.message === "Birthday wish not delivered and not retried"),
    ).toHaveLength(2);
  });

  test("a member lookup that throws skips that member only", async () => {
    const s = withBirthdays();
    s.birthdays.set(JAN, { month: 3, day: 12 });
    s.memberNames[GUILD] = new Proxy({ [JAN]: "Jan" } as Record<string, string>, {
      get: (target, userId: string) => {
        if (userId === OLA) throw new Error("Discord down");
        return target[userId];
      },
    });
    await s.tickAt("2027-03-12T08:00:00Z");
    expect(s.posts.map((p) => p.memberId)).toEqual([JAN]);
    expect(s.logs.some((log) => log.message === "Birthday wish skipped")).toBe(true);
  });

  test("a failing store is logged, never thrown", async () => {
    const s = withBirthdays();
    s.store.unwished = async () => {
      throw new Error("Postgres down");
    };
    await s.tickAt("2027-03-12T08:00:00Z");
    s.store.configs = async () => {
      throw new Error("Postgres down");
    };
    await s.tickAt("2027-03-12T08:15:00Z");
    expect(s.logs.map((log) => [log.level, log.message])).toEqual([
      ["error", "Birthday DMs failed"],
      ["warn", "Birthday wishes failed for a server"],
      ["error", "Birthday DMs failed"],
      ["error", "Birthday configs could not be read"],
    ]);
  });
});

describe("catalog", () => {
  test("every text of the catalog is filled in every language", () => {
    const rendered = renderCatalog(t, { date: [12, 3] });
    for (const texts of Object.values(rendered)) {
      for (const text of Object.values(texts)) expect(text.trim()).not.toBe("");
    }
    expect(rendered.de.date).toBe("12. März");
  });
});
