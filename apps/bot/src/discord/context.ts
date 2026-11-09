import type { CommandContext, CommandPlace } from "@dzajcarz/core";
import {
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
  InteractionContextType,
  type Message,
  MessageFlags,
} from "discord.js";
import { toModalPayload } from "./modals.ts";
import { NO_MENTIONS, toReplyPayload } from "./reply.ts";

export const MODAL_NOT_FIRST =
  "showModal() must be the first answer to the interaction, but it was already deferred, replied to or updated";

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

/**
 * Where an interaction came from, from Discord's `context` field. Without one (older payloads) a guild id
 * means a server and none means the DM with the bot.
 */
export function placeOf(
  context: InteractionContextType | null | undefined,
  guildId: string | null,
): CommandPlace {
  switch (context) {
    case InteractionContextType.Guild:
      return "guild";
    case InteractionContextType.BotDM:
      return "bot-dm";
    case InteractionContextType.PrivateChannel:
      return "private-channel";
    default:
      return guildId === null ? "bot-dm" : "guild";
  }
}

export function contextFromInteraction(interaction: ChatInputCommandInteraction): CommandContext {
  return {
    args: slashArgs(interaction),
    invocation: "slash",
    subcommand: interaction.options.getSubcommand(false) ?? undefined,
    user: { id: interaction.user.id, displayName: interaction.user.displayName },
    guildId: interaction.guildId,
    place: placeOf(interaction.context, interaction.guildId),
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
    canShowModal: true,
    async showModal(modal) {
      if (interaction.deferred || interaction.replied) throw new Error(MODAL_NOT_FIRST);
      await interaction.showModal(toModalPayload(modal));
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
    // A bot cannot read prefix messages in a group DM, so a message is a server or the DM with the bot.
    place: message.guildId === null ? "bot-dm" : "guild",
    channelId: message.channelId,
    memberPermissions:
      member && !channel.isDMBased() ? member.permissionsIn(channel).bitfield : null,
    async reply(reply) {
      const { content, embeds, components } = toReplyPayload(reply);
      // A command may delete its own message (a purge racing a new message); the reply then goes out
      // without the reference instead of failing.
      await message.reply({
        content,
        embeds,
        components,
        allowedMentions: NO_MENTIONS,
        failIfNotExists: false,
      });
    },
    async defer() {
      if (channel.isSendable()) await channel.sendTyping();
    },
    canShowModal: false,
    async showModal() {
      throw new Error("A prefix command cannot open a modal; check ctx.canShowModal");
    },
  };
}
