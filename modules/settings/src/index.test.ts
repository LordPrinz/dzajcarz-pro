import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  executeCommand,
  type Locale,
  matchPrefix,
  parsePrefixArgs,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext, renderCatalog, replyText } from "@dzajcarz/core/testing";
import {
  createSettingsModule,
  type DisabledModule,
  type GuildChannels,
  type LanguageSettings,
  type ModuleToggles,
  type PrefixSettings,
} from "./index.ts";
import { t } from "./messages.ts";

const MANAGE_GUILD = 1n << 5n;

const noModules: ModuleToggles = {
  moduleNames: () => [],
  list: async () => [],
  disable: async () => {},
  enable: async () => false,
};

const GUILD_ID = "100000000000000001";

/** Knows the channels of one guild only. */
function channelsOf(ids: readonly string[], threads: readonly string[] = []): GuildChannels {
  return {
    belongsTo: async (guildId, channelId) => guildId === GUILD_ID && ids.includes(channelId),
    isThread: async (_guildId, channelId) => threads.includes(channelId),
  };
}

function setup() {
  const store = new Map<string, string>();
  const prefixes: PrefixSettings = {
    get: async (guildId) => store.get(guildId) ?? null,
    set: async (guildId, prefix) => void store.set(guildId, prefix),
    reset: async (guildId) => void store.delete(guildId),
  };
  const registry = createRegistry([
    createSettingsModule({
      prefixes,
      defaultPrefix: "!",
      timeZones: memoryZones(),
      defaultTimeZone: "Europe/Warsaw",
      modules: noModules,
      channels: channelsOf([]),
      languages: memoryLanguages(),
    }),
  ]);
  const command = registry.find("prefix");
  if (!command) throw new Error("prefix command missing");

  const run = async (
    subcommand: string,
    args: Record<string, unknown> = {},
    memberPermissions: bigint = MANAGE_GUILD,
    locale: Locale = "pl",
  ) => {
    const ctx = createFakeContext({ args, subcommand, memberPermissions, locale });
    await executeCommand(command, ctx, silentLogger);
    return ctx.replies.map((r) => replyText(r));
  };
  return { run, store, command };
}

function memoryLanguages() {
  const guilds = new Map<string, Locale>();
  const users = new Map<string, Locale>();
  const settings: LanguageSettings = {
    guild: async (guildId) => guilds.get(guildId) ?? null,
    setGuild: async (guildId, locale) =>
      void (locale ? guilds.set(guildId, locale) : guilds.delete(guildId)),
    user: async (userId) => users.get(userId) ?? null,
    setUser: async (userId, locale) =>
      void (locale ? users.set(userId, locale) : users.delete(userId)),
  };
  return { ...settings, guilds, users };
}

describe("settings module: /prefix", () => {
  test("requires Manage Server", async () => {
    const { run, store } = setup();
    const [reply] = await run("set", { prefix: "?" }, 0n);
    expect(reply).toContain("uprawnie");
    expect(store.size).toBe(0);
  });

  test("set stores the prefix and show reports it", async () => {
    const { run, store } = setup();
    expect(await run("set", { prefix: "?" })).toEqual(["Prefiks to teraz `?`."]);
    expect([...store.values()]).toEqual(["?"]);
    expect((await run("show"))[0]).toContain("`?`");
  });

  test("show falls back to the default prefix, reset returns to it", async () => {
    const { run, store } = setup();
    expect((await run("show"))[0]).toContain("`!`");
    await run("set", { prefix: "dz" });
    expect(await run("reset")).toEqual(["Przywrócono domyślny prefiks `!`."]);
    expect(store.size).toBe(0);
  });

  test("replies are ephemeral", async () => {
    const { command } = setup();
    const ctx = createFakeContext({
      args: { prefix: "?" },
      subcommand: "set",
      memberPermissions: MANAGE_GUILD,
    });
    await executeCommand(command, ctx, silentLogger);
    expect(ctx.replies[0]).toMatchObject({ ephemeral: true });
  });

  test.each([
    ["", "od 1 do 5"],
    ["toolong", "od 1 do 5"],
    ["a b", "spacji"],
    ["a\tb", "spacji"],
    ["a\u200bb", "niewidocznych"],
    ["`", "znaku `"],
  ])("rejects the prefix %j", async (prefix, message) => {
    const { run, store } = setup();
    const [reply] = await run("set", { prefix });
    expect(reply).toContain(message);
    expect(store.size).toBe(0);
  });

  test("counts characters by code point, so five emoji fit", async () => {
    const { run } = setup();
    expect(await run("set", { prefix: "😀😀😀😀😀" })).toEqual(["Prefiks to teraz `😀😀😀😀😀`."]);
    const [reply] = await run("set", { prefix: "😀😀😀😀😀😀" });
    expect(reply).toContain("od 1 do 5");
  });

  test("accepts 5 characters and multi-character prefixes", async () => {
    const { run } = setup();
    expect(await run("set", { prefix: "dzaj!" })).toEqual(["Prefiks to teraz `dzaj!`."]);
  });

  test("the prefix form parses `!prefix set ?`", () => {
    const { command } = setup();
    const invocation = matchPrefix("!prefix set ?", "!");
    expect(invocation).toEqual({ name: "prefix", rest: "set ?" });
    expect(parsePrefixArgs(command, invocation?.rest ?? "")).toEqual({
      ok: true,
      subcommand: "set",
      args: { prefix: "?" },
    });
  });
});

