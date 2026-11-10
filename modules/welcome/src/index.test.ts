import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  executeCommand,
  type LogFields,
  type Logger,
  silentLogger,
} from "@dzajcarz/core";
import { createFakeContext, replyText, submitModal } from "@dzajcarz/core/testing";
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
const announcementId = "400000000000000005";
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
    isTextChannelOf: async (id, channel) =>
      id === guildId && (channel === channelId || channel === announcementId),
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
    invocation: "slash" | "prefix" = "slash",
  ) => {
    const ctx = createFakeContext({ args, subcommand, memberPermissions, invocation });
    await executeCommand(command, ctx, silentLogger);
    return Object.assign(
      ctx.replies.map((r) => replyText(r)),
      { deferred: ctx.deferred, deferOptions: ctx.deferOptions, modals: ctx.modals },
    );
  };
  return { run, registry, configs, sent, warnings, event };
}

function fakeMember(bot = false): GuildMember {
  return {
    id: "500000000000000005",
    displayName: "Ola",
    user: { bot },
    guild: { id: guildId, name: "Dżajsy", memberCount: 12 },
  } as unknown as GuildMember;
}

describe("/welcome set form", () => {
  test("slash opens the form and saves nothing yet", async () => {
    const { run, configs } = setup();
    const result = await run("set");
    expect(result.modals).toHaveLength(1);
    expect(result).toHaveLength(0);
    expect(configs.size).toBe(0);
    const fields = result.modals[0]?.fields ?? [];
    expect(fields.map((f) => [f.customId, f.type])).toEqual([
      ["channel", "channel"],
      ["message", "paragraph"],
    ]);
    expect(fields[0]?.channelTypes).toEqual(["text", "announcement"]);
    expect(fields[0]?.value).toBeUndefined();
    for (const placeholder of ["{user}", "{username}", "{server}", "{memberCount}"]) {
      expect(fields[1]?.description).toContain(placeholder);
    }
  });

  test("the form is prefilled with the current settings", async () => {
    const { run, configs } = setup();
    configs.set(guildId, { channelId, template: "Cześć {user}" });
    const [spec] = (await run("set")).modals;
    expect(spec?.fields.map((f) => f.value)).toEqual([channelId, "Cześć {user}"]);
  });

  async function openAndSubmit(
    values: Record<string, string | string[]>,
    permissions: bigint = MANAGE_GUILD,
  ) {
    const { run, registry, configs } = setup();
    const [spec] = (await run("set")).modals;
    if (!spec) throw new Error("modal not opened");
    const ctx = await submitModal({
      registry,
      customId: spec.customId,
      values,
      guildId,
      memberPermissions: permissions,
    });
    return { ctx, configs };
  }

  test("a valid submit saves the settings and answers ephemerally", async () => {
    const { ctx, configs } = await openAndSubmit({
      channel: [channelId],
      message: "  Hej {user}  ",
    });
    expect(configs.get(guildId)).toEqual({ channelId, template: "Hej {user}" });
    expect(replyText(ctx.replies[0])).toContain(`<#${channelId}>`);
    expect(ctx.replies[0]).toMatchObject({ ephemeral: true });
  });

  test("a channel of another guild is refused", async () => {
    const { ctx, configs } = await openAndSubmit({ channel: [foreignChannelId], message: "Hej" });
    expect(replyText(ctx.replies[0])).toBe("Wybierz kanał tekstowy z tego serwera.");
    expect(configs.size).toBe(0);
  });

  test("an announcement channel is accepted", async () => {
    const { ctx, configs } = await openAndSubmit({ channel: [announcementId], message: "Hej" });
    expect(configs.get(guildId)).toEqual({ channelId: announcementId, template: "Hej" });
    expect(replyText(ctx.replies[0])).toContain(`<#${announcementId}>`);
  });

  test("an empty message gets the same wording as the prefix form", async () => {
    const { ctx, configs } = await openAndSubmit({ channel: [channelId], message: "   " });
    expect(replyText(ctx.replies[0])).toBe("Treść powitania nie może być pusta.");
    expect(configs.size).toBe(0);
  });

  test("a message over the limit is refused and handed back in code blocks", async () => {
    const message = `${"a".repeat(1990)}\`\`\`${"b".repeat(30)}`;
    const { ctx, configs } = await openAndSubmit({ channel: [channelId], message });
    expect(replyText(ctx.replies[0])).toContain("2000");
    expect(configs.size).toBe(0);
    const blocks = ctx.replies.slice(1).map((reply) => replyText(reply) ?? "");
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.length).toBeLessThanOrEqual(2000);
      expect(block.startsWith("```\n")).toBe(true);
      expect(block.endsWith("\n```")).toBe(true);
      // Only the fences may be three backticks in a row.
      expect(block.slice(4, -4)).not.toContain("```");
    }
    const joined = blocks.map((block) => block.slice(4, -4)).join("");
    expect(joined.replaceAll("\u200b", "")).toBe(message);
    expect(ctx.replies[1]).toMatchObject({ ephemeral: true });
  });

  test("2000 emoji are within the limit", async () => {
    const message = "😀".repeat(2000);
    const { ctx, configs } = await openAndSubmit({ channel: [channelId], message });
    expect(configs.get(guildId)?.template).toBe(message);
    expect(replyText(ctx.replies[0])).toContain(`<#${channelId}>`);
  });

  test("a submit without Manage Server saves nothing", async () => {
    const { configs } = await openAndSubmit({ channel: [channelId], message: "x" }, 0n);
    expect(configs.size).toBe(0);
  });

  test("the form is not prefilled with a channel that is no longer a text channel", async () => {
    const { run, configs } = setup();
    configs.set(guildId, { channelId: foreignChannelId, template: "Cześć {user}" });
    const [spec] = (await run("set")).modals;
    expect(spec?.fields.map((f) => f.value)).toEqual([undefined, "Cześć {user}"]);
  });

  test("slash without Manage Server opens no form", async () => {
    const { run } = setup();
    const result = await run("set", {}, 0n);
    expect(result.modals).toHaveLength(0);
  });

  test("someone else cannot submit the form", async () => {
    const { run, registry, configs } = setup();
    const [spec] = (await run("set")).modals;
    if (!spec) throw new Error("modal not opened");
    const ctx = await submitModal({
      registry,
      customId: spec.customId,
      values: { channel: [channelId], message: "x" },
      userId: "999999999999999999",
      guildId,
      memberPermissions: MANAGE_GUILD,
    });
    expect(replyText(ctx.replies[0])).toContain("Twój formularz");
    expect(configs.size).toBe(0);
  });
});

