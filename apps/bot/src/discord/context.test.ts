import { describe, expect, test } from "bun:test";
import {
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { contextFromInteraction, slashArgs } from "./context.ts";

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
