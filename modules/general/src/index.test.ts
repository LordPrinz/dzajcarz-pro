import { describe, expect, test } from "bun:test";
import {
  type BotModule,
  type CommandRegistry,
  createRegistry,
  defineCommand,
  defineSubcommand,
  executeCommand,
  type Reply,
  silentLogger,
} from "@dzajcarz/core";
import { type ClickOptions, clickComponent, createFakeContext } from "@dzajcarz/core/testing";
import { createGeneralModule, type GeneralModuleDeps } from "./index.ts";

const BAN = 1n << 2n;
const ADMIN = 1n << 3n;
const MANAGE = 1n << 5n;
const LINKS = { guild: "https://example.test/guild", user: "https://example.test/user" };

function baseDeps(): Omit<GeneralModuleDeps, "commands"> {
  return {
    gatewayPing: () => 42.4,
    prefixFor: async () => "!",
    installLinks: LINKS,
    botInGuild: () => true,
    moduleEnabled: async () => true,
  };
}

type FakeOptions = Parameters<typeof createFakeContext>[0];

/** A registry with the general module (reading its own summaries) next to the given modules. */
function registryWith(deps: Partial<GeneralModuleDeps>, ...others: BotModule[]) {
  const registry: CommandRegistry = createRegistry([
    createGeneralModule({ ...baseDeps(), commands: () => registry.summaries(), ...deps }),
    ...others,
  ]);
  return registry;
}

const MUSIC: BotModule = {
  name: "music",
  commands: [
    { name: "play", description: "Gra muzykę", aliases: ["p"], run: async () => {} },
    defineCommand({
      name: "queue",
      description: "Kolejka",
      subcommands: {
        add: defineSubcommand({
          description: "Dodaje utwór",
          options: { song: { type: "string", description: "Utwór", required: true } },
          run: async () => {},
        }),
        clear: defineSubcommand({ description: "Czyści kolejkę", run: async () => {} }),
      },
    }),
  ],
};

const MODERATION: BotModule = {
  name: "moderation",
  commands: [
    defineCommand({ name: "ban", description: "Banuje", permissions: BAN, run: async () => {} }),
    defineCommand({
      name: "mod",
      description: "Moderacja",
      subcommands: {
        warn: defineSubcommand({ description: "Ostrzega", run: async () => {} }),
        purge: defineSubcommand({
          description: "Czyści",
          permissions: MANAGE,
          run: async () => {},
        }),
      },
    }),
  ],
};

function setup(overrides: Partial<GeneralModuleDeps> = {}) {
  const registry = registryWith(overrides, MUSIC, MODERATION);
  const run = async (
    name: string,
    args: Record<string, unknown> = {},
    options: FakeOptions = {},
  ) => {
    const command = registry.find(name);
    if (!command) throw new Error(`no command ${name}`);
    const ctx = createFakeContext({ ...options, args });
    await executeCommand(command, ctx, silentLogger);
    return ctx.replies;
  };
  /** Clicks a component of an earlier reply; `options` describe the clicking member. */
  const click = (
    customId: string,
    values: string[] = [],
    options: Omit<ClickOptions, "registry" | "customId" | "values"> = {},
  ) => clickComponent({ registry, customId, values, ...options });
  return { run, click, registry };
}

type Obj = Exclude<Reply, string>;
const obj = (reply: Reply | undefined): Obj => {
  if (typeof reply !== "object") throw new Error("expected an object reply");
  return reply;
};
const embed = (reply: Reply | undefined) => obj(reply).embeds?.[0];
const flat = (reply: Reply | undefined) => (obj(reply).components ?? []).flat();
const selectOf = (reply: Reply | undefined) => {
  const select = flat(reply).find((c) => c.type === "select");
  if (select?.type !== "select") throw new Error("no select");
  return select;
};
const buttonNamed = (reply: Reply | undefined, label: string) => {
  const found = flat(reply).find((c) => c.type === "button" && c.label === label);
  if (found?.type !== "button") throw new Error(`no button ${label}`);
  return found;
};
const categories = (reply: Reply | undefined) => selectOf(reply).options.map((o) => o.value);

