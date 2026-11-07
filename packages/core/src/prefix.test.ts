import { describe, expect, test } from "bun:test";
import { defineCommand, defineSubcommand } from "./command.ts";
import { matchPrefix, parsePrefixArgs, tokenize, usage, usageLine } from "./prefix.ts";

const noop = async () => {};

describe("matchPrefix", () => {
  test("splits the command name from the rest", () => {
    expect(matchPrefix("!Play  never gonna", "!")).toEqual({ name: "play", rest: "never gonna" });
    expect(matchPrefix("dz ping", "dz")).toEqual({ name: "ping", rest: "" });
  });

  test("matches the prefix regardless of case", () => {
    expect(matchPrefix("Dz ping", "dz")).toEqual({ name: "ping", rest: "" });
    expect(matchPrefix("DZPING", "dz")).toEqual({ name: "ping", rest: "" });
    expect(matchPrefix("dz ping", "DZ")).toEqual({ name: "ping", rest: "" });
    expect(matchPrefix("dx ping", "dz")).toBeNull();
  });

  test("ignores messages without the prefix or without a command", () => {
    expect(matchPrefix("hello", "!")).toBeNull();
    expect(matchPrefix("!", "!")).toBeNull();
    expect(matchPrefix("!   ", "!")).toBeNull();
    expect(matchPrefix("!ping", "")).toBeNull();
  });
});

describe("tokenize", () => {
  test("keeps quoted text together and records offsets", () => {
    expect(tokenize(`a  "b c" d`)).toEqual([
      { value: "a", start: 0 },
      { value: "b c", start: 3 },
      { value: "d", start: 9 },
    ]);
  });
});

