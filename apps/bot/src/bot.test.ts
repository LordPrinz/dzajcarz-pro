import { describe, expect, test } from "bun:test";
import {
  type CommandContexts,
  createRegistry,
  defineButton,
  defineCommand,
  defineEvent,
  silentLogger,
} from "@dzajcarz/core";
import type { ButtonInteraction, Message } from "discord.js";
import { createEventListener, handleComponent, handleMessage, matchInvocation } from "./bot.ts";
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

  function setup(disabled: string[], contexts?: CommandContexts) {
    const ran: string[] = [];
    const ping = defineCommand({
      name: "ping",
      description: "x",
      contexts,
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

  test("a guild-only command in a DM gets the server-only reply", async () => {
    const { ran, replies, message, deps } = setup([]);
    Object.assign(message, { guildId: null });
    await handleMessage(message, undefined, deps);
    expect(ran).toEqual([]);
    expect(replies).toEqual([
      expect.objectContaining({ content: "Ta komenda działa tylko na serwerze." }),
    ]);
  });

  test("a command with a DM context runs in a DM and uses the default prefix", async () => {
    const { ran, message, deps } = setup([], { places: ["guild", "bot-dm"], installs: ["guild"] });
    Object.assign(message, { guildId: null });
    const resolved: (string | null)[] = [];
    await handleMessage(message, undefined, {
      ...deps,
      prefixes: {
        resolve: async (guildId) => {
          resolved.push(guildId);
          return "!";
        },
        forget: async () => {},
      },
    });
    expect(ran).toEqual(["command"]);
    expect(resolved).toEqual([null]);
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

describe("components in routing", () => {
  const GUILD = "100000000000000001";
  const OWNER = "200000000000000002";

  function setup(disabled: string[]) {
    const ran: string[] = [];
    const button = defineButton({
      module: "fun",
      name: "go",
      run: async (ctx) => {
        ran.push(`go:${ctx.state}`);
      },
    });
    const registry = createRegistry([{ name: "fun", components: [button] }]);
    const gate: ModuleGate = {
      isEnabled: async (_guild, _channel, module) => !disabled.includes(module),
      forget: async () => {},
    };
    const calls: { method: string; payload: unknown }[] = [];
    const record = (method: string) => async (payload: unknown) => {
      calls.push({ method, payload });
    };
    const click = (customId: string, userId = OWNER, guildId: string | null = GUILD) =>
      ({
        customId,
        user: { id: userId, displayName: "t" },
        guildId,
        channelId: "300000000000000003",
        channel: guildId === null ? null : { isThread: () => false },
        inGuild: () => guildId !== null,
        memberPermissions: guildId === null ? null : { bitfield: 0n },
        isButton: () => true,
        isStringSelectMenu: () => false,
        message: { id: "msg1" },
        update: record("update"),
        deferUpdate: record("deferUpdate"),
        reply: record("reply"),
        editReply: record("editReply"),
        followUp: record("followUp"),
      }) as unknown as ButtonInteraction;
    const deps = {
      registry,
      gate,
      prefixes: { resolve: async () => "!", forget: async () => {} },
      logger: silentLogger,
    };
    return { ran, calls, click, deps, button };
  }

  test("a click from the owner runs the handler", async () => {
    const { ran, click, deps, button } = setup([]);
    await handleComponent(click(button.customId(OWNER, "7")), deps);
    expect(ran).toEqual(["go:7"]);
  });

  test("a click in a DM runs the handler", async () => {
    const { ran, click, deps, button } = setup([]);
    await handleComponent(click(button.customId(OWNER, "3"), OWNER, null), deps);
    expect(ran).toEqual(["go:3"]);
  });

  test("a click in a guild the bot is not in (channel not cached) still runs the handler", async () => {
    const { ran, click, deps, button } = setup([]);
    const interaction = click(button.customId(OWNER, "4"));
    Object.assign(interaction, { channel: null });
    await handleComponent(interaction, deps);
    expect(ran).toEqual(["go:4"]);
  });

  test("a click from someone else is refused ephemerally", async () => {
    const { ran, calls, click, deps, button } = setup([]);
    await handleComponent(click(button.customId(OWNER), "999999999999999999"), deps);
    expect(ran).toEqual([]);
    expect(calls[0]).toMatchObject({ method: "reply", payload: { content: "To nie Twoje menu." } });
  });

  test("a click on a component of a disabled module is refused ephemerally", async () => {
    const { ran, calls, click, deps, button } = setup(["fun"]);
    await handleComponent(click(button.customId(OWNER)), deps);
    expect(ran).toEqual([]);
    expect(calls[0]).toMatchObject({
      method: "reply",
      payload: { content: "Ten moduł jest wyłączony na tym serwerze albo kanale." },
    });
  });

  test("an unknown custom_id gets an ephemeral notice", async () => {
    const { ran, calls, click, deps } = setup([]);
    await handleComponent(click(`gone:thing:${OWNER}:`), deps);
    expect(ran).toEqual([]);
    expect(calls[0]).toMatchObject({
      method: "reply",
      payload: { allowedMentions: { parse: [] } },
    });
  });

  test("a select type no module handles is answered instead of left to time out", async () => {
    const { ran, calls, click, deps, button } = setup([]);
    const roleSelect = {
      ...click(button.customId(OWNER)),
      isButton: () => false,
      isStringSelectMenu: () => false,
    } as unknown as ButtonInteraction;
    await handleComponent(roleSelect, deps);
    expect(ran).toEqual([]);
    expect(calls[0]).toMatchObject({
      method: "reply",
      payload: { allowedMentions: { parse: [] } },
    });
  });

  test("a handler that says nothing still acknowledges the click", async () => {
    const { calls, click, deps } = setup([]);
    const quiet = defineButton({ module: "fun", name: "quiet", run: async () => {} });
    const registry = createRegistry([{ name: "fun", components: [quiet] }]);
    await handleComponent(click(quiet.customId(OWNER)), { ...deps, registry });
    expect(calls.map((c) => c.method)).toEqual(["deferUpdate"]);
  });
});
