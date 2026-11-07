import { describe, expect, test } from "bun:test";
import { type AnyCommand, defineCommand, defineSubcommand } from "./command.ts";
import { defineEvent } from "./module.ts";
import { createRegistry } from "./registry.ts";

const command = (name: string, extra: Partial<AnyCommand> = {}): AnyCommand =>
  defineCommand({ name, description: `${name} command`, run: async () => {}, ...extra });

describe("createRegistry", () => {
  test("finds commands by name and alias, case-insensitively", () => {
    const play = command("play", { aliases: ["p"] });
    const registry = createRegistry([{ name: "music", commands: [play] }]);
    expect(registry.find("play")).toBe(play);
    expect(registry.find("P")).toBe(play);
    expect(registry.find("nope")).toBeUndefined();
    expect(registry.summaries()).toEqual([
      {
        name: "play",
        description: "play command",
        aliases: ["p"],
        module: "music",
        subcommands: [],
      },
    ]);
  });

  test("collects event handlers from every module", () => {
    const ready = defineEvent({ name: "log-ready", event: "clientReady", run: () => {} });
    const registry = createRegistry([{ name: "a", events: [ready] }, { name: "b" }]);
    expect(registry.events()).toEqual([{ module: "a", handler: ready }]);
  });

  test("knows which module owns a command", () => {
    const play = command("play");
    const ping = command("ping");
    const registry = createRegistry([
      { name: "music", commands: [play] },
      { name: "general", commands: [ping] },
    ]);
    expect(registry.moduleOf(play)).toBe("music");
    expect(registry.moduleOf(registry.find("ping") as AnyCommand)).toBe("general");
    expect(registry.moduleOf(command("other"))).toBeUndefined();
  });

  test("rejects a name or alias used twice, naming both modules", () => {
    expect(() =>
      createRegistry([
        { name: "music", commands: [command("play", { aliases: ["p"] })] },
        { name: "party", commands: [command("p")] },
      ]),
    ).toThrow(`Command name "p" from module "party" is already used by /play (module "music")`);
  });

  test("rejects a module registered twice", () => {
    expect(() => createRegistry([{ name: "a" }, { name: "a" }])).toThrow("registered twice");
  });

  test.each(["Play", "", "a".repeat(33), "with space"])("rejects command name %p", (name) => {
    expect(() => createRegistry([{ name: "m", commands: [command(name)] }])).toThrow(
      "Invalid name",
    );
  });

  test("accepts Polish letters in names", () => {
    expect(() =>
      createRegistry([{ name: "m", commands: [command("czy_wiedziałeś")] }]),
    ).not.toThrow();
  });

  test("rejects a description Discord would refuse", () => {
    expect(() =>
      createRegistry([{ name: "m", commands: [command("x", { description: "" })] }]),
    ).toThrow("Description");
  });

  test("rejects a required option after an optional one", () => {
    const bad = command("x", {
      options: {
        a: { type: "string", description: "a" },
        b: { type: "string", description: "b", required: true },
      },
    });
    expect(() => createRegistry([{ name: "m", commands: [bad] }])).toThrow(
      "comes after an optional one",
    );
  });

  test("allows rest only on the last string option", () => {
    const notLast = command("x", {
      options: {
        a: { type: "string", description: "a", rest: true },
        b: { type: "string", description: "b" },
      },
    });
    const notString = command("y", {
      options: { a: { type: "integer", description: "a", rest: true } },
    });
    expect(() => createRegistry([{ name: "m", commands: [notLast] }])).toThrow('"rest"');
    expect(() => createRegistry([{ name: "m", commands: [notString] }])).toThrow('"rest"');
  });
});

describe("subcommands", () => {
  const sub = (extra = {}) =>
    defineSubcommand({ description: "Sub", run: async () => {}, ...extra });
  const group = (subcommands: Record<string, ReturnType<typeof sub>>, extra = {}) =>
    defineCommand({ name: "prefix", description: "Prefix", subcommands, ...extra });
  const register = (c: AnyCommand) => () => createRegistry([{ name: "m", commands: [c] }]);

  test("accepts a command with subcommands and summarises them", () => {
    const prefix = group({
      set: sub({ options: { value: { type: "string", description: "v", required: true } } }),
      show: sub(),
    });
    const registry = createRegistry([{ name: "settings", commands: [prefix] }]);
    expect(registry.summaries()[0]?.subcommands).toEqual([
      { name: "set", description: "Sub", usage: "prefix set <value>" },
      { name: "show", description: "Sub", usage: "prefix show" },
    ]);
  });

  test("rejects a command with both run and subcommands", () => {
    const both = { ...group({ a: sub() }), run: async () => {} } as AnyCommand;
    expect(register(both)).toThrow('exactly one of "run" and "subcommands"');
  });

  test("rejects a command with neither run nor subcommands", () => {
    const neither = { name: "x", description: "X" } as AnyCommand;
    expect(register(neither)).toThrow('exactly one of "run" and "subcommands"');
  });

  test("rejects options next to subcommands", () => {
    const mixed = {
      ...group({ a: sub() }),
      options: { q: { type: "string", description: "q" } },
    } as AnyCommand;
    expect(register(mixed)).toThrow("options belong on them");
  });

  test("rejects an empty set, more than 25, and bad names or descriptions", () => {
    expect(register(group({}))).toThrow("1–25 subcommands");
    const many = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`s${i}`, sub()]));
    expect(register(group(many))).toThrow("1–25 subcommands");
    expect(register(group({ Bad: sub() }))).toThrow('Invalid name for subcommand "Bad"');
    expect(register(group({ a: sub({ description: "" }) }))).toThrow("Description");
  });

  test("applies the option rules to each subcommand", () => {
    const bad = sub({
      options: {
        a: { type: "string", description: "a" },
        b: { type: "string", description: "b", required: true },
      },
    });
    expect(register(group({ a: bad }))).toThrow('subcommand "a"');
  });
});

