import type { DzajCommand } from '@/core/commander';
import { database } from '@/lib/db';
import { ApplicationCommandOptionType, MessageFlags, type GuildMember } from 'discord.js';

export default {
  description: 'Blocks user from your party channel',
  type: 'both',
  guildOnly: true,
  minArgs: 1,
  expectedArgs: '<user>',
  options: [
    {
      name: 'user',
      description: 'User to block',
      required: true,
      type: ApplicationCommandOptionType.Mentionable,
    },
  ],
  callback: async ({ args, guild, member }) => {
    if (!args.length) {
      return { content: 'Please mention a user to block', flags: MessageFlags.Ephemeral };
    }

    if (!member?.voice.channel) {
      return {
        content: 'You need to be in a voice channel to block a user',
        flags: MessageFlags.Ephemeral,
      };
    }

    const channel = member.voice.channel;

    const isCustomChannel = await database.isCustomVoiceChannel(guild!.id, channel.id);

    if (!isCustomChannel) {
      return {
        content: 'You can only use this command within party channels',
        flags: MessageFlags.Ephemeral,
      };
    }

    const user = (await guild!.members.fetch({
      user: args[0],
    })) as GuildMember;

    channel.permissionOverwrites.edit(user, {
      Connect: false,
      ViewChannel: false,
    });

    return {
      content: `Blocked ${user} from your party channel`,
      flags: MessageFlags.Ephemeral,
    };
  },
} as DzajCommand;
