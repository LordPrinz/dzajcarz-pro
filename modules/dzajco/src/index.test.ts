import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  executeCommand,
  type LogFields,
  type Logger,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext, replyText } from "@dzajcarz/core/testing";
import { createMemoryStore, type KeyValueStore } from "@dzajcarz/kv";
import {
  createDzajcoModule,
  type DzajcoMessage,
  type DzajcoResponder,
  type DzajcoSettings,
  type DzajcoSettingsStore,
  type TextChannels,
} from "./index.ts";

const MANAGE_GUILD = 1n << 5n;
const guildId = "100000000000000001";
const channelId = "300000000000000003";
const otherChannelId = "300000000000000004";
const voiceChannelId = "300000000000000005";
const botId = "999000000000000009";

function setup({
  randoms = [],
  respondFails = false,
  store: customStore,
}: {
  randoms?: number[];
  respondFails?: boolean;
  store?: KeyValueStore;
} = {}) {
  let time = 1_000_000;
  const store = customStore ?? createMemoryStore(() => time);
  const rows = new Map<string, DzajcoSettings>();
  const key = (guild: string, channel: string) => `${guild}:${channel}`;
  const settingsReads: string[] = [];
  const settings: DzajcoSettingsStore = {
    get: async (guild, channel) => {
      settingsReads.push(channel);
      return rows.get(key(guild, channel)) ?? null;
    },
    set: async (guild, channel, value) => void rows.set(key(guild, channel), value),
    clear: async (guild, channel) => rows.delete(key(guild, channel)),
  };
  const responses: { channelId: string; messageId: string }[] = [];
  const responder: DzajcoResponder = {
    async respond(channel, messageId) {
      if (respondFails) throw new Error("Missing Access");
      responses.push({ channelId: channel, messageId });
    },
  };
  const channels: TextChannels = {
    isTextChannelOf: async (id, channel) =>
      id === guildId && (channel === channelId || channel === otherChannelId),
  };
  const warnings: { message: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    ...silentLogger,
    warn: (message, fields) => void warnings.push({ message, fields }),
    child: () => logger,
  };
  const queue = [...randoms];
  const randomCalls: number[] = [];
  const random = () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("random() called without a queued value");
    randomCalls.push(next);
    return next;
  };
  const module = createDzajcoModule({
    settings,
    responder,
    kv: store,
    channels,
    random,
    prefixFor: async () => "!",
    logger,
  });
  const registry = createRegistry([module]);
  const command = registry.find("dzajco");
  if (!command) throw new Error("dzajco command missing");
  const event = module.events?.[0];
  if (!event) throw new Error("dzajco event missing");

  const say = (content: string, overrides: Partial<DzajcoMessage> = {}) =>
    event.run({
      id: "700000000000000007",
      channelId,
      guildId,
      content,
      author: { bot: false },
      webhookId: null,
      client: { user: { id: botId } },
      ...overrides,
    } satisfies DzajcoMessage);

  const run = async (
    subcommand: string,
    args: Record<string, unknown> = {},
    memberPermissions: bigint = MANAGE_GUILD,
    guild: string | null = guildId,
  ) => {
    const ctx = createFakeContext({ args, subcommand, memberPermissions, guildId: guild });
    await executeCommand(command, ctx, silentLogger);
    return ctx.replies.map((r) => replyText(r));
  };
  return {
    say,
    run,
    rows,
    responses,
    warnings,
    store,
    settingsReads,
    randomCalls,
    advance: (ms: number) => {
      time += ms;
    },
    registry,
  };
}

