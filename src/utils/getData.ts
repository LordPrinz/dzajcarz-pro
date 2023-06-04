import { Guild, VoiceChannel } from "discord.js";
import WOKCommands from "wokcommands";
import fs from "fs";

import Command from "../types/TCommand";

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
	return guild.channels.cache.filter(
		(channel) =>
			channel.type !== "GUILD_CATEGORY" &&
			channel.type !== "GUILD_STAGE_VOICE" &&
			channel.type !== "GUILD_VOICE" &&
			channel.type !== "GUILD_STORE"
	);
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

const getFiles = (dir: fs.PathLike, suffix: string): string[] => {
	const files = fs.readdirSync(dir, {
		withFileTypes: true,
	});

	let commandFiles: string[] = [];

	files.map((file) => {
		if (file.isDirectory()) {
			commandFiles = [
				...commandFiles,
				...getFiles(`${dir}/${file.name}`, suffix),
			];
		} else if (file.name.endsWith(suffix)) {
			commandFiles.push(`${dir}/${file.name}`);
		}
	});

	return commandFiles;
};

export default getFiles;
