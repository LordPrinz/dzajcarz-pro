import type { CommandContext } from "@dzajcarz/core";
import { type ChatInputCommandInteraction, type Message, MessageFlags } from "discord.js";
import { NO_MENTIONS, toReplyPayload } from "./reply.ts";

/** Reads the options a command declared from a slash interaction. */
export function slashArgs(interaction: ChatInputCommandInteraction): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const option of interaction.options.data) {
    // user / channel / role options carry the id in `value`, like their prefix form.
    if (option.value !== undefined) args[option.name] = option.value;
  }
  return args;
}

export function contextFromInteraction(interaction: ChatInputCommandInteraction): CommandContext {
  return {
    args: slashArgs(interaction),
    invocation: "slash",
    user: { id: interaction.user.id, displayName: interaction.user.displayName },
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    memberPermissions: interaction.inGuild()
      ? (interaction.memberPermissions?.bitfield ?? 0n)
      : null,
    async reply(reply) {
      const { content, embeds, ephemeral } = toReplyPayload(reply);
      const payload = { content, embeds, allowedMentions: NO_MENTIONS };
      const flags = ephemeral ? MessageFlags.Ephemeral : undefined;
      if (interaction.replied) {
        await interaction.followUp({ ...payload, flags });
      } else if (interaction.deferred) {
        // A deferred reply's visibility was fixed by defer(), so `ephemeral` cannot change it here.
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags });
      }
    },
    async defer() {
      if (!interaction.deferred && !interaction.replied) await interaction.deferReply();
    },
  };
}

export function contextFromMessage(
  message: Message,
  args: Record<string, unknown>,
): CommandContext {
  const member = message.member;
  const channel = message.channel;
  return {
    args,
    invocation: "prefix",
    user: { id: message.author.id, displayName: member?.displayName ?? message.author.displayName },
    guildId: message.guildId,
    channelId: message.channelId,
    memberPermissions:
      member && !channel.isDMBased() ? member.permissionsIn(channel).bitfield : null,
    async reply(reply) {
      const { content, embeds } = toReplyPayload(reply);
      await message.reply({ content, embeds, allowedMentions: NO_MENTIONS });
    },
    async defer() {
      if (channel.isSendable()) await channel.sendTyping();
    },
  };
}
