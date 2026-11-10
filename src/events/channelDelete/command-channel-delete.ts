import { database } from '@/lib/db';
import { ChannelType, type Channel } from 'discord.js';

export default async (channel: Channel) => {
  if (channel.type !== ChannelType.GuildText) {
    return;
  }

  if (!(await database.isCommandChannel(channel.guild.id, channel.id))) {
    return;
  }

  await database.deleteCommandChannel(channel.guild.id, channel.id);
};