describe("general module", () => {
  test("ping reports the gateway latency", async () => {
    expect(await setup().run("ping")).toEqual(["Pong! 42 ms"]);
    expect(await setup({ gatewayPing: () => -1 }).run("ping")).toEqual(["Pong!"]);
  });

  test("help describes one command, found by alias, with its usage", async () => {
    const [reply] = await setup().run("pomoc", { command: "P" });
    expect(embed(reply)).toMatchObject({
      title: "/play",
      fields: [
        { name: "Użycie", value: "`/play` · `!play`" },
        { name: "Aliasy", value: "`!p`" },
      ],
    });
  });

  test("help lists the subcommands of a command with slash and prefix usage", async () => {
    const [reply] = await setup({ prefixFor: async () => "?" }).run("help", { command: "queue" });
    expect(embed(reply)?.fields).toEqual([
      {
        name: "Podkomendy",
        value:
          "`/queue add <song>` · `?queue add <song>` Dodaje utwór\n`/queue clear` · `?queue clear` Czyści kolejkę",
      },
    ]);
  });

  test("help says when a command does not exist", async () => {
    expect(await setup().run("help", { command: "nope" })).toEqual([
      { content: "Nie znam komendy `nope`.", ephemeral: true },
    ]);
  });

  test("the detail view hides subcommands the member may not run", async () => {
    const [reply] = await setup().run("help", { command: "mod" });
    expect(embed(reply)?.fields?.[0]?.value).toBe("`/mod warn` · `!mod warn` Ostrzega");
  });
});