describe("when Dżajco answers", () => {
  test("the default chance is 3%: 0.029 answers and 0.030 does not", async () => {
    const t = setup({ randoms: [0.029] });
    await t.say("what?");
    expect(t.responses).toEqual([{ channelId, messageId: "700000000000000007" }]);

    const u = setup({ randoms: [0.03] });
    await u.say("what?");
    expect(u.responses).toEqual([]);
  });

  test("a message without a trigger word does not even roll the dice", async () => {
    const t = setup();
    await t.say("hello there");
    expect(t.randomCalls).toEqual([]);
    expect(t.responses).toEqual([]);
  });

  test("a message with several trigger words gets one answer", async () => {
    const t = setup({ randoms: [0, 0] });
    await t.say("what what co? qué");
    expect(t.responses).toHaveLength(1);
  });

  test("a word in another script triggers it", async () => {
    const t = setup({ randoms: [0] });
    await t.say("你说什么");
    expect(t.responses).toHaveLength(1);
  });

  test("a second match inside the cooldown is skipped without rolling", async () => {
    const t = setup({ randoms: [0, 0] });
    await t.say("what");
    await t.say("what again");
    expect(t.responses).toHaveLength(1);
    expect(t.randomCalls).toEqual([0]);
  });

  test("a failed roll does not start the cooldown", async () => {
    const t = setup({ randoms: [0.5, 0] });
    await t.say("what");
    await t.say("what");
    expect(t.responses).toHaveLength(1);
  });

  test("the cooldown ends after 60 seconds", async () => {
    const t = setup({ randoms: [0, 0, 0] });
    await t.say("what");
    t.advance(59_999);
    await t.say("what");
    expect(t.responses).toHaveLength(1);
    t.advance(1);
    await t.say("what");
    expect(t.responses).toHaveLength(2);
  });

  test("channels have separate cooldowns", async () => {
    const t = setup({ randoms: [0, 0] });
    await t.say("what");
    await t.say("what", { channelId: otherChannelId });
    expect(t.responses.map((r) => r.channelId)).toEqual([channelId, otherChannelId]);
  });
});

describe("what is ignored", () => {
  test.each([
    ["a command with the guild prefix", "!play what is love", {}],
    ["a message starting with a mention of the bot", `<@${botId}> what is love`, {}],
    ["a message starting with a nickname mention of the bot", `<@!${botId}> what`, {}],
    ["a bot author", "what", { author: { bot: true } }],
    ["a webhook", "what", { webhookId: "800000000000000008" }],
    ["a direct message", "what", { guildId: null }],
    ["an empty message (an attachment only)", "", {}],
    ["a blank message", "   ", {}],
  ] as const)("%s", async (_name, content, overrides) => {
    const t = setup();
    await t.say(content, overrides);
    expect(t.responses).toEqual([]);
    expect(t.randomCalls).toEqual([]);
  });

  test("a mention of somebody else in front does not hide the word", async () => {
    const t = setup({ randoms: [0] });
    await t.say("<@123456789012345678> what");
    expect(t.responses).toHaveLength(1);
  });
});

describe("failures", () => {
  test("a responder failure is logged, not thrown", async () => {
    const t = setup({ randoms: [0], respondFails: true });
    await t.say("what");
    expect(t.warnings.map((w) => w.message)).toEqual(["Dżajco did not answer"]);
  });

  test("a Redis failure means no gif", async () => {
    const broken: KeyValueStore = {
      ...createMemoryStore(),
      get: async () => {
        throw new Error("Connection closed");
      },
    };
    const t = setup({ randoms: [0], store: broken });
    await t.say("what");
    expect(t.responses).toEqual([]);
    expect(t.warnings).toHaveLength(1);
  });
});

describe("per-channel settings", () => {
  test("a custom chance applies to its own channel only", async () => {
    const t = setup({ randoms: [0.5, 0.5] });
    t.rows.set(`${guildId}:${channelId}`, { chancePercent: 60, cooldownSeconds: 60 });
    await t.say("what");
    await t.say("what", { channelId: otherChannelId });
    expect(t.responses.map((r) => r.channelId)).toEqual([channelId]);
  });

  test("chance 0 turns the gif off", async () => {
    const t = setup({ randoms: [0] });
    t.rows.set(`${guildId}:${channelId}`, { chancePercent: 0, cooldownSeconds: 60 });
    await t.say("what");
    expect(t.responses).toEqual([]);
  });

  test("chance 100 always answers", async () => {
    const t = setup({ randoms: [0.999999] });
    t.rows.set(`${guildId}:${channelId}`, { chancePercent: 100, cooldownSeconds: 60 });
    await t.say("what");
    expect(t.responses).toHaveLength(1);
  });

  test("a custom cooldown is used", async () => {
    const t = setup({ randoms: [0, 0, 0] });
    t.rows.set(`${guildId}:${channelId}`, { chancePercent: 100, cooldownSeconds: 5 });
    await t.say("what");
    t.advance(4_999);
    await t.say("what");
    t.advance(1);
    await t.say("what");
    expect(t.responses).toHaveLength(2);
  });

  test("cooldown 0 never blocks", async () => {
    const t = setup({ randoms: [0, 0, 0] });
    t.rows.set(`${guildId}:${channelId}`, { chancePercent: 100, cooldownSeconds: 0 });
    await t.say("what");
    await t.say("what");
    await t.say("what");
    expect(t.responses).toHaveLength(3);
  });

  test("settings are read from the database once and then from the cache", async () => {
    const t = setup({ randoms: [0, 0] });
    await t.say("what");
    t.advance(61_000);
    await t.say("what");
    expect(t.settingsReads).toEqual([channelId]);
  });

  test("a broken cache entry is ignored and reloaded", async () => {
    const t = setup({ randoms: [0] });
    await t.store.set(`dzajco:settings:${channelId}`, "{not json", 60_000);
    await t.say("what");
    expect(t.responses).toHaveLength(1);
    expect(t.settingsReads).toEqual([channelId]);
  });
});

