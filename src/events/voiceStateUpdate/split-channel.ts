import { database } from '@/lib/db';
import { type VoiceChannel, type VoiceState } from 'discord.js';

export default async (oldState: VoiceState, newState: VoiceState) => {
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;

  //* Detects if the user joined the channel

  if ((oldChannel !== null || newChannel === null) && (oldChannel === null || newChannel === null || oldChannel?.id === newChannel?.id)) {
    return;
  }

  const targetChannelId = newChannel.id;

  const guildId = newChannel.guild.id;

  const serverSplitChannels = await database.isSplitChannel(guildId, targetChannelId);

  if (!serverSplitChannels) {
    return;
  }

  const partyArea = await database.getPartyArea(guildId, targetChannelId);

  if (!partyArea) {
    return;
  }

  const user = newState.member!;

  const userName = user.nickname || user.user.username;

  const newChannelName = partyArea.generationTemplate.replace('@', userName);

  const customChannel = (await newChannel.clone({
    name: newChannelName,
  })) as VoiceChannel;

  await user.voice.setChannel(customChannel);

  await database.addCustomVoiceChannel(guildId, customChannel.id);

  //TODO: sendCommandsToChannel(customChannel);
};
