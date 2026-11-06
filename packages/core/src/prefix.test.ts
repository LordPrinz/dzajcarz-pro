import { describe, expect, test } from "bun:test";
import { defineCommand } from "./command.ts";
import { matchPrefix, parsePrefixArgs, tokenize, usage } from "./prefix.ts";

const noop = async () => {};

describe("matchPrefix", () => {
  test("splits the command name from the rest", () => {
    expect(matchPrefix("!Play  never gonna", "!")).toEqual({ name: "play", rest: "never gonna" });
    expect(matchPrefix("dz ping", "dz")).toEqual({ name: "ping", rest: "" });
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