describe("/dzajco", () => {
  test("is limited to Manage Server and registered under the module name", () => {
    const t = setup();
    const command = t.registry.find("dzajco");
    expect(command?.permissions).toBe(MANAGE_GUILD);
  });

  test("a member without Manage Server is refused", async () => {
    const t = setup();
    expect(await t.run("set", { chance: 50 }, 0n)).toEqual(["Nie masz uprawnień do tej komendy."]);
    expect(t.rows.size).toBe(0);
  });

  test("show reports the defaults for a channel without an override", async () => {
    const t = setup();
    expect(await t.run("show")).toEqual([
      `Dżajco na <#${channelId}>: szansa 3%, przerwa 60 s (domyślne).`,
    ]);
  });

  test("set stores a chance and keeps the current cooldown", async () => {
    const t = setup();
    expect(await t.run("set", { chance: 10 })).toEqual([
      `Dżajco na <#${channelId}>: szansa 10%, przerwa 60 s.`,
    ]);
    expect(t.rows.get(`${guildId}:${channelId}`)).toEqual({
      chancePercent: 10,
      cooldownSeconds: 60,
    });
    expect(await t.run("set", { cooldown: 5 })).toEqual([
      `Dżajco na <#${channelId}>: szansa 10%, przerwa 5 s.`,
    ]);
    expect(await t.run("show")).toEqual([`Dżajco na <#${channelId}>: szansa 10%, przerwa 5 s.`]);
  });

  test("set accepts the bounds", async () => {
    const t = setup();
    await t.run("set", { chance: 0, cooldown: 0 });
    expect(t.rows.get(`${guildId}:${channelId}`)).toEqual({ chancePercent: 0, cooldownSeconds: 0 });
    await t.run("set", { chance: 100, cooldown: 86400 });
    expect(t.rows.get(`${guildId}:${channelId}`)).toEqual({
      chancePercent: 100,
      cooldownSeconds: 86400,
    });
  });

  test("set with neither value is refused", async () => {
    const t = setup();
    expect(await t.run("set")).toEqual(["Podaj szansę albo przerwę."]);
    expect(t.rows.size).toBe(0);
  });

  test("an explicit channel has to be a text channel of the guild", async () => {
    const t = setup();
    expect(await t.run("set", { channel: voiceChannelId, chance: 5 })).toEqual([
      "Wybierz kanał tekstowy z tego serwera.",
    ]);
    expect(await t.run("set", { channel: otherChannelId, chance: 5 })).toEqual([
      `Dżajco na <#${otherChannelId}>: szansa 5%, przerwa 60 s.`,
    ]);
    expect(t.rows.has(`${guildId}:${otherChannelId}`)).toBe(true);
  });

  test("reset removes the override and says when there was none", async () => {
    const t = setup();
    await t.run("set", { chance: 10 });
    expect(await t.run("reset")).toEqual([
      `Przywrócono domyślne ustawienia Dżajco na <#${channelId}>.`,
    ]);
    expect(t.rows.size).toBe(0);
    expect(await t.run("reset")).toEqual([
      `Ustawienia Dżajco na <#${channelId}> były już domyślne.`,
    ]);
  });

  test("outside a guild it is refused", async () => {
    const t = setup();
    expect(await t.run("show", {}, MANAGE_GUILD, null)).toEqual([
      "Ta komenda działa tylko na serwerze.",
    ]);
  });

  test("set and reset invalidate the cached settings and the running cooldown", async () => {
    const t = setup({ randoms: [0, 0, 0.5] });
    await t.say("what"); // caches the defaults, starts the cooldown
    expect(t.responses).toHaveLength(1);

    await t.run("set", { chance: 100, cooldown: 0 });
    await t.say("what"); // new settings apply at once: no cooldown left, 100 %
    expect(t.responses).toHaveLength(2);

    await t.run("reset");
    await t.say("what"); // back to 3%: 0.5 loses
    expect(t.responses).toHaveLength(2);
  });
});
