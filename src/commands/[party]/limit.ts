import type { DzajCommand } from '@/core/commander';
import { database } from '@/lib/db';
import { ApplicationCommandOptionType, MessageFlags } from 'discord.js';

export default {
  description: 'Limits party channel',
  type: 'both',
  guildOnly: true,
  minArgs: 1,
  expectedArgs: '<limit>',
  options: [
    {
      name: 'limit',
      description: 'The new channel limit',
      required: true,
      type: ApplicationCommandOptionType.Integer,
      maxValue: 99,
      minValue: 1,
    },
  ],
  callback: async ({ args, member, guild }) => {
    if (!args.length) {
      return { content: 'Please provide a new limit', flags: MessageFlags.Ephemeral };
    }

    if (!member?.voice.channel) {
      return {
        content: 'You need to be in a voice channel to limit a channel',
        flags: MessageFlags.Ephemeral,
      };
    }

    const channel = member.voice.channel;

    const isCustomChannel = await database.isCustomVoiceChannel(guild!.id, channel.id);

    if (!isCustomChannel) {
      return {
        content: 'You can only limit party channels',
        flags: MessageFlags.Ephemeral,
      };
    }

    const limit = parseInt(args[0]);

    if (limit < 1 || limit > 99) {
      return {
        content: 'Limit must be between 1 and 99',
        flags: MessageFlags.Ephemeral,
      };
    }

    await channel
      .edit({
        userLimit: limit,
      })
      .catch(() => console.warn('Failed to update channel limit'));

    return {
      content: `Channel limit updated!`,
      flags: MessageFlags.Ephemeral,
    };
  },
} as DzajCommand;