describe("option limits Discord checks at deploy time", () => {
  const withOption = (option: Record<string, unknown>) =>
    command("x", { options: { a: { description: "a", ...option } as never } });
  const reject = (option: Record<string, unknown>, message: string) =>
    expect(() => createRegistry([{ name: "m", commands: [withOption(option)] }])).toThrow(message);

  test("choices only on string and number options, 1–25 of them", () => {
    reject({ type: "boolean", choices: [{ name: "A", value: 1 }] }, "Choices are allowed only");
    reject({ type: "string", choices: [] }, "1–25 choices");
    reject(
      {
        type: "string",
        choices: Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, value: `${i}` })),
      },
      "1–25 choices",
    );
    reject({ type: "string", choices: [{ name: "x".repeat(101), value: "x" }] }, "1–100");
    reject({ type: "integer", choices: [{ name: "A", value: "a" }] }, "number value");
  });

  test("minValue / maxValue only on numbers, in order", () => {
    reject({ type: "string", minValue: 1 }, "allowed only on integer");
    reject({ type: "integer", minValue: 5, maxValue: 1 }, "greater than maxValue");
  });
});

describe("contexts", () => {
  const build = (extra: Partial<AnyCommand>) => () =>
    createRegistry([{ name: "m", commands: [command("c", extra)] }]);

  test("accepts places and installs that fit together", () => {
    expect(
      build({
        contexts: { places: ["guild", "bot-dm", "private-channel"], installs: ["guild", "user"] },
      }),
    ).not.toThrow();
    expect(build({ contexts: { places: ["guild", "bot-dm"], installs: ["guild"] } })).not.toThrow();
  });

  test("rejects empty lists and unknown values", () => {
    expect(build({ contexts: { places: [], installs: ["guild"] } })).toThrow("at least one place");
    expect(build({ contexts: { places: ["guild"], installs: [] } })).toThrow("at least one place");
    expect(build({ contexts: { places: ["moon" as never], installs: ["guild"] } })).toThrow(
      'unknown place "moon"',
    );
    expect(build({ contexts: { places: ["guild"], installs: ["robot" as never] } })).toThrow(
      'unknown install type "robot"',
    );
  });

  test("a private channel needs the user install", () => {
    expect(build({ contexts: { places: ["private-channel"], installs: ["guild"] } })).toThrow(
      'needs the "user" install',
    );
  });

  test("permissions cannot be combined with a place outside servers", () => {
    expect(
      build({ permissions: 8n, contexts: { places: ["guild", "bot-dm"], installs: ["guild"] } }),
    ).toThrow("guild-only");
    expect(build({ permissions: 8n })).not.toThrow();
  });

  test("permissions cannot be combined with the user install", () => {
    expect(
      build({ permissions: 8n, contexts: { places: ["guild"], installs: ["guild", "user"] } }),
    ).toThrow("user install");
  });

  test("a subcommand with permissions cannot be offered to the user install", () => {
    const withSub = (installs: readonly ("guild" | "user")[]) => () =>
      createRegistry([
        {
          name: "m",
          commands: [
            defineCommand({
              name: "g",
              description: "g",
              contexts: { places: ["guild"], installs },
              subcommands: {
                a: defineSubcommand({ description: "a", permissions: 8n, run: async () => {} }),
              },
            }),
          ],
        },
      ]);
    expect(withSub(["guild", "user"])).toThrow("user install");
    expect(withSub(["guild"])).not.toThrow();
  });

  test("rejects duplicate places and installs", () => {
    expect(build({ contexts: { places: ["guild", "guild"], installs: ["guild"] } })).toThrow(
      "duplicate place",
    );
    expect(build({ contexts: { places: ["guild"], installs: ["user", "user"] } })).toThrow(
      "duplicate install",
    );
  });
});
