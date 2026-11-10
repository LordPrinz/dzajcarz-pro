import { describe, expect, test } from "bun:test";
import type { ResolvedComponent } from "@dzajcarz/core";
import { type ButtonInteraction, MessageFlags } from "discord.js";
import { contextFromComponent } from "./component-context.ts";

describe("component context", () => {
  test("an ephemeral reply after a defer is a private follow-up and leaves the clicked message alone", async () => {
    const calls: string[] = [];
    const interaction = {
      user: { id: "1", displayName: "t" },
      guildId: null,
      channelId: "2",
      inGuild: () => false,
      isStringSelectMenu: () => false,
      isUserSelectMenu: () => false,
      deferUpdate: async () => {
        calls.push("deferUpdate");
      },
      deleteReply: async () => {
        calls.push("delete");
      },
      editReply: async () => {
        calls.push("edit");
      },
      followUp: async (options: { flags?: unknown }) => {
        calls.push(`followUp:${String(options.flags)}`);
      },
    } as unknown as ButtonInteraction;
    const ctx = contextFromComponent(interaction, { state: "" } as ResolvedComponent);
    await ctx.defer();
    await ctx.reply({ content: "błąd", ephemeral: true });
    expect(calls).toEqual(["deferUpdate", `followUp:${MessageFlags.Ephemeral}`]);
  });
});
