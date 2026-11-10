import { client } from "@/app";
import { botOwners, testServers } from "@/conf/bot";
import { type DzajCommand } from "@/types";
import {
	ChannelType,
	type GuildMember,
	type Channel,
	type Client,
	type VoiceChannel,
} from "discord.js";

import fs from "fs";
import path from "path";
import { type CommandObject } from "wokcommands";

export const getAllVoiceChannels = async (
	client: Client,
	filter?: (channel: Channel) => boolean
) => {
	const voiceChannels: VoiceChannel[] = [];

	for (const channel of client.channels.cache) {
		const ch = channel[1];

		if (ch.type === ChannelType.GuildVoice && filter(ch)) {
			voiceChannels.push(ch);
		}
	}

	return Promise.all(voiceChannels);
};

export const pingUser = (id: string) => `<@${id}>`;

export const replaceTagToUser = (message: string, user: string) => {
	return message.replace(/@/g, user);
};

const commandsDir = path.join(__dirname, "..", "commands");

export const getCommands = () => {
	const commandMap = new Map<string, DzajCommand[]>();

	const processDirectory = (dirPath: string, parentKey: string) => {
		const items = fs.readdirSync(dirPath);

		for (const item of items) {
			const itemPath = path.join(dirPath, item);
			const stats = fs.statSync(itemPath);

			if (stats.isDirectory()) {
				// If directory name is in brackets, use it as a new key
				const match = item.match(/^\[([^\]]+)\]$/);
				const newKey = match ? match[1].trim() : parentKey;
				processDirectory(itemPath, newKey);
			} else if (stats.isFile() && item.endsWith(".ts")) {
				const commandData = require(itemPath).default as CommandObject;

				if (!commandMap.has(parentKey)) {
					commandMap.set(parentKey, []);
				}
				const commandName = item.replace(".ts", "");
				commandMap.get(parentKey)?.push({ name: commandName, ...commandData });
			}
		}
	};
	processDirectory(commandsDir, "");

	return commandMap;
};

export const validateCommandPermissions = (
	command: CommandObject,
	user: GuildMember
) => {
	if (command.ownerOnly && !botOwners.includes(user.id)) {
		return false;
	}

	if (command.testOnly && !testServers.includes(user.guild.id)) {
		return false;
	}

	if (!command.permissions) return true;

	for (const permission of command.permissions) {
		if (!user.permissions.has(permission)) {
			return false;
		}
	}

	return true;
};

export const filterCommandsByPermission = (
	commands: Map<string, DzajCommand[]>,
	member: GuildMember
) => {
	const filteredCommands = new Map<string, DzajCommand[]>();

	for (const [category, commandArray] of commands) {
		const filteredArray = commandArray.filter((command) =>
			validateCommandPermissions(command, member)
		);

		if (filteredArray.length > 0) {
			filteredCommands.set(category, filteredArray);
		}
	}

	return filteredCommands;
};

export const deleteChannel = async (id: string) => {
	const channel = await client.channels.fetch(id);

	if (channel) {
		await channel.delete();
	}
};
