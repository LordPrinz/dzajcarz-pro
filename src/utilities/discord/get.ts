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