describe("interactive help", () => {
  test("the start page lists categories with counts, a select and the install links", async () => {
    const [reply] = await setup().run("help");
    expect(obj(reply).ephemeral).toBe(true);
    expect(embed(reply)?.fields).toEqual([
      { name: "general", value: "2 komendy", inline: true },
      { name: "music", value: "3 komendy", inline: true },
      { name: "moderation", value: "1 komenda", inline: true },
    ]);
    expect(selectOf(reply).options.map((o) => [o.value, o.description])).toEqual([
      ["general", "2 komendy"],
      ["music", "3 komendy"],
      ["moderation", "1 komenda"],
    ]);
    expect(flat(reply).filter((c) => c.type === "link")).toEqual([
      { type: "link", label: "Dodaj na serwer", url: LINKS.guild },
      { type: "link", label: "Dodaj na konto", url: LINKS.user },
    ]);
  });

  test("the prefix form replies with the same components", async () => {
    const registry = registryWith({}, MUSIC);
    const help = registry.find("help");
    if (!help) throw new Error("no help");
    const ctx = createFakeContext({ invocation: "prefix" });
    await executeCommand(help, ctx, silentLogger);
    expect(categories(ctx.replies[0])).toEqual(["general", "music"]);
  });

  test("choosing a module shows its commands, each subcommand as its own entry", async () => {
    const { run, click } = setup({ prefixFor: async () => "?" });
    const [start] = await run("help");
    const page = (await click(selectOf(start).customId, ["music"])).updates[0];
    expect(embed(page)?.title).toBe("Kategoria: music");
    expect(embed(page)?.description).toBe(
      [
        "`/play` · `?play`\nGra muzykę",
        "`/queue add <song>` · `?queue add <song>`\nDodaje utwór",
        "`/queue clear` · `?queue clear`\nCzyści kolejkę",
      ].join("\n\n"),
    );
    // The select stays on the chosen module so the user can switch.
    expect(selectOf(page).options.find((o) => o.default)?.value).toBe("music");
    expect(buttonNamed(page, "Strona 1/1").disabled).toBe(true);
    expect(buttonNamed(page, "◀").disabled).toBe(true);
    expect(buttonNamed(page, "▶").disabled).toBe(true);
  });

  test("the select switches from one module to another", async () => {
    const { run, click } = setup();
    const [start] = await run("help");
    const music = (await click(selectOf(start).customId, ["music"])).updates[0];
    const general = (await click(selectOf(music).customId, ["general"])).updates[0];
    expect(embed(general)?.title).toBe("Kategoria: general");
    expect(embed(general)?.description).toContain("`/ping`");
    expect(selectOf(general).options.find((o) => o.default)?.value).toBe("general");
  });

  test("pages hold 6 entries; the arrows move and stop at the ends", async () => {
    const many = defineCommand({
      name: "many",
      description: "Dużo",
      subcommands: Object.fromEntries(
        Array.from({ length: 13 }, (_, i) => [
          `s${i + 1}`,
          defineSubcommand({ description: `Sub ${i + 1}`, run: async () => {} }),
        ]),
      ),
    });
    const registry = registryWith({}, { name: "big", commands: [many] });
    const help = registry.find("help");
    if (!help) throw new Error("no help");
    const ctx = createFakeContext();
    await executeCommand(help, ctx, silentLogger);
    const click = (customId: string, values: string[] = []) =>
      clickComponent({ registry, customId, values });

    const first = (await click(selectOf(ctx.replies[0]).customId, ["big"])).updates[0];
    expect(embed(first)?.description?.split("\n\n")).toHaveLength(6);
    expect(buttonNamed(first, "Strona 1/3").disabled).toBe(true);
    expect(buttonNamed(first, "◀").disabled).toBe(true);
    const second = (await click(buttonNamed(first, "▶").customId)).updates[0];
    expect(embed(second)?.description).toStartWith("`/many s7`");
    const third = (await click(buttonNamed(second, "▶").customId)).updates[0];
    expect(embed(third)?.description?.split("\n\n")).toHaveLength(1);
    expect(buttonNamed(third, "▶").disabled).toBe(true);
    const back = (await click(buttonNamed(third, "◀").customId)).updates[0];
    expect(buttonNamed(back, "Strona 2/3").disabled).toBe(true);
    expect(buttonNamed(back, "▶").disabled).toBe(false);
  });

  test("the home button returns to the start page", async () => {
    const { run, click } = setup();
    const [start] = await run("help");
    const page = (await click(selectOf(start).customId, ["music"])).updates[0];
    const home = (await click(buttonNamed(page, "Strona główna").customId)).updates[0];
    expect(embed(home)?.title).toBe("Komendy Dżajcarza");
    expect(categories(home)).toEqual(["general", "music", "moderation"]);
  });

  test("another member cannot use the menu", async () => {
    const { run, click } = setup();
    const [start] = await run("help");
    const clicked = await click(selectOf(start).customId, ["music"], {
      userId: "999999999999999999",
    });
    expect(clicked.updates).toEqual([]);
    expect(clicked.replies).toEqual([{ content: "To nie Twoje menu.", ephemeral: true }]);
  });

  describe("filtering", () => {
    /** The text of a module page, opened by a member with the given permissions. */
    async function pageText(module: string, memberPermissions: bigint): Promise<string> {
      const s = setup();
      const [start] = await s.run("help", {}, { memberPermissions });
      const clicked = await s.click(selectOf(start).customId, [module], { memberPermissions });
      return embed(clicked.updates[0])?.description ?? "";
    }

    test("hides commands and subcommands the member lacks permissions for", async () => {
      const text = await pageText("moderation", 0n);
      expect(text).toContain("/mod warn");
      expect(text).not.toContain("/mod purge");
      expect(text).not.toContain("/ban");
      const withBan = await pageText("moderation", BAN | MANAGE);
      expect(withBan).toContain("/ban");
      expect(withBan).toContain("/mod purge");
    });

    test("an administrator sees everything", async () => {
      const text = await pageText("moderation", ADMIN);
      expect(text).toContain("/ban");
      expect(text).toContain("/mod purge");
    });

    test("the detail view hides a command the member may not run", async () => {
      const s = setup();
      expect((await s.run("help", { command: "ban" }))[0]).toEqual({
        content: "Nie znam komendy `ban`.",
        ephemeral: true,
      });
      const allowed = await s.run("help", { command: "ban" }, { memberPermissions: BAN });
      expect(embed(allowed[0])).toMatchObject({ title: "/ban" });
    });

    test("drops a category with nothing left in it", async () => {
      const secret = defineCommand({
        name: "secret",
        description: "Tajne",
        permissions: BAN,
        run: async () => {},
      });
      const registry = registryWith({}, { name: "hidden", commands: [secret] });
      const help = registry.find("help");
      if (!help) throw new Error("no help");
      const ctx = createFakeContext();
      await executeCommand(help, ctx, silentLogger);
      expect(categories(ctx.replies[0])).toEqual(["general"]);
    });

    test("hides modules switched off in this channel", async () => {
      const asked: string[][] = [];
      const s = setup({
        moduleEnabled: async (guildId, channelId, module) => {
          asked.push([guildId, channelId, module]);
          return module !== "music";
        },
      });
      const [start] = await s.run("help");
      expect(categories(start)).toEqual(["general", "moderation"]);
      expect(asked).toContainEqual(["100000000000000001", "300000000000000003", "music"]);
      expect((await s.run("help", { command: "play" }))[0]).toEqual({
        content: "Nie znam komendy `play`.",
        ephemeral: true,
      });
    });

    test("a module switched off after the menu opened disappears on the next click", async () => {
      let musicOn = true;
      const s = setup({ moduleEnabled: async (_g, _c, module) => module !== "music" || musicOn });
      const [start] = await s.run("help");
      musicOn = false;
      const clicked = await s.click(selectOf(start).customId, ["music"]);
      expect(embed(clicked.updates[0])?.description).toBe(
        "Brak dostępnych komend w tej kategorii.",
      );
    });

    test("in a DM only commands that allow DMs are listed and the toggles are not read", async () => {
      let toggleReads = 0;
      const s = setup({
        moduleEnabled: async () => {
          toggleReads++;
          return true;
        },
      });
      const [start] = await s.run("help", {}, { guildId: null });
      expect(categories(start)).toEqual(["general"]);
      expect(embed(start)?.fields).toEqual([{ name: "general", value: "2 komendy", inline: true }]);
      expect(toggleReads).toBe(0);
      expect((await s.run("help", { command: "play" }, { guildId: null }))[0]).toMatchObject({
        content: "Nie znam komendy `play`.",
      });
    });

    test("in a server without the bot (user install) it shows slash syntax and skips the lookups", async () => {
      let toggleReads = 0;
      let prefixReads = 0;
      const both = defineCommand({
        name: "both",
        description: "Obie instalacje",
        contexts: { places: ["guild"], installs: ["guild", "user"] },
        run: async () => {},
      });
      const guildOnly = defineCommand({
        name: "guildonly",
        description: "G",
        run: async () => {},
      });
      const registry = registryWith(
        {
          botInGuild: () => false,
          prefixFor: async () => {
            prefixReads++;
            return "!";
          },
          moduleEnabled: async () => {
            toggleReads++;
            return true;
          },
        },
        { name: "extra", commands: [both, guildOnly] },
      );
      const help = registry.find("help");
      if (!help) throw new Error("no help");
      const ctx = createFakeContext();
      await executeCommand(help, ctx, silentLogger);
      const reply = ctx.replies[0];
      expect(categories(reply)).toEqual(["general", "extra"]);
      expect(embed(reply)?.description).toContain("`/nazwa`");
      expect(embed(reply)?.fields?.find((f) => f.name === "extra")?.value).toBe("1 komenda");
      const clicked = await clickComponent({
        registry,
        customId: selectOf(reply).customId,
        values: ["extra"],
      });
      expect(embed(clicked.updates[0])?.description).toBe("`/both`\nObie instalacje");
      expect(toggleReads).toBe(0);
      expect(prefixReads).toBe(0);
    });
  });

  test("a long module list still fits one select (the fake validates every reply)", async () => {
    const modules = Array.from({ length: 12 }, (_, i) => ({
      name: `module${i}`,
      commands: [defineCommand({ name: `cmd${i}`, description: "Opis", run: async () => {} })],
    }));
    const registry = registryWith({}, ...modules);
    const help = registry.find("help");
    if (!help) throw new Error("no help");
    const ctx = createFakeContext();
    await executeCommand(help, ctx, silentLogger);
    expect(selectOf(ctx.replies[0]).options).toHaveLength(13);
  });
});

describe("general module contexts", () => {
  test("help and ping are available in DMs, private channels and for user installs", () => {
    const module = createGeneralModule({ ...baseDeps(), commands: () => [] });
    for (const name of ["ping", "help"]) {
      const command = module.commands?.find((c) => c.name === name);
      expect(command?.contexts).toEqual({
        places: ["guild", "bot-dm", "private-channel"],
        installs: ["guild", "user"],
      });
    }
  });

  test("ping runs in a DM", async () => {
    const registry = createRegistry([
      createGeneralModule({ ...baseDeps(), gatewayPing: () => 1, commands: () => [] }),
    ]);
    const command = registry.find("ping");
    if (!command) throw new Error("no ping");
    const ctx = createFakeContext({ guildId: null });
    await executeCommand(command, ctx, silentLogger);
    expect(ctx.replies).toEqual(["Pong! 1 ms"]);
  });
});
