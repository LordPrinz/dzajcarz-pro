import { CommandType, type CommandObject } from "wokcommands";
import { PermissionFlagsBits } from "discord.js";

export default {
	description: "Disables bot replies to 'co'",
	type: CommandType.BOTH,
	permissions: [PermissionFlagsBits.Administrator],
	guildOnly: true,

	callback: async ({ guild }) => {
		const guildId = guild.id;
	},
} as CommandObject;
