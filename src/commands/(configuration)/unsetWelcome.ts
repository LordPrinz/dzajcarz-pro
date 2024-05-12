import { CommandType, type CommandObject } from "wokcommands";
import { PermissionFlagsBits } from "discord.js";
import { deleteWelcomeChannel } from "@/db/welcomeChannel";

export default {
	description: "Unsets the welcome channel for the server.",
	type: CommandType.BOTH,

	permissions: [PermissionFlagsBits.Administrator],
	testOnly: true,
	guildOnly: true,

	callback: async ({ guild }) => {
		const guildId = guild.id;

		const res = await deleteWelcomeChannel(guildId);

		if (!res) {
			return {
				content: "Failed to unset welcome channel",
			};
		}

		return {
			content: "Welcome channel has been unset!",
		};
	},
} as CommandObject;
