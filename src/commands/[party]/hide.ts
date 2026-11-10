import type { DzajCommand } from '@/core/commander';
import { database } from '@/lib/db';
import { MessageFlags } from 'discord.js';

export default {
  description: 'Hides party channel',
  type: 'both',
  guildOnly: true,
  callback: async ({ guild, member }) => {
    if (!member?.voice.channel) {
      return {
        content: 'You need to be in a voice channel to hide a channel',
        flags: MessageFlags.Ephemeral,
      };
    }

    const channel = member.voice.channel;

    const isCustomChannel = await database.isCustomVoiceChannel(guild!.id, channel.id);

    if (!isCustomChannel) {
      return {
        content: 'You can only hide party channels',
        flags: MessageFlags.Ephemeral,
      };
    }

    const roleID = guild!.roles.everyone.id;

    channel.permissionOverwrites.edit(roleID, {
      ViewChannel: false,
    });

    return {
      content: `Channel hidden`,
      flags: MessageFlags.Ephemeral,
    };
  },
} as DzajCommand;
