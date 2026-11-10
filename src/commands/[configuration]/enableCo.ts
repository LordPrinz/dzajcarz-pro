import { CommandType, type CommandObject } from "wokcommands";
import { PermissionFlagsBits } from "discord.js";
import { checkElementExists, deleteElement } from "@/helpers/redis/list";
import { enableCoFeature } from "@/db/coFeature";

export default {
	description: "Enables bot replies to 'co'",
	type: CommandType.BOTH,
	permissions: [PermissionFlagsBits.Administrator],
	guildOnly: true,

	callback: async ({ guild }) => {
		const guildId = guild.id;

		const isCoDisabled = await checkElementExists("coDisabledFeature", guildId);

		if (!isCoDisabled) {
			return "Bot replies to 'co' are already enabled";
		}

		await deleteElement("coDisabledFeature", guildId);
		await enableCoFeature(guildId);

		return "Bot replies to 'co' are now enabled";
	},
} as CommandObject;
