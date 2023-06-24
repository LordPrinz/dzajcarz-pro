import { Client, Guild, GuildMember } from "discord.js";
import serverModel from "../bot/models/serverModel";
import {
	checkServerExistance,
	checkUserExistence,
} from "./commands/dmChatListener";
import User from "../bot/models/userModel";

export const saveServers = async (client: Client) => {
	for (const [guildId, guild] of client.guilds.cache) {
		saveServerData(guild);
	}
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

	const s = {
		_id: guild.id,
		users,
		name: guild.name,
	};

	await serverModel.insertMany([s]);
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
};