describe("/welcome commands", () => {
  test("set stores channel and trimmed template", async () => {
    const { run, configs } = setup();
    const [reply] = await run(
      "set",
      { channel: channelId, message: "  Hej {user}  " },
      MANAGE_GUILD,
      "prefix",
    );
    expect(configs.get(guildId)).toEqual({ channelId, template: "Hej {user}" });
    expect(reply).toContain(`<#${channelId}>`);
  });

  test("set refuses a channel of another guild or one that is not text", async () => {
    const { run, configs } = setup();
    const [reply] = await run(
      "set",
      { channel: foreignChannelId, message: "Hej" },
      MANAGE_GUILD,
      "prefix",
    );
    expect(reply).toBe("Wybierz kanał tekstowy z tego serwera.");
    expect(configs.size).toBe(0);
  });

  test("set counts the length in code points", async () => {
    const { run, configs } = setup();
    await run("set", { channel: channelId, message: "😀".repeat(2000) }, MANAGE_GUILD, "prefix");
    expect(configs.size).toBe(1);
  });

  test("set rejects an empty or over-long message", async () => {
    const { run, configs } = setup();
    expect(
      (await run("set", { channel: channelId, message: "   " }, MANAGE_GUILD, "prefix"))[0],
    ).toContain("pusta");
    expect(
      (
        await run("set", { channel: channelId, message: "a".repeat(2001) }, MANAGE_GUILD, "prefix")
      )[0],
    ).toContain("2000");
    expect(configs.size).toBe(0);
  });

  test("set, off and test need Manage Server", async () => {
    const { run, configs } = setup();
    await run("set", { channel: channelId, message: "x" }, 0n, "prefix");
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

  test("test defers ephemerally before it does any slow work", async () => {
    const { run, configs } = setup();
    configs.set(guildId, { channelId, template: "x" });
    const result = await run("test");
    expect(result.deferred).toBe(true);
    expect(result.deferOptions).toEqual({ ephemeral: true });
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