describe("settings module: /modules", () => {
  const CHANNEL = "400000000000000004";

  const THREAD = "500000000000000005";
  const CATEGORY = "600000000000000006";

  function setupModules({ threads = [] as string[] } = {}) {
    const disabled: DisabledModule[] = [];
    const modules: ModuleToggles = {
      moduleNames: () => ["general", "settings", "status", "music", "welcome"],
      list: async () => disabled,
      disable: async (_guild, module, channelId) => {
        disabled.push({ module, channelId });
      },
      enable: async (_guild, module, channelId) => {
        const index = disabled.findIndex((d) => d.module === module && d.channelId === channelId);
        if (index >= 0) disabled.splice(index, 1);
        return index >= 0;
      },
    };
    const prefixes: PrefixSettings = {
      get: async () => null,
      set: async () => {},
      reset: async () => {},
    };
    const registry = createRegistry([
      createSettingsModule({
        prefixes,
        defaultPrefix: "!",
        timeZones: memoryZones(),
        defaultTimeZone: "Europe/Warsaw",
        modules,
        channels: channelsOf([CHANNEL, THREAD, CATEGORY], threads),
        languages: memoryLanguages(),
      }),
    ]);
    const command = registry.find("modules");
    if (!command) throw new Error("modules command missing");
    const run = async (
      subcommand: string,
      args: Record<string, unknown> = {},
      memberPermissions: bigint = MANAGE_GUILD,
    ) => {
      const ctx = createFakeContext({ args, subcommand, memberPermissions, guildId: GUILD_ID });
      await executeCommand(command, ctx, silentLogger);
      return ctx.replies.map((r) => replyText(r) ?? "");
    };
    return { run, disabled, command, modules };
  }

  test("requires Manage Server", async () => {
    const { run, disabled } = setupModules();
    const [reply] = await run("disable", { module: "music" }, 0n);
    expect(reply).toContain("uprawnie");
    expect(disabled).toEqual([]);
  });

  test("says scheduled DMs cannot be switched off on a channel", async () => {
    const { run, modules } = setupModules();
    modules.moduleNames = () => ["general", "messages"];
    const [onChannel] = await run("disable", { module: "messages", channel: CHANNEL });
    expect(onChannel).toContain(`w <#${CHANNEL}>`);
    expect(onChannel).toContain("prywatne");
    const [wholeServer] = await run("disable", { module: "messages" });
    expect(wholeServer).toBe("Moduł `messages` jest wyłączony na serwerze.");
  });

  test("disable and enable for the whole server", async () => {
    const { run, disabled } = setupModules();
    expect(await run("disable", { module: "music" })).toEqual([
      "Moduł `music` jest wyłączony na serwerze.",
    ]);
    expect(disabled).toEqual([{ module: "music", channelId: null }]);
    expect(await run("enable", { module: "music" })).toEqual([
      "Moduł `music` jest znów włączony na serwerze.",
    ]);
    expect(disabled).toEqual([]);
  });

  test("disable in one channel, then enable reports when nothing was disabled", async () => {
    const { run, disabled } = setupModules();
    const [reply] = await run("disable", { module: "welcome", channel: CHANNEL });
    expect(reply).toContain(`<#${CHANNEL}>`);
    expect(disabled).toEqual([{ module: "welcome", channelId: CHANNEL }]);
    expect((await run("enable", { module: "welcome" }))[0]).toContain("nie był wyłączony");
    expect(disabled).toHaveLength(1);
  });

  test("module names are case-insensitive", async () => {
    const { run, disabled } = setupModules();
    await run("disable", { module: "MUSIC" });
    expect(disabled).toEqual([{ module: "music", channelId: null }]);
  });

  test.each(["general", "settings", "status"])("%s cannot be disabled", async (module) => {
    const { run, disabled } = setupModules();
    const [reply] = await run("disable", { module });
    expect(reply).toContain("nie można wyłączyć");
    expect(disabled).toEqual([]);
  });

  test("an unknown module gets an error that lists the valid names", async () => {
    const { run, disabled } = setupModules();
    const [reply] = await run("disable", { module: "nope" });
    expect(reply).toContain("Nie ma modułu `nope`");
    expect(reply).toContain("`music`, `welcome`");
    expect(reply).not.toContain("`general`");
    expect(disabled).toEqual([]);
  });

  test("a channel outside the guild is refused by disable", async () => {
    const { run, disabled } = setupModules();
    const foreign = "900000000000000009";
    expect((await run("disable", { module: "music", channel: foreign }))[0]).toContain(
      "Nie znalazłem takiego kanału",
    );
    expect(disabled).toEqual([]);
  });

  test("enable removes a row whose channel no longer exists", async () => {
    const { run, disabled } = setupModules();
    const deleted = "900000000000000009";
    disabled.push({ module: "music", channelId: deleted });
    expect((await run("enable", { module: "music", channel: deleted }))[0]).toContain(
      "jest znów włączony",
    );
    expect(disabled).toEqual([]);
  });

  test("disable refuses a thread because toggles follow the parent channel", async () => {
    const { run, disabled } = setupModules({ threads: [THREAD] });
    expect((await run("disable", { module: "music", channel: THREAD }))[0]).toContain("Wątki");
    expect(disabled).toEqual([]);
  });

  test("an unknown module name is echoed without backticks and cut to 32 characters", async () => {
    const { run } = setupModules();
    const [reply] = await run("disable", { module: `\`${"x".repeat(100)}` });
    expect(reply).toContain(`Nie ma modułu \`${"x".repeat(32)}\`.`);
  });

  test("the echoed name is cut on code points, not in the middle of an emoji", async () => {
    const { run } = setupModules();
    const [reply] = await run("disable", { module: "😀".repeat(40) });
    expect(reply).toContain(`Nie ma modułu \`${"😀".repeat(32)}\`.`);
  });

  test("list stays under 2000 characters and counts what it left out", async () => {
    const { run, modules } = setupModules();
    const names = Array.from({ length: 200 }, (_, i) => `module${i}`);
    modules.moduleNames = () => names;
    const reply = (await run("list"))[0] ?? "";
    expect(reply.length).toBeLessThan(2000);
    expect(reply).toMatch(/\n… i jeszcze \d+$/);
  });

  test("list shortens a very long channel list", async () => {
    const { run, modules } = setupModules();
    modules.list = async () =>
      Array.from({ length: 30 }, (_, i) => ({ module: "music", channelId: `${1000 + i}` }));
    const [reply] = await run("list");
    expect(reply).toContain("i jeszcze 20");
  });

  test("a category can be switched off and is listed like a channel", async () => {
    const { run, disabled } = setupModules();
    const [reply] = await run("disable", { module: "music", channel: CATEGORY });
    expect(reply).toContain(`w <#${CATEGORY}>`);
    expect(disabled).toEqual([{ module: "music", channelId: CATEGORY }]);
    expect((await run("list")).join("\n")).toContain(`\`music\`: wyłączony w <#${CATEGORY}>`);
  });

  test("list shows every module and where it is off", async () => {
    const { run } = setupModules();
    await run("disable", { module: "music" });
    await run("disable", { module: "welcome", channel: CHANNEL });
    const [reply] = await run("list");
    expect(reply).toBe(
      [
        "`general`: włączony",
        "`settings`: włączony",
        "`status`: włączony",
        "`music`: wyłączony na serwerze",
        `\`welcome\`: wyłączony w <#${CHANNEL}>`,
      ].join("\n"),
    );
  });

  test("the prefix form parses `!modules disable music #channel`", () => {
    const { command } = setupModules();
    expect(parsePrefixArgs(command, `disable music <#${CHANNEL}>`)).toEqual({
      ok: true,
      subcommand: "disable",
      args: { module: "music", channel: CHANNEL },
    });
  });
});

