import type { DzajCommand } from '@/core/commander';
import { database } from '@/lib/db';
import { MessageFlags } from 'discord.js';

export default {
  description: 'Unlocks party channel',
  type: 'both',
  guildOnly: true,
  callback: async ({ guild, member }) => {
    if (!member?.voice.channel) {
      return {
        content: 'You need to be in a voice channel to unlock a channel',
        flags: MessageFlags.Ephemeral,
      };
    }

    const channel = member.voice.channel;

    const isCustomChannel = await database.isCustomVoiceChannel(guild!.id, channel.id);

    if (!isCustomChannel) {
      return {
        content: 'You can only unlock party channels',
        flags: MessageFlags.Ephemeral,
      };
    }

    const roleID = guild!.roles.everyone.id;

    channel.permissionOverwrites.edit(roleID, {
      Connect: true,
    });

    return {
      content: `Channel unlocked`,
      flags: MessageFlags.Ephemeral,
    };
  },
} as DzajCommand;
