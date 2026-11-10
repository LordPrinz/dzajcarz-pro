import { database } from '@/lib/db';
import type { TextChannel} from 'discord.js';
import { type GuildMember } from 'discord.js';

export default async (member: GuildMember) => {
  const { guild } = member;

  const data = await database.getWelcomeChannel(guild.id);

  if (!data) return;

  const channel = await guild.channels.fetch(data.channelid || data.channelId);

  if (!channel) return;

  await (channel as TextChannel).send(data.message.replaceAll('@', `<@${member.id}>`)).catch(() => console.warn('Failed to send welcome message'));
};