function memoryZones() {
  const zones = new Map<string, string>();
  return {
    zones,
    get: async (guildId: string) => zones.get(guildId) ?? null,
    set: async (guildId: string, zone: string) => void zones.set(guildId, zone),
    // Stands in for Postgres, which has dropped this deprecated alias.
    isKnown: async (zone: string) => zone !== "US/Pacific-New",
    reset: async (guildId: string) => void zones.delete(guildId),
  };
}

describe("settings module: /timezone", () => {
  const GUILD = "100000000000000001";
  const MANAGE = 1n << 5n;

  function setupZones() {
    const timeZones = memoryZones();
    const registry = createRegistry([
      createSettingsModule({
        prefixes: { get: async () => null, set: async () => {}, reset: async () => {} },
        defaultPrefix: "!",
        timeZones,
        defaultTimeZone: "Europe/Warsaw",
        modules: {
          moduleNames: () => [],
          list: async () => [],
          disable: async () => {},
          enable: async () => false,
        },
        channels: { belongsTo: async () => true, isThread: async () => false },
        languages: memoryLanguages(),
        now: () => new Date("2026-07-01T12:00:00Z"),
      }),
    ]);
    const run = async (
      subcommand: string,
      args: Record<string, unknown> = {},
      permissions = MANAGE,
    ) => {
      const command = registry.find("timezone");
      if (!command) throw new Error("timezone command missing");
      const ctx = createFakeContext({
        args,
        subcommand,
        guildId: GUILD,
        memberPermissions: permissions,
      });
      await executeCommand(command, ctx, silentLogger);
      return ctx.replies.map((reply) => replyText(reply));
    };
    return { run, zones: timeZones.zones };
  }

  test("show gives the default with its clock until a zone is set", async () => {
    const { run } = setupZones();
    expect(await run("show")).toEqual([
      "Strefa czasowa serwera: `Europe/Warsaw` (teraz 14:00) (domyślna).",
    ]);
  });

  test("set stores the canonical name, whatever its case", async () => {
    const { run, zones } = setupZones();
    expect(await run("set", { zone: "america/new_york" })).toEqual([
      "Strefa czasowa serwera to teraz `America/New_York` (teraz 08:00). Zaplanowane wiadomości i piosenki idą według niej.",
    ]);
    expect(zones.get(GUILD)).toBe("America/New_York");
    expect(await run("show")).toEqual([
      "Strefa czasowa serwera: `America/New_York` (teraz 08:00).",
    ]);
  });

  test("set refuses offsets and unknown names and stores nothing", async () => {
    const { run, zones } = setupZones();
    for (const zone of ["+02:00", "CEST", "Mars/Olympus", "US/Pacific-New"]) {
      expect((await run("set", { zone }))[0]).toStartWith(`Nie znam strefy \`${zone}\`.`);
    }
    expect(zones.size).toBe(0);
  });

  test("an unknown zone is echoed cut on code points, not in the middle of an emoji", async () => {
    const { run } = setupZones();
    const [reply] = await run("set", { zone: "😀".repeat(70) });
    expect(reply).toStartWith(`Nie znam strefy \`${"😀".repeat(64)}\`.`);
  });

  test("reset goes back to the default", async () => {
    const { run, zones } = setupZones();
    await run("set", { zone: "Asia/Tokyo" });
    expect(await run("reset")).toEqual([
      "Przywrócono domyślną strefę `Europe/Warsaw` (teraz 14:00).",
    ]);
    expect(zones.size).toBe(0);
  });

  test("needs Manage Server", async () => {
    const { run, zones } = setupZones();
    expect(await run("set", { zone: "Asia/Tokyo" }, 0n)).toEqual([
      "Nie masz uprawnień do tej komendy.",
    ]);
    expect(zones.size).toBe(0);
  });
});

