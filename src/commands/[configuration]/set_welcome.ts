import type { DzajCommand } from '@/core/commander';
import { database } from '@/lib/db';
import { ApplicationCommandOptionType, ChannelType, PermissionFlagsBits } from 'discord.js';

export default {
  description: 'Sets the welcome channel for the server.',
  type: 'both',
  permissions: [PermissionFlagsBits.ManageChannels],
  minArgs: 2,
  expectedArgs: '<channel> <message>',
  guildOnly: true,
  options: [
    {
      name: 'channel',
      description: 'The channel to send the welcome message in',
      required: true,
      type: ApplicationCommandOptionType.Channel,
    },
    {
      name: 'message',
      description: 'The message to send. Use @user to mention the user',

      required: true,
      type: ApplicationCommandOptionType.String,
    },
  ],

  callback: async ({ guild, args }) => {
    const channel = args[0];
    const welcomeMessage = args[1];

    const welcomeChannel = await guild?.channels.fetch(channel);

    if (!welcomeChannel || welcomeChannel.type !== ChannelType.GuildText) {
      return {
        content: 'Invalid channel provided',
      };
    }

    database.saveWelcomeChannel(guild!.id, channel, welcomeMessage);

    return {
      content: 'Welcome channel set!',
    };
  },
} as DzajCommand;
