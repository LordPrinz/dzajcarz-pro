import { database } from '@/lib/db';
import { ChannelType, type Channel } from 'discord.js';

export default async (channel: Channel) => {
  if (channel.type !== ChannelType.GuildCategory) {
    return;
  }

  const isPartyChannel = await database.isPartyChannel(channel.guild.id, channel.id);

  if (!isPartyChannel) {
    return;
  }

  const partyArea = await database.getPartyArea(channel.guild.id, channel.id);

  if (!partyArea) {
    return;
  }

  await database.deletePartyArea(channel.guild.id, channel.id, partyArea.splitChannelId);
};
