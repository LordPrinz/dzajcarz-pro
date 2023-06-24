import { Client, Guild, GuildMember } from "discord.js";
import serverModel from "../bot/models/serverModel";
import {
	checkServerExistance,
	checkUserExistence,
} from "./commands/dmChatListener";
import User from "../bot/models/userModel";
import Logger from "./debug/Logger";

const logger = new Logger("dzajcarz");

export const saveServers = async (client: Client) => {
	for (const [guildId, guild] of client.guilds.cache) {
		saveServerData(guild);
	}
	logger.saveLog("Servers have been saved to database", "info");
};

export const saveServerData = async (guild: Guild) => {
	const members = await guild.members.fetch();

	const users = [];

	for (const [memberId, member] of members) {
		users.push(memberId);
		saveMember(member);
	}

	const doesServerExist = await checkServerExistance(guild.id);

	if (doesServerExist) {
		return;
	}

	const server = {
		_id: guild.id,
		users,
		image: guild.iconURL({ format: "png" }),
		name: guild.name,
	};

	await serverModel.insertMany([server]);

	logger.saveLog(`Server ${guild.name} has been saved to database`, "info");
};

export const saveMember = async (member: GuildMember) => {
	const doesUserExist = await checkUserExistence(member.id);

	if (doesUserExist) {
		return;
	}

	const us = {
		_id: member.id,
		avatar: member.displayAvatarURL(),
		tag: member.user.tag,
		userName: member.user.username,
		isBot: member.user.bot,
	};

	await User.insertMany([us]);

	logger.saveLog(`User ${member.user.tag} has been saved to database`, "info");
};