describe("parsePrefixArgs", () => {
  const play = defineCommand({
    name: "play",
    description: "Play",
    options: {
      volume: {
        type: "integer",
        description: "Volume",
        required: true,
        minValue: 1,
        maxValue: 100,
      },
      query: { type: "string", description: "Query", rest: true },
    },
    run: noop,
  });

  test("maps positional arguments and passes the raw rest of the line", () => {
    expect(parsePrefixArgs(play, `50 never  "gonna" give`)).toEqual({
      ok: true,
      args: { volume: 50, query: `never  "gonna" give` },
    });
  });

  test("leaves a missing optional argument out", () => {
    expect(parsePrefixArgs(play, "10")).toEqual({ ok: true, args: { volume: 10 } });
  });

  test("reports a missing required argument with the usage line", () => {
    const result = parsePrefixArgs(play, "");
    expect(result).toEqual({
      ok: false,
      error: "Brakuje argumentu `volume`. Użycie: `play <volume> [query...]`",
    });
  });

  test.each([
    ["abc", "liczba całkowita"],
    ["1.5", "liczba całkowita"],
    ["0", "najmniej 1"],
    ["101", "najwyżej 100"],
  ])("rejects integer %p", (raw, message) => {
    const result = parsePrefixArgs(play, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });

  test("rejects extra arguments when no option takes the rest", () => {
    const ping = defineCommand({ name: "ping", description: "Ping", run: noop });
    expect(parsePrefixArgs(ping, "")).toEqual({ ok: true, args: {} });
    expect(parsePrefixArgs(ping, "x").ok).toBe(false);
  });

  test("accepts mentions and raw ids for user, channel and role", () => {
    const command = defineCommand({
      name: "x",
      description: "X",
      options: {
        user: { type: "user", description: "U", required: true },
        channel: { type: "channel", description: "C", required: true },
        role: { type: "role", description: "R", required: true },
      },
      run: noop,
    });
    const id = "123456789012345678";
    expect(parsePrefixArgs(command, `<@!${id}> <#${id}> <@&${id}>`)).toEqual({
      ok: true,
      args: { user: id, channel: id, role: id },
    });
    expect(parsePrefixArgs(command, `${id} ${id} ${id}`).ok).toBe(true);
    expect(parsePrefixArgs(command, `<#${id}> <#${id}> <@&${id}>`).ok).toBe(false);
  });

  test("parses booleans in Polish and English, and matches choices by name or value", () => {
    const command = defineCommand({
      name: "loop",
      description: "Loop",
      options: {
        mode: {
          type: "string",
          description: "Mode",
          required: true,
          choices: [
            { name: "Track", value: "track" },
            { name: "Queue", value: "queue" },
          ],
        },
        on: { type: "boolean", description: "On" },
      },
      run: noop,
    });
    expect(parsePrefixArgs(command, "QUEUE tak")).toEqual({
      ok: true,
      args: { mode: "queue", on: true },
    });
    expect(parsePrefixArgs(command, "track off")).toEqual({
      ok: true,
      args: { mode: "track", on: false },
    });
    expect(parsePrefixArgs(command, "song").ok).toBe(false);
    expect(parsePrefixArgs(command, "track maybe").ok).toBe(false);
  });

  test("usage marks required, optional and rest options", () => {
    expect(usage(play)).toBe("Użycie: `play <volume> [query...]`");
  });
});

describe("number parsing", () => {
  const volume = defineCommand({
    name: "volume",
    description: "Volume",
    options: {
      level: {
        type: "integer",
        description: "Level",
        required: true,
        choices: [
          { name: "cicho", value: 20 },
          { name: "głośno", value: 100 },
        ],
      },
    },
    run: noop,
  });
  const ratio = defineCommand({
    name: "ratio",
    description: "Ratio",
    options: { value: { type: "number", description: "Value", required: true } },
    run: noop,
  });

  test.each(['""', "0x1f", "1e3", "Infinity"])("rejects %p", (raw) => {
    expect(parsePrefixArgs(ratio, raw).ok).toBe(false);
  });

  test("accepts a decimal comma", () => {
    expect(parsePrefixArgs(ratio, "1,5")).toEqual({ ok: true, args: { value: 1.5 } });
  });

  test("picks a numeric choice by name or by value", () => {
    expect(parsePrefixArgs(volume, "Głośno")).toEqual({ ok: true, args: { level: 100 } });
    expect(parsePrefixArgs(volume, "20")).toEqual({ ok: true, args: { level: 20 } });
    expect(parsePrefixArgs(volume, "50").ok).toBe(false);
  });
});

describe("parsePrefixArgs with subcommands", () => {
  const prefix = defineCommand({
    name: "prefix",
    description: "Prefix",
    subcommands: {
      set: defineSubcommand({
        description: "Set",
        options: { value: { type: "string", description: "Value", required: true, rest: true } },
        run: noop,
      }),
      reset: defineSubcommand({ description: "Reset", run: noop }),
      show: defineSubcommand({ description: "Show", run: noop }),
    },
  });

  test("the first word picks the subcommand, the rest is parsed against its options", () => {
    expect(parsePrefixArgs(prefix, "set  ?? now")).toEqual({
      ok: true,
      subcommand: "set",
      args: { value: "?? now" },
    });
    expect(parsePrefixArgs(prefix, "SHOW")).toEqual({ ok: true, subcommand: "show", args: {} });
  });

  test("a missing subcommand lists the valid ones", () => {
    expect(parsePrefixArgs(prefix, "")).toEqual({
      ok: false,
      error: "Podaj podkomendę. Użycie: `prefix set|reset|show`",
    });
  });

  test("an unknown subcommand lists the valid ones and cannot inject markdown", () => {
    expect(parsePrefixArgs(prefix, "`wipe`")).toEqual({
      ok: false,
      error: "Nieznana podkomenda `wipe`. Użycie: `prefix set|reset|show`",
    });
    expect(parsePrefixArgs(prefix, "constructor")).toMatchObject({ ok: false });
  });

  test("an unknown subcommand is echoed at most 32 characters long", () => {
    const result = parsePrefixArgs(prefix, "x".repeat(500));
    expect(result).toEqual({
      ok: false,
      error: `Nieznana podkomenda \`${"x".repeat(32)}\`. Użycie: \`prefix set|reset|show\``,
    });
  });

  test("argument errors name the subcommand in the usage line", () => {
    expect(parsePrefixArgs(prefix, "set")).toEqual({
      ok: false,
      error: "Brakuje argumentu `value`. Użycie: `prefix set <value...>`",
    });
    expect(parsePrefixArgs(prefix, "show now")).toEqual({
      ok: false,
      error: "Za dużo argumentów. Użycie: `prefix show`",
    });
  });
});

describe("prefixOnly options", () => {
  const command = defineCommand({
    name: "greet",
    description: "d",
    subcommands: {
      set: defineSubcommand({
        description: "d",
        options: {
          text: { type: "string", description: "t", required: true, prefixOnly: true },
          tag: { type: "string", description: "t" },
        },
        run: async (ctx) => {
          // A prefix-only option is never guaranteed: a slash invocation does not carry it.
          // @ts-expect-error `text` may be undefined, so it is not a plain string
          const text: string = ctx.args.text;
          void text;
        },
      }),
    },
  });

  test("the slash usage leaves them out, the prefix usage keeps them", () => {
    expect(usageLine(command, "set")).toBe("greet set <text> [tag]");
    expect(usageLine(command, "set", "slash")).toBe("greet set [tag]");
  });
});
