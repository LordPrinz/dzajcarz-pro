import { database } from '@/lib/db';
import { ChannelType, type Channel } from 'discord.js';

export default async (channel: Channel) => {
  if (channel.type !== ChannelType.GuildVoice) {
    return;
  }

  if (!(await database.isSplitChannel(channel.guild.id, channel.id))) {
    return;
  }

  await database.deleteSplitChannelFromCache(channel.guild.id, channel.id);
};
