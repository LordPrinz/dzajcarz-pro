import type { DzajCommand } from '@/core/commander';
import { database } from '@/lib/db';
import { PermissionFlagsBits } from 'discord.js';

export default {
  description: 'Unsets the welcome channel for the server.',
  type: 'both',
  permissions: [PermissionFlagsBits.Administrator],
  guildOnly: true,

  callback: async ({ guild }) => {
    const guildId = guild!.id;

    await database.deleteWelcomeChannel(guildId);

    return {
      content: 'Welcome channel has been unset!',
    };
  },
} as DzajCommand;
