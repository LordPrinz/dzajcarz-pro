import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  executeCommand,
  type LogFields,
  type Logger,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext, renderCatalog, replyText } from "@dzajcarz/core/testing";
import { createMemoryStore, type KeyValueStore } from "@dzajcarz/kv";
import {
  createDzajcoModule,
  type DzajcoChannels,
  type DzajcoMessage,
  type DzajcoResponder,
  type DzajcoSettings,
  type DzajcoSettingsStore,
} from "./index.ts";
import { t as messages } from "./messages.ts";

const MANAGE_GUILD = 1n << 5n;
const guildId = "100000000000000001";
const channelId = "300000000000000003";
const otherChannelId = "300000000000000004";
const voiceChannelId = "300000000000000005";
const botId = "999000000000000009";
const threadId = "300000000000000008";
const voiceChatId = "300000000000000009";
const dmChannelId = "300000000000000010";

function setup({
  randoms = [],
  respondFails = false,
  store: customStore,
  prefix = "!",
}: {
  randoms?: number[];
  respondFails?: boolean;
  store?: KeyValueStore;
  prefix?: string;
} = {}) {
  let time = 1_000_000;
  const store = customStore ?? createMemoryStore(() => time);
  const rows = new Map<string, DzajcoSettings>();
  const key = (guild: string | null, channel: string) => `${guild ?? "dm"}:${channel}`;
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
  const channels: DzajcoChannels = {
    parentOf: (id) => (id === threadId ? channelId : null),
    isChatOf: async (id, channel) =>
      id === guildId && [channelId, otherChannelId, threadId, voiceChatId].includes(channel),
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
    prefixFor: async () => prefix,
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
    locale: "pl" | "en" | "de" = "pl",
  ) => {
    const ctx = createFakeContext({ args, subcommand, memberPermissions, guildId: guild, locale });
    if (guild === null) Object.assign(ctx, { channelId: dmChannelId });
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

  test("a command with a word prefix in other case, like Co? with the prefix co", async () => {
    const t = setup({ prefix: "co" });
    await t.say("Co?");
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

  test("a thread without its own settings uses its parent channel's", async () => {
    const t = setup({ randoms: [0.5] });
    t.rows.set(`${guildId}:${channelId}`, { chancePercent: 60, cooldownSeconds: 60 });
    await t.say("what", { channelId: threadId });
    expect(t.responses.map((r) => r.channelId)).toEqual([threadId]);
  });

  test("show in a thread without settings reports the parent's and says so", async () => {
    const t = setup();
    t.rows.set(`${guildId}:${channelId}`, { chancePercent: 60, cooldownSeconds: 30 });
    expect(await t.run("show", { channel: threadId })).toEqual([
      `Dżajco na <#${threadId}>: szansa 60%, przerwa 30 s (z kanału nadrzędnego <#${channelId}>).`,
    ]);
  });

  test("a thread's own settings win over its parent's", async () => {
    const t = setup({ randoms: [0.5] });
    t.rows.set(`${guildId}:${channelId}`, { chancePercent: 100, cooldownSeconds: 60 });
    t.rows.set(`${guildId}:${threadId}`, { chancePercent: 0, cooldownSeconds: 60 });
    await t.say("what", { channelId: threadId });
    expect(t.responses).toEqual([]);
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
    expect(await t.store.get(`dzajco:settings:${channelId}`)).toBe("null");
  });
});

describe("/dzajco", () => {
  test("is registered under the module name", () => {
    const t = setup();
    expect(t.registry.find("dzajco")?.name).toBe("dzajco");
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

  test("an explicit channel has to be a chat of the guild", async () => {
    const t = setup();
    expect(await t.run("set", { channel: voiceChannelId, chance: 5 })).toEqual([
      "Wybierz kanał z tego serwera, na którym da się pisać (także wątek albo czat kanału głosowego).",
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

  test("in a DM, show gives the conversation's settings", async () => {
    const t = setup();
    expect(await t.run("show", {}, 0n, null)).toEqual([
      "Dżajco w tej rozmowie: szansa 3%, przerwa 60 s (domyślne).",
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

describe("threads, voice chats and DMs", () => {
  test("a thread and a voice channel's chat can be configured", async () => {
    const t = setup();
    expect(await t.run("set", { channel: threadId, chance: 50 })).toEqual([
      `Dżajco na <#${threadId}>: szansa 50%, przerwa 60 s.`,
    ]);
    expect(await t.run("set", { channel: voiceChatId, cooldown: 0 })).toEqual([
      `Dżajco na <#${voiceChatId}>: szansa 3%, przerwa 0 s.`,
    ]);
  });

  test("a channel of another server is still refused", async () => {
    const t = setup();
    expect(await t.run("set", { channel: "300000000000000099", chance: 50 })).toEqual([
      "Wybierz kanał z tego serwera, na którym da się pisać (także wątek albo czat kanału głosowego).",
    ]);
  });

  test("on a server it needs Manage Server, checked before the arguments", async () => {
    const t = setup();
    expect(await t.run("set", {}, 0n)).toEqual(["Nie masz uprawnień do tej komendy."]);
    expect(await t.run("show", {}, 0n)).toEqual(["Nie masz uprawnień do tej komendy."]);
  });

  test("Dżajco answers in a DM with the bot", async () => {
    const t = setup({ randoms: [0] });
    await t.say("what", { guildId: null, channelId: dmChannelId });
    expect(t.responses).toEqual([{ channelId: dmChannelId, messageId: "700000000000000007" }]);
  });

  test("a DM is configured by whoever is in it, for that conversation only", async () => {
    const t = setup({ randoms: [0.5] });
    expect(await t.run("set", { chance: 100 }, 0n, null)).toEqual([
      "Dżajco w tej rozmowie: szansa 100%, przerwa 60 s.",
    ]);
    await t.say("what", { guildId: null, channelId: dmChannelId });
    expect(t.responses).toHaveLength(1);
    expect(await t.run("set", { cooldown: 0 }, 0n, null)).toEqual([
      "Dżajco w tej rozmowie: szansa 100%, przerwa 10 s.",
    ]);
    expect(await t.run("set", { channel: channelId, chance: 1 }, 0n, null)).toEqual([
      "W prywatnej wiadomości ustawiasz tylko tę rozmowę.",
    ]);
    expect(await t.run("reset", {}, 0n, null)).toEqual([
      "Przywrócono domyślne ustawienia Dżajco w tej rozmowie.",
    ]);
  });

  test("the command is offered in servers and in DMs with the bot, not to user installs", () => {
    const t = setup();
    expect(t.registry.find("dzajco")?.contexts).toEqual({
      places: ["guild", "bot-dm"],
      installs: ["guild"],
    });
    expect(t.registry.find("dzajco")?.permissions).toBeUndefined();
  });
});

describe("languages", () => {
  test("/dzajco answers in English", async () => {
    const t = setup();
    expect(await t.run("show", {}, MANAGE_GUILD, guildId, "en")).toEqual([
      `Dżajco in <#${channelId}>: 3% chance, 60 s cooldown (default).`,
    ]);
    expect(await t.run("set", {}, MANAGE_GUILD, guildId, "en")).toEqual([
      "Give a chance or a cooldown.",
    ]);
    expect(await t.run("reset", {}, 0n, null, "en")).toEqual([
      "The Dżajco settings in this conversation were already the default.",
    ]);
  });

  test("/dzajco answers in German", async () => {
    const t = setup();
    expect(await t.run("set", { chance: 10 }, MANAGE_GUILD, guildId, "de")).toEqual([
      `Dżajco in <#${channelId}>: 10\u00A0% Wahrscheinlichkeit, 60\u00A0s Pause.`,
    ]);
    expect(await t.run("reset", {}, MANAGE_GUILD, guildId, "de")).toEqual([
      `Die Standard-Einstellungen von Dżajco in <#${channelId}> wurden wiederhergestellt.`,
    ]);
    expect(await t.run("set", { channel: channelId }, 0n, null, "de")).toEqual([
      "In einer privaten Nachricht kannst du nur diese Unterhaltung einstellen.",
    ]);
  });

  test("every catalog text is filled in", () => {
    for (const texts of Object.values(renderCatalog(messages))) {
      for (const s of Object.values(texts)) expect(s.trim()).not.toBe("");
    }
  });
});
