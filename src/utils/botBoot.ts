import { Client } from "discord.js";
import serverModel from "../bot/models/serverModel";
import {
	checkServerExistance,
	checkUserExistence,
} from "./commands/dmChatListener";
import User from "../bot/models/userModel";

export const saveServer = async (client: Client) => {
	for (const [guildId, guild] of client.guilds.cache) {
		console.log(`Guild: ${guild.name} (${guild.id})`);

		const members = await guild.members.fetch();

		const users = [];

		for (const [memberId, member] of members) {
			users.push(memberId);

			const doesUserExist = await checkUserExistence(memberId);

			if (doesUserExist) {
				continue;
			}

			const us = {
				_id: memberId,
				avatar: member.displayAvatarURL(),
				tag: member.user.tag,
				userName: member.user.username,
				isBot: member.user.bot,
			};

			await User.insertMany([us]);
		}

		const doesServerExist = await checkServerExistance(guildId);

		if (doesServerExist) {
			continue;
		}

		const s = {
			_id: guildId,
			users,
			name: guild.name,
		};

		await serverModel.insertMany([s]);
	}
};
