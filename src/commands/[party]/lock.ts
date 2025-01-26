import type { DzajCommand } from '@/core/commander';
import { database } from '@/lib/db';
import { MessageFlags } from 'discord.js';

export default {
  description: 'Locks party channel',
  type: 'both',
  guildOnly: true,
  callback: async ({ guild, member }) => {
    if (!member?.voice.channel) {
      return {
        content: 'You need to be in a voice channel to lock a channel',
        flags: MessageFlags.Ephemeral,
      };
    }

    const channel = member.voice.channel;

    const isCustomChannel = await database.isCustomVoiceChannel(guild!.id, channel.id);

    if (!isCustomChannel) {
      return {
        content: 'You can only lock party channels',
        flags: MessageFlags.Ephemeral,
      };
    }

    const roleID = guild!.roles.everyone.id;

    channel.permissionOverwrites
      .edit(roleID, {
        Connect: false,
      })
      .catch(() => console.warn('Failed to lock channel'));

    return {
      content: `Channel locked`,
      flags: MessageFlags.Ephemeral,
    };
  },
} as DzajCommand;
