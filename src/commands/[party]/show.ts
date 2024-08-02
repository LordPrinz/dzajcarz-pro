import { getElements } from "@/helpers/redis/set";
import { type CommandObject, CommandType } from "wokcommands";

export default {
	description: "Shows party channel",
	type: CommandType.BOTH,
	guildOnly: true,
	callback: async ({ guild, member }) => {
		if (!member?.voice.channel) {
			return {
				content: "You need to be in a voice channel to show a channel",
				ephemeral: true,
			};
		}

		const channel = member.voice.channel;

		const customChannels = await getElements<string>("customChannels");

		if (!customChannels.includes(channel.id)) {
			return {
				content: "You can only show party channels",
				ephemeral: true,
			};
		}

		const roleID = guild.roles.everyone.id;

		channel.permissionOverwrites.edit(roleID, {
			ViewChannel: true,
		});

		return {
			content: `Channel shown`,
			ephemeral: true,
		};
	},
} as CommandObject;
