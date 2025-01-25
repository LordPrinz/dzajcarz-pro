import { database } from '@/lib/db';
import { sleep } from 'bun';
import type { VoiceBasedChannel, VoiceState } from 'discord.js';

const handleChannelDelete = async ({ oldChannel, guildId, voiceChannelId }: { oldChannel: VoiceBasedChannel; guildId: string; voiceChannelId: string }) => {
  await database.deleteCustomVoiceChannel(guildId, voiceChannelId);
  return oldChannel.delete();
};

export default async (oldState: VoiceState, newState: VoiceState) => {
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;

  //* Detects if the user left the channel

  if (
    (oldChannel === null || newChannel !== null || oldChannel?.id === (newChannel! as VoiceBasedChannel)?.id) &&
    (oldChannel === null || newChannel === null || oldChannel?.id === newChannel?.id)
  ) {
    return;
  }

  const targetChannelId = oldChannel.id;
  const members = oldChannel.members.filter((member) => !member.user.bot);

  if (members.size > 0) {
    return;
  }

  const guildId = oldChannel.guild.id;

  const isCustomVoiceChannel = await database.isCustomVoiceChannel(guildId, targetChannelId);

  if (!isCustomVoiceChannel) {
    return;
  }

  if (oldChannel.members.size === 0) {
    return handleChannelDelete({ guildId: guildId, oldChannel: oldChannel, voiceChannelId: targetChannelId });
  }

  //* Delete after 1 minute if the channel has only bots

  await sleep(1000 * 60);

  const bots = oldChannel.members.filter((member) => member.user.bot);

  if (oldChannel.members.size === bots.size) {
    await handleChannelDelete({ oldChannel, guildId, voiceChannelId: targetChannelId });
  }
};