describe("settings module: /language", () => {
  const GUILD = "100000000000000001";
  const USER = "200000000000000002";

  function setupLanguage() {
    const languages = memoryLanguages();
    const registry = createRegistry([
      createSettingsModule({
        prefixes: { get: async () => null, set: async () => {}, reset: async () => {} },
        defaultPrefix: "!",
        timeZones: memoryZones(),
        defaultTimeZone: "Europe/Warsaw",
        modules: noModules,
        channels: channelsOf([]),
        languages,
      }),
    ]);
    const command = registry.find("language");
    if (!command) throw new Error("language command missing");
    const run = async (
      args: Record<string, unknown>,
      options: { guildId?: string | null; memberPermissions?: bigint; locale?: Locale } = {},
    ) => {
      const ctx = createFakeContext({ args, guildId: GUILD, ...options });
      await executeCommand(command, ctx, silentLogger);
      return replyText(ctx.replies[0]);
    };
    return { run, languages, command };
  }

  test("on a server it sets the server's language and answers in the new one", async () => {
    const { run, languages } = setupLanguage();
    expect(await run({ language: "en" }, { memberPermissions: MANAGE_GUILD })).toBe(
      "From now on I speak English on this server.",
    );
    expect(languages.guilds.get(GUILD)).toBe("en");
    expect(await run({ language: "de" }, { memberPermissions: MANAGE_GUILD, locale: "en" })).toBe(
      "Ab jetzt spreche ich auf diesem Server Deutsch.",
    );
  });

  test("changing the server's language needs Manage Server; showing it does not", async () => {
    const { run, languages } = setupLanguage();
    expect(await run({ language: "en" }, { memberPermissions: 0n, locale: "en" })).toBe(
      "Only members with Manage Server can change the server's language.",
    );
    expect(languages.guilds.size).toBe(0);
    expect(await run({}, { memberPermissions: 0n })).toBe(
      "Język bota na tym serwerze: **Polski** (domyślny).",
    );
  });

  test("reset goes back to Polish and show reports a chosen language", async () => {
    const { run, languages } = setupLanguage();
    languages.guilds.set(GUILD, "de");
    expect(await run({}, { locale: "de" })).toBe(
      "Sprache des Bots auf diesem Server: **Deutsch**.",
    );
    expect(
      await run({ language: "reset" }, { memberPermissions: MANAGE_GUILD, locale: "de" }),
    ).toBe("Przywrócono domyślny język serwera: polski.");
    expect(languages.guilds.size).toBe(0);
  });

  test("in the DM with the bot it sets the member's own language, no permission needed", async () => {
    const { run, languages } = setupLanguage();
    expect(await run({ language: "de" }, { guildId: null })).toBe(
      "Ab jetzt schreibe ich dir auf Deutsch.",
    );
    expect(languages.users.get(USER)).toBe("de");
    expect(languages.guilds.size).toBe(0);
    expect(await run({}, { guildId: null, locale: "de" })).toBe(
      "Ich schreibe dir auf **Deutsch**.",
    );
    expect(await run({ language: "reset" }, { guildId: null, locale: "en" })).toBe(
      "I forgot your choice. I'll use your Discord language, or Polish if I don't speak it.",
    );
    expect(languages.users.size).toBe(0);
  });

  test("the prefix form takes a language by code, name or alias in any language", () => {
    const { command } = setupLanguage();
    for (const [word, value] of [
      ["en", "en"],
      ["English", "en"],
      ["angielski", "en"],
      ["niemiecki", "de"],
      ["Deutsch", "de"],
      ["polnisch", "pl"],
      ["Standard", "reset"],
      ["domyślny", "reset"],
    ] as const) {
      expect(parsePrefixArgs(command, word)).toEqual({ ok: true, args: { language: value } });
    }
    expect(parsePrefixArgs(command, "")).toEqual({ ok: true, args: {} });
    const wrong = parsePrefixArgs(command, "klingon", "en");
    expect(wrong.ok ? "" : wrong.error).toBe("Argument `language`: allowed: pl, en, de, reset");
  });

  test("works in the DM with the bot but not in a group DM", () => {
    const { command } = setupLanguage();
    expect(command.contexts?.places).toEqual(["guild", "bot-dm"]);
  });
});

describe("settings module in other languages", () => {
  test("answers /prefix and its errors in the caller's language", async () => {
    const { run } = setup();
    expect(await run("set", { prefix: "?" }, MANAGE_GUILD, "en")).toEqual([
      "The prefix is now `?`.",
    ]);
    expect(await run("set", { prefix: "a b" }, MANAGE_GUILD, "de")).toEqual([
      "Das Präfix darf keine Leerzeichen oder unsichtbaren Zeichen enthalten.",
    ]);
    expect(await run("set", { prefix: "?" }, 0n, "en")).toEqual([
      "You don't have permission to use this command.",
    ]);
  });
});

test("every text of the catalog renders in every language", () => {
  for (const texts of Object.values(renderCatalog(t))) {
    for (const text of Object.values(texts)) expect(text.trim()).not.toBe("");
  }
});
