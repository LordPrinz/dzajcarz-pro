import { Guild, VoiceChannel } from "discord.js";
import WOKCommands from "wokcommands";
import Command from "../../types/Command";

export const getGuildVCs = (guild: Guild): VoiceChannel[] => {
	const channels = guild.channels;
	const voiceChannels: VoiceChannel[] = [];
	channels.cache.map((channel) => {
		if (channel.type === "GUILD_VOICE") {
			voiceChannels.push(channel);
		}
	});

	return voiceChannels;
};

export const getGuildTextChannels = (guild: Guild) => {
	return guild.channels.cache.filter((channel) => channel.type === "GUILD_TEXT");
};

export const getCommands = (instance: WOKCommands): Command[] => {
	return instance.commandHandler.commands;
};

export const getMostPopulatedVC = (voiceChannels: VoiceChannel[]) => {
	const channelsList: { size: number; channel: VoiceChannel }[] = [];
	voiceChannels.map((voiceChannel) => {
		channelsList.push({
			size: voiceChannel.members.size,
			channel: voiceChannel,
		});
	});
	channelsList.sort((a, b) => a.size - b.size).reverse();

	return channelsList[0]?.channel;
};
