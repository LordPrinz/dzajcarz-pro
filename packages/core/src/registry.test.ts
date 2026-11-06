import { describe, expect, test } from "bun:test";
import { type AnyCommand, defineCommand } from "./command.ts";
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
      { name: "play", description: "play command", aliases: ["p"], module: "music" },
    ]);
  });

  test("collects event handlers from every module", () => {
    const ready = defineEvent({ name: "log-ready", event: "clientReady", run: () => {} });
    const registry = createRegistry([{ name: "a", events: [ready] }, { name: "b" }]);
    expect(registry.events()).toEqual([ready]);
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
