import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  executeCommand,
  type LogFields,
  type Logger,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext, replyText } from "@dzajcarz/core/testing";
import type { GuildMember } from "discord.js";
import {
  createWelcomeModule,
  type GuildLookup,
  type TextChannels,
  type WelcomeConfig,
  type WelcomeConfigStore,
  type WelcomeSender,
} from "./index.ts";

const MANAGE_GUILD = 1n << 5n;
const guildId = "100000000000000001";
const channelId = "400000000000000004";
const foreignChannelId = "900000000000000009";

function setup({ sendFails = false }: { sendFails?: boolean } = {}) {
  const configs = new Map<string, WelcomeConfig>();
  const store: WelcomeConfigStore = {
    get: async (id) => configs.get(id) ?? null,
    set: async (id, config) => void configs.set(id, config),
    delete: async (id) => configs.delete(id),
  };
  const sent: { channelId: string; text: string; memberId: string }[] = [];
  const sender: WelcomeSender = {
    async send(_guildId, channel, text, memberId) {
      if (sendFails) throw new Error("Missing Permissions");
      sent.push({ channelId: channel, text, memberId });
    },
  };
  // Only the guild's own text channel is known; everything else counts as foreign or not text.
  const channels: TextChannels = {
    isTextChannelOf: async (id, channel) => id === guildId && channel === channelId,
  };
  const guilds: GuildLookup = {
    describe: async () => ({ name: "Dżajsy", memberCount: 12 }),
  };
  const warnings: { message: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    ...silentLogger,
    warn: (message, fields) => void warnings.push({ message, fields }),
    child: () => logger,
  };
  const module = createWelcomeModule({ store, sender, guilds, channels, logger });
  const registry = createRegistry([module]);
  const command = registry.find("welcome");
  if (!command) throw new Error("welcome command missing");
  const event = module.events?.[0];
  if (!event) throw new Error("greet event missing");

  const run = async (
    subcommand: string,
    args: Record<string, unknown> = {},
    memberPermissions: bigint = MANAGE_GUILD,
  ) => {
    const ctx = createFakeContext({ args, subcommand, memberPermissions });
    await executeCommand(command, ctx, silentLogger);
    return Object.assign(
      ctx.replies.map((r) => replyText(r)),
      { deferred: ctx.deferred },
    );
  };
  return { run, configs, sent, warnings, event };
}

function fakeMember(bot = false): GuildMember {
  return {
    id: "500000000000000005",
    displayName: "Ola",
    user: { bot },
    guild: { id: guildId, name: "Dżajsy", memberCount: 12 },
  } as unknown as GuildMember;
}

describe("/welcome commands", () => {
  test("set stores channel and trimmed template", async () => {
    const { run, configs } = setup();
    const [reply] = await run("set", { channel: channelId, message: "  Hej {user}  " });
    expect(configs.get(guildId)).toEqual({ channelId, template: "Hej {user}" });
    expect(reply).toContain(`<#${channelId}>`);
  });

  test("set refuses a channel of another guild or one that is not text", async () => {
    const { run, configs } = setup();
    const [reply] = await run("set", { channel: foreignChannelId, message: "Hej" });
    expect(reply).toBe("Wybierz kanał tekstowy z tego serwera.");
    expect(configs.size).toBe(0);
  });

  test("set counts the length in code points", async () => {
    const { run, configs } = setup();
    await run("set", { channel: channelId, message: "😀".repeat(2000) });
    expect(configs.size).toBe(1);
  });

  test("set rejects an empty or over-long message", async () => {
    const { run, configs } = setup();
    expect((await run("set", { channel: channelId, message: "   " }))[0]).toContain("pusta");
    expect((await run("set", { channel: channelId, message: "a".repeat(2001) }))[0]).toContain(
      "2000",
    );
    expect(configs.size).toBe(0);
  });

  test("set, off and test need Manage Server", async () => {
    const { run, configs } = setup();
    await run("set", { channel: channelId, message: "x" }, 0n);
    expect(configs.size).toBe(0);
  });

  test("off removes the config and says so when there was none", async () => {
    const { run, configs } = setup();
    expect((await run("off"))[0]).toContain("nie były");
    configs.set(guildId, { channelId, template: "x" });
    expect((await run("off"))[0]).toBe("Powitania wyłączone.");
    expect(configs.size).toBe(0);
  });

  test("test sends the rendered greeting for the caller", async () => {
    const { run, configs, sent } = setup();
    configs.set(guildId, { channelId, template: "{user} {username} {server} {memberCount}" });
    const [reply] = await run("test");
    expect(sent).toEqual([
      {
        channelId,
        text: "<@200000000000000002> tester Dżajsy 12",
        memberId: "200000000000000002",
      },
    ]);
    expect(reply).toContain("Wysłano");
  });

  test("test defers before it does any slow work", async () => {
    const { run, configs } = setup();
    configs.set(guildId, { channelId, template: "x" });
    expect((await run("test")).deferred).toBe(true);
  });

  test("test without config points at set", async () => {
    const { run, sent } = setup();
    expect((await run("test"))[0]).toContain("welcome set");
    expect(sent).toEqual([]);
  });

  test("test tells the caller when sending fails", async () => {
    const { run, configs, warnings } = setup({ sendFails: true });
    configs.set(guildId, { channelId, template: "x" });
    expect((await run("test"))[0]).toContain("Nie mogę wysłać");
    expect(warnings).toHaveLength(1);
  });
});

describe("guildMemberAdd handler", () => {
  test("does nothing without a config", async () => {
    const { event, sent, warnings } = setup();
    await event.run(fakeMember());
    expect(sent).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("sends the rendered greeting, pinging only the new member", async () => {
    const { event, configs, sent } = setup();
    configs.set(guildId, { channelId, template: "Witaj {user} w {server}, jesteś #{memberCount}" });
    await event.run(fakeMember());
    expect(sent).toEqual([
      {
        channelId,
        text: "Witaj <@500000000000000005> w Dżajsy, jesteś #12",
        memberId: "500000000000000005",
      },
    ]);
  });

  test("skips bots", async () => {
    const { event, configs, sent } = setup();
    configs.set(guildId, { channelId, template: "x" });
    await event.run(fakeMember(true));
    expect(sent).toEqual([]);
  });

  test("a send failure is logged as a warning and does not throw", async () => {
    const { event, configs, warnings } = setup({ sendFails: true });
    configs.set(guildId, { channelId, template: "x" });
    await event.run(fakeMember());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe("Welcome message not sent");
  });

  test("a store failure is logged too", async () => {
    const { event, warnings } = setup();
    const broken = createWelcomeModule({
      store: {
        get: async () => {
          throw new Error("db down");
        },
        set: async () => {},
        delete: async () => false,
      },
      sender: { send: async () => {} },
      guilds: { describe: async () => null },
      channels: { isTextChannelOf: async () => true },
      logger: {
        ...silentLogger,
        warn: (message, fields) => void warnings.push({ message, fields }),
      },
    });
    await broken.events?.[0]?.run(fakeMember());
    expect(warnings).toHaveLength(1);
    void event;
  });
});
