import { describe, expect, test } from "bun:test";
import { COMMANDS, GuildSummary, isCommandName } from "./commands.ts";
import { CommandEnvelope, EventEnvelope, ReplyEnvelope } from "./envelope.ts";
import { EVENTS, isEventName } from "./events.ts";

const ID = crypto.randomUUID();
const guild = { id: "123456789012345678", name: "Dżajcarz", iconUrl: null, memberCount: 4 };

describe("GuildSummary", () => {
  test("accepts a guild with or without an icon", () => {
    expect(GuildSummary.safeParse(guild).success).toBe(true);
    expect(
      GuildSummary.safeParse({
        ...guild,
        iconUrl: "https://cdn.discordapp.com/icons/123456789012345678/abc.png?size=64",
      }).success,
    ).toBe(true);
  });

  test.each([
    ["a non-snowflake id", { ...guild, id: "abc" }],
    ["a short id", { ...guild, id: "12345" }],
    ["a negative member count", { ...guild, memberCount: -1 }],
    ["a fractional member count", { ...guild, memberCount: 1.5 }],
    ["a missing name", { id: guild.id, iconUrl: null, memberCount: 1 }],
    ["an icon on another host", { ...guild, iconUrl: "https://cdn.example/i.png" }],
    ["an icon over http", { ...guild, iconUrl: "http://cdn.discordapp.com/icons/1/a.png" }],
    ["a javascript: icon", { ...guild, iconUrl: "javascript:alert(1)" }],
    [
      "an icon on a look-alike host",
      { ...guild, iconUrl: "https://cdn.discordapp.com.evil.example/a.png" },
    ],
  ])("rejects %s", (_label, value) => {
    expect(GuildSummary.safeParse(value).success).toBe(false);
  });
});

describe("envelopes", () => {
  const command = {
    v: 1,
    id: ID,
    replyTo: `dzajcarz:web:reply:${ID}`,
    command: "guilds.list",
    payload: {},
    sentAt: 1,
    deadline: 2,
  };

  test("a command envelope round-trips, with a deadline up to 30 s after sentAt", () => {
    expect(CommandEnvelope.safeParse(command).success).toBe(true);
    expect(CommandEnvelope.safeParse({ ...command, sentAt: 0, deadline: 30_000 }).success).toBe(
      true,
    );
  });

  test.each([
    ["an unknown version", { ...command, v: 2 }],
    ["a reply channel that is not a reply channel", { ...command, replyTo: "dzajcarz:web:event" }],
    ["a non-uuid id", { ...command, id: "nope" }],
    ["a missing deadline", { ...command, deadline: undefined }],
    ["a deadline before sentAt", { ...command, sentAt: 10, deadline: 9 }],
    ["a deadline over 30 s after sentAt", { ...command, sentAt: 0, deadline: 30_001 }],
    ["a command name with a capital", { ...command, command: "guilds.List" }],
    ["a command name over 64 characters", { ...command, command: `a.${"b".repeat(63)}` }],
  ])("a command envelope rejects %s", (_label, value) => {
    expect(CommandEnvelope.safeParse(value).success).toBe(false);
  });

  test("a reply is either a result or an error with a known code", () => {
    expect(ReplyEnvelope.safeParse({ v: 1, id: ID, ok: true, result: [] }).success).toBe(true);
    expect(
      ReplyEnvelope.safeParse({ v: 1, id: ID, ok: false, error: { code: "failed", message: "x" } })
        .success,
    ).toBe(true);
    expect(
      ReplyEnvelope.safeParse({ v: 1, id: ID, ok: false, error: { code: "weird", message: "x" } })
        .success,
    ).toBe(false);
    expect(ReplyEnvelope.safeParse({ v: 2, id: ID, ok: true, result: [] }).success).toBe(false);
  });

  test("an event envelope needs the known version", () => {
    expect(EventEnvelope.safeParse({ v: 1, event: "bot.status", payload: {}, at: 1 }).success).toBe(
      true,
    );
    expect(EventEnvelope.safeParse({ v: 3, event: "bot.status", payload: {}, at: 1 }).success).toBe(
      false,
    );
  });
});

describe("registries", () => {
  test.each(Object.entries(COMMANDS))(
    "command %s has a request and a response schema",
    (name, schemas) => {
      expect(isCommandName(name)).toBe(true);
      expect(typeof schemas.request.safeParse).toBe("function");
      expect(typeof schemas.response.safeParse).toBe("function");
    },
  );

  test.each(Object.entries(EVENTS))("event %s has a payload schema", (name, schema) => {
    expect(isEventName(name)).toBe(true);
    expect(typeof schema.safeParse).toBe("function");
  });

  test("a request without keys is strict", () => {
    expect(COMMANDS["guilds.list"].request.safeParse({}).success).toBe(true);
    expect(COMMANDS["guilds.list"].request.safeParse({ extra: 1 }).success).toBe(false);
  });

  test("names that are not registered are not commands or events", () => {
    expect(isCommandName("toString")).toBe(false);
    expect(isEventName("constructor")).toBe(false);
  });

  test("bot.status needs a count and an ISO date", () => {
    expect(
      EVENTS["bot.status"].safeParse({ guilds: 3, startedAt: "2026-11-11T10:00:00.000Z" }).success,
    ).toBe(true);
    expect(EVENTS["bot.status"].safeParse({ guilds: 3, startedAt: "yesterday" }).success).toBe(
      false,
    );
  });
});
