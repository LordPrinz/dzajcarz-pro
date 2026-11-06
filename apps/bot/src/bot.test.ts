import { describe, expect, test } from "bun:test";
import { createRegistry, defineCommand, defineEvent, silentLogger } from "@dzajcarz/core";
import type { Message } from "discord.js";
import { createEventListener, handleMessage, matchInvocation } from "./bot.ts";
import type { ModuleGate } from "./module-gate.ts";

const BOT = "111111111111111111";

describe("matchInvocation", () => {
  test("accepts the guild prefix", () => {
    expect(matchInvocation("?ping", "?", BOT)).toEqual({ name: "ping", rest: "" });
    expect(matchInvocation("!ping", "?", BOT)).toBeNull();
  });

  test("accepts a mention of the bot instead of the prefix", () => {
    expect(matchInvocation(`<@${BOT}> play abc`, "!", BOT)).toEqual({ name: "play", rest: "abc" });
    expect(matchInvocation(`<@!${BOT}>help`, "!", BOT)).toEqual({ name: "help", rest: "" });
    expect(matchInvocation("<@222222222222222222> ping", "!", BOT)).toBeNull();
    expect(matchInvocation(`<@${BOT}>`, "!", BOT)).toBeNull();
    // Still works after a guild switches to a prefix of its own.
    expect(matchInvocation(`<@${BOT}> prefix reset`, "dz", BOT)).toEqual({
      name: "prefix",
      rest: "reset",
    });
  });
});

describe("module toggles in routing", () => {
  const GUILD = "100000000000000001";
  const CHANNEL = "300000000000000003";

  function setup(disabled: string[]) {
    const ran: string[] = [];
    const ping = defineCommand({
      name: "ping",
      description: "x",
      run: async () => {
        ran.push("command");
      },
    });
    const event = defineEvent({
      name: "on-message",
      event: "messageCreate",
      run: () => {
        ran.push("event");
      },
    });
    const cleanup = defineEvent({
      name: "cleanup",
      event: "messageCreate",
      alwaysRun: true,
      run: () => {
        ran.push("cleanup");
      },
    });
    const registry = createRegistry([{ name: "fun", commands: [ping], events: [event, cleanup] }]);
    const gate: ModuleGate = {
      isEnabled: async (_guild, _channel, module) => !disabled.includes(module),
      forget: async () => {},
    };
    const replies: unknown[] = [];
    const message = {
      author: { bot: false },
      webhookId: null,
      content: "!ping",
      guildId: GUILD,
      channelId: CHANNEL,
      member: null,
      channel: { isDMBased: () => false, isSendable: () => false },
      reply: async (payload: unknown) => void replies.push(payload),
    } as unknown as Message;
    const deps = {
      registry,
      gate,
      prefixes: { resolve: async () => "!", forget: async () => {} },
      logger: silentLogger,
    };
    return { ran, replies, message, deps, registry, gate };
  }

  test("a prefix command runs while its module is on", async () => {
    const { ran, message, deps } = setup([]);
    await handleMessage(message, undefined, deps);
    expect(ran).toEqual(["command"]);
  });

  test("a prefix command of a disabled module is blocked without a reply", async () => {
    const { ran, replies, message, deps } = setup(["fun"]);
    await handleMessage(message, undefined, deps);
    expect(ran).toEqual([]);
    expect(replies).toEqual([]);
  });

  test("an event handler runs while its module is on", async () => {
    const { ran, registry, gate, message } = setup([]);
    const [entry] = registry.events();
    if (!entry) throw new Error("event missing");
    await createEventListener(entry, gate, silentLogger)(message);
    expect(ran).toEqual(["event"]);
  });

  test("an event handler of a disabled module is skipped", async () => {
    const { ran, registry, gate, message } = setup(["fun"]);
    const [entry] = registry.events();
    if (!entry) throw new Error("event missing");
    await createEventListener(entry, gate, silentLogger)(message);
    expect(ran).toEqual([]);
  });

  test("an alwaysRun handler runs even when its module is off", async () => {
    const { ran, registry, gate, message } = setup(["fun"]);
    for (const entry of registry.events()) {
      await createEventListener(entry, gate, silentLogger)(message);
    }
    expect(ran).toEqual(["cleanup"]);
  });

  test("an event outside any guild is never gated", async () => {
    const { ran, registry, gate, message } = setup(["fun"]);
    const [entry] = registry.events();
    if (!entry) throw new Error("event missing");
    await createEventListener(entry, gate, silentLogger)({ ...message, guildId: null });
    expect(ran).toEqual(["event"]);
  });
});
