import type { CommandContext } from "@dzajcarz/core";
import {
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
  type Message,
  MessageFlags,
} from "discord.js";
import { NO_MENTIONS, toReplyPayload } from "./reply.ts";

/** Reads the options a command declared from a slash interaction. */
export function slashArgs(interaction: ChatInputCommandInteraction): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  // A subcommand arrives as one option whose own `options` hold the arguments.
  const first = interaction.options.data[0];
  const given =
    first?.type === ApplicationCommandOptionType.Subcommand
      ? (first.options ?? [])
      : interaction.options.data;
  for (const option of given) {
    // user / channel / role options carry the id in `value`, like their prefix form.
    if (option.value !== undefined) args[option.name] = option.value;
  }
  return args;
}

export function contextFromInteraction(interaction: ChatInputCommandInteraction): CommandContext {
  return {
    args: slashArgs(interaction),
    invocation: "slash",
    subcommand: interaction.options.getSubcommand(false) ?? undefined,
    user: { id: interaction.user.id, displayName: interaction.user.displayName },
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    memberPermissions: interaction.inGuild()
      ? (interaction.memberPermissions?.bitfield ?? 0n)
      : null,
    async reply(reply) {
      const { content, embeds, components, ephemeral } = toReplyPayload(reply);
      const payload = { content, embeds, components, allowedMentions: NO_MENTIONS };
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
    async defer(options) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({
          flags: options?.ephemeral ? MessageFlags.Ephemeral : undefined,
        });
      }
    },
  };
}

export function contextFromMessage(
  message: Message,
  args: Record<string, unknown>,
  subcommand?: string,
): CommandContext {
  const member = message.member;
  const channel = message.channel;
  return {
    args,
    invocation: "prefix",
    subcommand,
    user: { id: message.author.id, displayName: member?.displayName ?? message.author.displayName },
    guildId: message.guildId,
    channelId: message.channelId,
    memberPermissions:
      member && !channel.isDMBased() ? member.permissionsIn(channel).bitfield : null,
    async reply(reply) {
      const { content, embeds, components } = toReplyPayload(reply);
      await message.reply({ content, embeds, components, allowedMentions: NO_MENTIONS });
    },
    async defer() {
      if (channel.isSendable()) await channel.sendTyping();
    },
  };
}
