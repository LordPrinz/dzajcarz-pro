import { getElements } from "@/helpers/redis/list";
import { type CommandObject, CommandType } from "wokcommands";

export default {
	description: "Locks party channel",
	type: CommandType.BOTH,
	guildOnly: true,
	callback: async ({ guild, member }) => {
		if (!member?.voice.channel) {
			return {
				content: "You need to be in a voice channel to lock a channel",
				ephemeral: true,
			};
		}

		const channel = member.voice.channel;

		const customChannels = await getElements("customChannels");

		if (!customChannels.includes(channel.id)) {
			return {
				content: "You can only lock party channels",
				ephemeral: true,
			};
		}

		const roleID = guild.roles.everyone.id;

		channel.permissionOverwrites.edit(roleID, {
			Connect: false,
		});

		return {
			content: `Channel locked`,
			ephemeral: true,
		};
	},
} as CommandObject;
