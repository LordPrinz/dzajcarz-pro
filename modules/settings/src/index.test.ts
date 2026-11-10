import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  executeCommand,
  matchPrefix,
  parsePrefixArgs,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext, replyText } from "@dzajcarz/core/testing";
import {
  createSettingsModule,
  type DisabledModule,
  type GuildChannels,
  type ModuleToggles,
  type PrefixSettings,
} from "./index.ts";

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
      modules: noModules,
      channels: channelsOf([]),
    }),
  ]);
  const command = registry.find("prefix");
  if (!command) throw new Error("prefix command missing");

  const run = async (
    subcommand: string,
    args: Record<string, unknown> = {},
    memberPermissions: bigint = MANAGE_GUILD,
  ) => {
    const ctx = createFakeContext({ args, subcommand, memberPermissions });
    await executeCommand(command, ctx, silentLogger);
    return ctx.replies.map((r) => replyText(r));
  };
  return { run, store, command };
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
        modules,
        channels: channelsOf([CHANNEL, THREAD], threads),
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
        `\`welcome\`: wyłączony na kanałach <#${CHANNEL}>`,
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
