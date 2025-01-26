import type { DzajCommand } from '@/core/commander';
import { database } from '@/lib/db';
import { ApplicationCommandOptionType, MessageFlags } from 'discord.js';

export default {
  description: 'Renames party channel',
  type: 'both',
  guildOnly: true,
  minArgs: 1,
  expectedArgs: '<name>',
  cooldowns: {
    duration: '2 m',
    type: 'user',
    errorMessage: 'You are renaming too fast! Please wait before renaming again.',
  },
  options: [
    {
      name: 'name',
      description: 'Name of the channel',
      required: true,
      type: ApplicationCommandOptionType.String,
    },
  ],
  callback: async ({ args, member, guild }) => {
    if (!args.length) {
      return { content: 'Please provide a new channel name', flags: MessageFlags.Ephemeral };
    }

    if (!member?.voice.channel) {
      return {
        content: 'You need to be in a voice channel to rename a channel',
        flags: MessageFlags.Ephemeral,
      };
    }

    const channel = member.voice.channel;

    const isCustomChannel = await database.isCustomVoiceChannel(guild!.id, channel.id);

    if (!isCustomChannel) {
      return {
        content: 'You can only rename party channels',
        flags: MessageFlags.Ephemeral,
      };
    }

    await channel.setName(args[0]).catch(() => console.warn('Failed to update channel name'));

    return {
      content: `Channel name updated!`,
      flags: MessageFlags.Ephemeral,
    };
  },
} as DzajCommand;
