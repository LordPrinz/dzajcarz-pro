import { describe, expect, test } from "bun:test";
import {
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
  InteractionContextType,
  type Message,
  MessageFlags,
} from "discord.js";
import { contextFromInteraction, contextFromMessage, placeOf, slashArgs } from "./context.ts";
import { NO_MENTIONS } from "./reply.ts";

function fakeInteraction(data: unknown[], subcommand: string | null, deferReply = async () => {}) {
  return {
    deferReply,
    deferred: false,
    replied: false,
    options: { data, getSubcommand: () => subcommand },
    user: { id: "1", displayName: "tester" },
    guildId: null,
    channelId: "2",
    inGuild: () => false,
  } as unknown as ChatInputCommandInteraction;
}

describe("slash interactions", () => {
  test("a plain command reads its options from the top level", () => {
    const interaction = fakeInteraction(
      [{ name: "text", type: ApplicationCommandOptionType.String, value: "hej" }],
      null,
    );
    expect(slashArgs(interaction)).toEqual({ text: "hej" });
    expect(contextFromInteraction(interaction).subcommand).toBeUndefined();
  });

  test("a subcommand's arguments come from the nested options, and its name reaches the context", () => {
    const interaction = fakeInteraction(
      [
        {
          name: "set",
          type: ApplicationCommandOptionType.Subcommand,
          options: [{ name: "value", type: ApplicationCommandOptionType.String, value: "?" }],
        },
      ],
      "set",
    );
    expect(slashArgs(interaction)).toEqual({ value: "?" });
    expect(contextFromInteraction(interaction).subcommand).toBe("set");
  });

  test("a subcommand without options has no arguments", () => {
    const interaction = fakeInteraction(
      [{ name: "show", type: ApplicationCommandOptionType.Subcommand }],
      "show",
    );
    expect(slashArgs(interaction)).toEqual({});
  });

  test("defer passes the ephemeral flag to Discord only when asked", async () => {
    const calls: unknown[] = [];
    const interaction = fakeInteraction([], null, async (options?: unknown) => {
      calls.push(options);
    });
    await contextFromInteraction(interaction).defer({ ephemeral: true });
    await contextFromInteraction(interaction).defer();
    expect(calls).toEqual([{ flags: MessageFlags.Ephemeral }, { flags: undefined }]);
  });
});

describe("place", () => {
  test("follows the interaction context, so a group DM is not the DM with the bot", () => {
    expect(placeOf(InteractionContextType.Guild, "1")).toBe("guild");
    expect(placeOf(InteractionContextType.BotDM, null)).toBe("bot-dm");
    expect(placeOf(InteractionContextType.PrivateChannel, null)).toBe("private-channel");
  });

  test("without a context a guild id means a server and none a DM with the bot", () => {
    expect(placeOf(null, "1")).toBe("guild");
    expect(placeOf(undefined, null)).toBe("bot-dm");
  });

  test("slash and prefix contexts carry it", () => {
    const interaction = fakeInteraction([], null);
    Object.assign(interaction, { context: InteractionContextType.PrivateChannel });
    expect(contextFromInteraction(interaction).place).toBe("private-channel");
    const message = (guildId: string | null) =>
      ({
        guildId,
        channelId: "2",
        author: { id: "1", displayName: "t" },
        member: null,
        channel: { isDMBased: () => guildId === null },
      }) as unknown as Message;
    expect(contextFromMessage(message("5"), {}).place).toBe("guild");
    expect(contextFromMessage(message(null), {}).place).toBe("bot-dm");
  });
});

describe("prefix replies", () => {
  test("pass NO_MENTIONS and still go out when the command message is gone", async () => {
    const sent: unknown[] = [];
    const message = {
      guildId: "5",
      channelId: "2",
      author: { id: "1", displayName: "t" },
      member: null,
      channel: { isDMBased: () => false },
      reply: async (payload: unknown) => void sent.push(payload),
    } as unknown as Message;
    await contextFromMessage(message, {}).reply("hej");
    expect(sent).toEqual([
      {
        content: "hej",
        embeds: [],
        components: [],
        allowedMentions: NO_MENTIONS,
        failIfNotExists: false,
      },
    ]);
  });
});
