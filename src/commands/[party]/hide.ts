import { getElements } from "@/helpers/redis/set";
import { type CommandObject, CommandType } from "wokcommands";

export default {
	description: "Hides party channel",
	type: CommandType.BOTH,
	guildOnly: true,
	callback: async ({ guild, member }) => {
		if (!member?.voice.channel) {
			return {
				content: "You need to be in a voice channel to hide a channel",
				ephemeral: true,
			};
		}

		const channel = member.voice.channel;

		const customChannels = await getElements<string>("customChannels");

		if (!customChannels.includes(channel.id)) {
			return {
				content: "You can only hide party channels",
				ephemeral: true,
			};
		}

		const roleID = guild.roles.everyone.id;

		channel.permissionOverwrites.edit(roleID, {
			Connect: false,
			ViewChannel: false,
		});

		return {
			content: `Channel hidden`,
			ephemeral: true,
		};
	},
} as CommandObject;
