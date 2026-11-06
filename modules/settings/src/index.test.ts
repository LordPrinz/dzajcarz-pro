import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  executeCommand,
  matchPrefix,
  parsePrefixArgs,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext, replyText } from "@dzajcarz/core/testing";
import { createSettingsModule, type PrefixSettings } from "./index.ts";

const MANAGE_GUILD = 1n << 5n;

function setup() {
  const store = new Map<string, string>();
  const prefixes: PrefixSettings = {
    get: async (guildId) => store.get(guildId) ?? null,
    set: async (guildId, prefix) => void store.set(guildId, prefix),
    reset: async (guildId) => void store.delete(guildId),
  };
  const registry = createRegistry([createSettingsModule({ prefixes, defaultPrefix: "!" })]);
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
    ["`", "znaku `"],
  ])("rejects the prefix %j", async (prefix, message) => {
    const { run, store } = setup();
    const [reply] = await run("set", { prefix });
    expect(reply).toContain(message);
    expect(store.size).toBe(0);
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
