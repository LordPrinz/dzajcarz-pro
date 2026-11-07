import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  defineCommand,
  defineSubcommand,
  executeCommand,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext } from "@dzajcarz/core/testing";
import { createGeneralModule, type GeneralModuleDeps } from "./index.ts";

function setup(overrides: Partial<GeneralModuleDeps> = {}) {
  const module = createGeneralModule({
    commands: () => registry.summaries(),
    gatewayPing: () => 42.4,
    prefixFor: async () => "!",
    ...overrides,
  });
  const registry = createRegistry([
    module,
    {
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
    },
  ]);
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const command = registry.find(name);
    if (!command) throw new Error(`no command ${name}`);
    const ctx = createFakeContext({ args });
    await executeCommand(command, ctx, silentLogger);
    return ctx.replies;
  };
  return { run };
}

describe("general module", () => {
  test("ping reports the gateway latency", async () => {
    expect(await setup().run("ping")).toEqual(["Pong! 42 ms"]);
    expect(await setup({ gatewayPing: () => -1 }).run("ping")).toEqual(["Pong!"]);
  });

  test("help lists commands grouped by module with the guild prefix", async () => {
    const [reply] = await setup({ prefixFor: async () => "?" }).run("help");
    expect(reply).toMatchObject({ ephemeral: true });
    const embed = typeof reply === "object" ? reply.embeds?.[0] : undefined;
    expect(embed?.description).toContain("`?nazwa`");
    expect(embed?.fields?.map((f) => f.name)).toEqual(["general", "music"]);
    expect(embed?.fields?.[1]?.value).toBe("`play` Gra muzykę\n`queue` Kolejka");
  });

  test("help describes one command, found by alias", async () => {
    const [reply] = await setup().run("pomoc", { command: "P" });
    const embed = typeof reply === "object" ? reply.embeds?.[0] : undefined;
    expect(embed).toMatchObject({ title: "/play", fields: [{ name: "Aliasy", value: "`!p`" }] });
  });

  test("help lists the subcommands of a command with their usage", async () => {
    const [reply] = await setup({ prefixFor: async () => "?" }).run("help", { command: "queue" });
    const embed = typeof reply === "object" ? reply.embeds?.[0] : undefined;
    expect(embed?.fields).toEqual([
      {
        name: "Podkomendy",
        value: "`?queue add <song>` Dodaje utwór\n`?queue clear` Czyści kolejkę",
      },
    ]);
  });

  test("help says when a command does not exist", async () => {
    expect(await setup().run("help", { command: "nope" })).toEqual([
      { content: "Nie znam komendy `nope`.", ephemeral: true },
    ]);
  });
});

describe("general module contexts", () => {
  test("help and ping are available in DMs, private channels and for user installs", () => {
    const module = createGeneralModule({
      commands: () => [],
      gatewayPing: () => 0,
      prefixFor: async () => "!",
    });
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
      createGeneralModule({ commands: () => [], gatewayPing: () => 1, prefixFor: async () => "!" }),
    ]);
    const command = registry.find("ping");
    if (!command) throw new Error("no ping");
    const ctx = createFakeContext({ guildId: null });
    await executeCommand(command, ctx, silentLogger);
    expect(ctx.replies).toEqual(["Pong! 1 ms"]);
  });
});
