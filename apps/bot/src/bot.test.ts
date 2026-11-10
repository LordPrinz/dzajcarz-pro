import { describe, expect, test } from "bun:test";
import {
  type CommandContexts,
  createRegistry,
  defineButton,
  defineCommand,
  defineEvent,
  defineModal,
  defineUserSelect,
  type Logger,
  PUBLIC_OWNER,
  silentLogger,
  UNKNOWN_MODAL,
} from "@dzajcarz/core";
import {
  type ButtonInteraction,
  type Client,
  ComponentType,
  type Message,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  attachHandlers,
  createEventListener,
  handleComponent,
  handleMessage,
  handleModal,
  matchInvocation,
} from "./bot.ts";
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
      botInGuild: () => true,
      logger: silentLogger,
    };
    return { ran, replies, message, deps, registry, gate };
  }

  test("a prefix command runs while its module is on", async () => {
    const { ran, message, deps } = setup([]);
    await handleMessage(message, undefined, deps);
    expect(ran).toEqual(["command"]);
  });

  test("a prefix command from another bot is ignored", async () => {
    const { ran, replies, message, deps } = setup([]);
    Object.assign(message, { author: { bot: true } });
    await handleMessage(message, undefined, deps);
    expect(ran).toEqual([]);
    expect(replies).toEqual([]);
  });

  test("a prefix command posted by a webhook is ignored", async () => {
    const { ran, replies, message, deps } = setup([]);
    Object.assign(message, { webhookId: "500000000000000005" });
    await handleMessage(message, undefined, deps);
    expect(ran).toEqual([]);
    expect(replies).toEqual([]);
  });

  test("passes deps.cooldowns to the dispatcher, so a second call is refused", async () => {
    const { ran, replies, message, deps } = setup([]);
    const windows = new Map<string, number>();
    const cooldowns = {
      increment: async (key: string, ttlMs: number) => {
        const count = (windows.get(key) ?? 0) + 1;
        windows.set(key, count);
        return { count, ttlMs };
      },
    };
    const limited = createRegistry([
      {
        name: "fun",
        commands: [
          defineCommand({
            name: "ping",
            description: "x",
            cooldownMs: 5000,
            run: async () => {
              ran.push("command");
            },
          }),
        ],
      },
    ]);
    const withCooldowns = { ...deps, registry: limited, cooldowns };
    await handleMessage(message, undefined, withCooldowns);
    await handleMessage(message, undefined, withCooldowns);
    expect(ran).toEqual(["command"]);
    expect(replies).toEqual([
      expect.objectContaining({ content: "Zwolnij. Spróbuj ponownie za 5 s." }),
    ]);
  });

  test("a guild-only command in a DM gets the server-only reply", async () => {
    const { ran, replies, message, deps } = setup([]);
    Object.assign(message, { guildId: null });
    await handleMessage(message, undefined, deps);
    expect(ran).toEqual([]);
    expect(replies).toEqual([
      expect.objectContaining({
        content: "Ta komenda działa tylko na serwerze.",
        failIfNotExists: false,
      }),
    ]);
  });

  test("a parse error answers with failIfNotExists off, like the access refusal", async () => {
    const { replies, message, deps } = setup([]);
    const strict = createRegistry([
      {
        name: "fun",
        commands: [
          defineCommand({
            name: "ping",
            description: "x",
            options: { times: { type: "integer", description: "x", required: true } },
            run: async () => {},
          }),
        ],
      },
    ]);
    await handleMessage(message, undefined, { ...deps, registry: strict });
    expect(replies).toEqual([expect.objectContaining({ failIfNotExists: false })]);
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
        isUserSelectMenu: () => false,
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
      botInGuild: () => true,
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

  test("a click in a guild the bot is not in skips the module gate", async () => {
    const { ran, click, deps, button } = setup(["fun"]);
    let gateReads = 0;
    const gate: ModuleGate = {
      isEnabled: async () => {
        gateReads++;
        return false;
      },
      forget: async () => {},
    };
    await handleComponent(click(button.customId(OWNER, "5")), {
      ...deps,
      gate,
      botInGuild: () => false,
    });
    expect(ran).toEqual(["go:5"]);
    expect(gateReads).toBe(0);
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

  test("a public component runs for anyone, and a private one still refuses a stranger", async () => {
    const { ran, calls, click, deps } = setup([]);
    const panel = defineButton({
      module: "fun",
      name: "panel",
      public: true,
      run: async (ctx) => void ran.push(`panel:${ctx.user.id}`),
    });
    const registry = createRegistry([{ name: "fun", components: [panel] }]);
    await handleComponent(click(panel.customId(PUBLIC_OWNER), "999999999999999999"), {
      ...deps,
      registry,
    });
    expect(ran).toEqual(["panel:999999999999999999"]);
    expect(calls.find((c) => c.method === "reply")).toBeUndefined();

    const {
      ran: privateRan,
      calls: privateCalls,
      click: privateClick,
      deps: privateDeps,
      button,
    } = setup([]);
    await handleComponent(
      privateClick(button.customId(PUBLIC_OWNER), "999999999999999999"),
      privateDeps,
    );
    expect(privateRan).toEqual([]);
    expect(privateCalls[0]).toMatchObject({ payload: { content: "To nie Twoje menu." } });
  });

  test("a user select reaches a user-select handler with the chosen user", async () => {
    const { calls, click, deps } = setup([]);
    const seen: string[][] = [];
    const pick = defineUserSelect({
      module: "fun",
      name: "pick",
      run: async (ctx) => void seen.push([...ctx.values]),
    });
    const registry = createRegistry([{ name: "fun", components: [pick] }]);
    const interaction = {
      ...click(pick.customId(OWNER)),
      isButton: () => false,
      isUserSelectMenu: () => true,
      values: ["42"],
    } as unknown as ButtonInteraction;
    await handleComponent(interaction, { ...deps, registry });
    expect(seen).toEqual([["42"]]);
    expect(calls.map((c) => c.method)).toEqual(["deferUpdate"]);
  });

  test("a custom_id whose component kind differs from the interaction is answered as unknown", async () => {
    const { ran, calls, click, deps, button } = setup([]);
    const asUserSelect = {
      ...click(button.customId(OWNER)),
      isButton: () => false,
      isUserSelectMenu: () => true,
      values: ["42"],
    } as unknown as ButtonInteraction;
    await handleComponent(asUserSelect, deps);
    expect(ran).toEqual([]);
    expect(calls[0]).toMatchObject({ method: "reply" });
  });

  test("a select type no module handles is answered instead of left to time out", async () => {
    const { ran, calls, click, deps, button } = setup([]);
    const roleSelect = {
      ...click(button.customId(OWNER)),
      isButton: () => false,
      isStringSelectMenu: () => false,
      isUserSelectMenu: () => false,
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

/** A client that only records the listeners `attachHandlers` registers, so a test can fire events at them. */
function fakeClient() {
  const listeners = new Map<string, (...args: unknown[]) => Promise<void>>();
  const client = {
    on: (event: string, listener: (...args: unknown[]) => Promise<void>) =>
      void listeners.set(event, listener),
    once: () => {},
    user: { id: BOT },
  } as unknown as Client;
  return { client, listeners };
}

describe("slash commands in a guild the bot is not in", () => {
  const GUILD = "100000000000000001";

  async function runSlash(botInGuild: boolean) {
    const ran: string[] = [];
    const ping = defineCommand({
      name: "ping",
      description: "x",
      contexts: { places: ["guild"], installs: ["guild", "user"] },
      run: async () => {
        ran.push("command");
      },
    });
    let gateReads = 0;
    const gate: ModuleGate = {
      isEnabled: async () => {
        gateReads++;
        return false;
      },
      forget: async () => {},
    };
    const { client, listeners } = fakeClient();
    attachHandlers(client, {
      registry: createRegistry([{ name: "fun", commands: [ping] }]),
      gate,
      prefixes: { resolve: async () => "!", forget: async () => {} },
      botInGuild: () => botInGuild,
      logger: silentLogger,
    });
    const replies: unknown[] = [];
    const interaction = {
      id: "1",
      isMessageComponent: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: "ping",
      options: { data: [], getSubcommand: () => null },
      user: { id: "200000000000000002", displayName: "t" },
      guildId: GUILD,
      channelId: "300000000000000003",
      channel: null,
      context: 0,
      inGuild: () => true,
      memberPermissions: { bitfield: 0n },
      replied: false,
      deferred: false,
      reply: async (payload: unknown) => void replies.push(payload),
    };
    await listeners.get("interactionCreate")?.(interaction);
    return { ran, gateReads, replies };
  }

  test("the module gate is skipped, so the command runs without a Redis or database read", async () => {
    expect(await runSlash(false)).toMatchObject({ ran: ["command"], gateReads: 0 });
  });

  test("where the bot is a member the gate still applies", async () => {
    const result = await runSlash(true);
    expect(result.ran).toEqual([]);
    expect(result.gateReads).toBe(1);
    expect(result.replies).toHaveLength(1);
  });
});

describe("failure logs carry where they happened", () => {
  const GUILD = "100000000000000001";
  const gate: ModuleGate = { isEnabled: async () => true, forget: async () => {} };

  function recordingLogger() {
    const errors: { message: string; fields: Record<string, unknown> | undefined }[] = [];
    const logger: Logger = {
      ...silentLogger,
      error: (message, fields) => void errors.push({ message, fields }),
      child: () => logger,
    };
    return { logger, errors };
  }

  function attach(logger: Logger) {
    const { client, listeners } = fakeClient();
    attachHandlers(client, {
      registry: createRegistry([{ name: "fun" }]),
      gate,
      prefixes: {
        resolve: async () => {
          throw new Error("redis down");
        },
        forget: async () => {},
      },
      botInGuild: () => true,
      logger,
    });
    return listeners;
  }

  test("an alwaysRun event handler failure logs the guild and module", async () => {
    const { logger, errors } = recordingLogger();
    const boom = defineEvent({
      name: "boom",
      event: "messageCreate",
      alwaysRun: true,
      run: () => {
        throw new Error("nope");
      },
    });
    const [entry] = createRegistry([{ name: "fun", events: [boom] }]).events();
    if (!entry) throw new Error("event missing");
    const message = { guildId: GUILD, channelId: "3", channel: null };
    await createEventListener(entry, gate, logger)(message);
    expect(errors[0]?.fields).toMatchObject({ handler: "boom", module: "fun", guildId: GUILD });
  });

  test("a message that fails to be handled logs the guild", async () => {
    const { logger, errors } = recordingLogger();
    const message = {
      id: "9",
      guildId: GUILD,
      author: { bot: false },
      webhookId: null,
      content: "!x",
    };
    await attach(logger).get("messageCreate")?.(message);
    expect(errors[0]).toMatchObject({
      message: "Message handling failed",
      fields: { messageId: "9", guildId: GUILD },
    });
  });

  test("a failed interaction logs the guild and the command or custom id", async () => {
    const { logger, errors } = recordingLogger();
    const listener = attach(logger).get("interactionCreate");
    const boom = () => {
      throw new Error("nope");
    };
    await listener?.({ id: "1", guildId: GUILD, commandName: "ping", isMessageComponent: boom });
    await listener?.({ id: "2", guildId: GUILD, customId: "menu:1", isMessageComponent: boom });
    expect(errors.map((entry) => entry.fields)).toMatchObject([
      { interactionId: "1", guildId: GUILD, command: "ping" },
      { interactionId: "2", guildId: GUILD, customId: "menu:1" },
    ]);
  });
});

describe("modals in routing", () => {
  const GUILD = "100000000000000001";
  const OWNER = "200000000000000002";

  function setup(disabled: string[]) {
    const ran: string[] = [];
    const form = defineModal({
      module: "fun",
      name: "form",
      title: "Formularz",
      fields: { name: { type: "short", label: "Imię" } },
      run: async (ctx) => {
        ran.push(`${ctx.values.name}:${ctx.state}`);
        await ctx.reply("ok");
      },
    });
    const registry = createRegistry([{ name: "fun", modals: [form] }]);
    const gate: ModuleGate = {
      isEnabled: async (_guild, _channel, module) => !disabled.includes(module),
      forget: async () => {},
    };
    const calls: { method: string; payload: unknown }[] = [];
    const record = (method: string) => async (payload: unknown) => {
      calls.push({ method, payload });
    };
    const submit = (customId: string, userId = OWNER, name = "Ola") =>
      ({
        customId,
        user: { id: userId, displayName: "t" },
        guildId: GUILD,
        channelId: "300000000000000003",
        channel: { isThread: () => false },
        inGuild: () => true,
        memberPermissions: { bitfield: 0n },
        fields: { fields: new Map([["name", { type: ComponentType.TextInput, value: name }]]) },
        isFromMessage: () => false,
        reply: record("reply"),
        deferReply: record("deferReply"),
        followUp: record("followUp"),
      }) as unknown as ModalSubmitInteraction;
    const deps = {
      registry,
      gate,
      prefixes: { resolve: async () => "!", forget: async () => {} },
      botInGuild: () => true,
      logger: silentLogger,
    };
    return { ran, calls, submit, deps, form };
  }

  test("a submit from the owner runs the handler with typed values", async () => {
    const { ran, submit, deps, form } = setup([]);
    await handleModal(submit(form.build(OWNER, "7").customId), deps);
    expect(ran).toEqual(["Ola:7"]);
  });

  test("an invalid value is answered ephemerally in Polish", async () => {
    const { ran, calls, submit, deps, form } = setup([]);
    await handleModal(submit(form.build(OWNER).customId, OWNER, " "), deps);
    expect(ran).toEqual([]);
    expect(calls[0]).toMatchObject({
      method: "reply",
      payload: { content: "Pole „Imię” jest wymagane." },
    });
  });

  test("someone else's submit is refused", async () => {
    const { ran, calls, submit, deps, form } = setup([]);
    await handleModal(submit(form.build(OWNER).customId, "999999999999999999"), deps);
    expect(ran).toEqual([]);
    expect(calls[0]).toMatchObject({ payload: { content: "To nie Twój formularz." } });
  });

  test("a submit for a disabled module is refused", async () => {
    const { ran, calls, submit, deps, form } = setup(["fun"]);
    await handleModal(submit(form.build(OWNER).customId), deps);
    expect(ran).toEqual([]);
    expect(calls[0]).toMatchObject({
      payload: { content: "Ten moduł jest wyłączony na tym serwerze albo kanale." },
    });
  });

  test("a guild the bot is not in skips the module gate", async () => {
    const { ran, submit, deps, form } = setup(["fun"]);
    await handleModal(submit(form.build(OWNER).customId), { ...deps, botInGuild: () => false });
    expect(ran).toEqual(["Ola:"]);
  });

  test("an unknown modal is answered instead of timing out", async () => {
    const { calls, submit, deps } = setup([]);
    await handleModal(submit(`fun:gone:${OWNER}:`), deps);
    expect(calls[0]).toMatchObject({ method: "reply", payload: { content: UNKNOWN_MODAL } });
  });
});
