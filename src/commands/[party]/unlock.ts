import { getElements } from "@/helpers/redis/set";
import { type CommandObject, CommandType } from "wokcommands";

export default {
	description: "Unlocks party channel",
	type: CommandType.BOTH,
	guildOnly: true,
	callback: async ({ guild, member }) => {
		if (!member?.voice.channel) {
			return {
				content: "You need to be in a voice channel to unlock a channel",
				ephemeral: true,
			};
		}

		const channel = member.voice.channel;

		const customChannels = await getElements<string>("customChannels");

		if (!customChannels.includes(channel.id)) {
			return {
				content: "You can only unlock party channels",
				ephemeral: true,
			};
		}

		const roleID = guild.roles.everyone.id;

		channel.permissionOverwrites.edit(roleID, {
			Connect: true,
		});

		return {
			content: `Channel unlocked`,
			ephemeral: true,
		};
	},
} as CommandObject;
