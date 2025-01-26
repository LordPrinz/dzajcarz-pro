import { database } from '@/lib/db';
import { ChannelType, type GuildMember } from 'discord.js';

export default async (member: GuildMember) => {
  const { guild } = member;

  const data = await database.getWelcomeChannel(guild.id);

  if (!data) return;

  const { channelId, message } = data as { channelId: string; message: string };

  const channel = await guild.channels.fetch(channelId);

  if (!channel) return;

  if (channel.type !== ChannelType.GuildText) return;

  await channel.send(message.replaceAll('@', `<@${member.id}>`));
};
